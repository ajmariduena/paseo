import type { Theme } from "@/styles/theme";

export const MIN_HEIGHT = 80;
export const MAX_HEIGHT = 2000;
export const RENDER_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export interface RenderTheme {
  appearance: "light" | "dark";
  variables: Record<string, string>;
}

export function mapRenderTheme(theme: Theme): RenderTheme {
  const colors = theme.colors;
  return {
    appearance: theme.colorScheme,
    variables: {
      "--background": colors.background,
      "--foreground": colors.foreground,
      "--muted": colors.muted,
      "--muted-foreground": colors.mutedForeground,
      "--card": colors.surface1,
      "--card-foreground": colors.foreground,
      "--popover": colors.popover,
      "--popover-foreground": colors.popoverForeground,
      "--secondary": colors.secondary,
      "--secondary-foreground": colors.secondaryForeground,
      "--border": colors.border,
      "--input": colors.input,
      "--ring": colors.ring,
      "--primary": colors.primary,
      "--primary-foreground": colors.primaryForeground,
      "--accent": colors.accent,
      "--accent-foreground": colors.accentForeground,
      "--accent-surface": colors.surface2,
      "--accent-surface-foreground": colors.foreground,
      "--destructive": colors.destructive,
      "--destructive-foreground": colors.destructiveForeground,
      "--destructive-surface": colors.surface2,
      "--warning": colors.statusWarning,
      "--warning-foreground": colors.foreground,
      "--warning-surface": colors.surface2,
      "--success": colors.success,
      "--success-foreground": colors.successForeground,
      "--info": colors.palette.blue[500],
      "--info-foreground": colors.foreground,
      "--code-background": colors.surface1,
      "--code-foreground": colors.foreground,
      "--chart-1": colors.accent,
      "--chart-2": colors.palette.blue[500],
      "--chart-3": colors.success,
      "--chart-4": colors.statusWarning,
      "--chart-5": colors.destructive,
      "--chart-6": colors.accentBright,
      "--radius": "10px",
      "--font-sans": theme.fontFamily.ui,
      "--font-mono": theme.fontFamily.mono,
    },
  };
}

export function clampRenderHeight(height: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)));
}

export interface RenderBridgeMessage {
  jsonrpc: "2.0";
  nonce: string;
  renderId: string;
  id?: string | number;
  method: "ui/notifications/size-changed" | "ui/open-link";
  params: { height: number } | { url: string };
}

export function readRenderBridgeMessage(
  value: unknown,
  nonce: string,
  renderId: string,
): RenderBridgeMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0" || message.nonce !== nonce || message.renderId !== renderId)
    return null;
  const params = message.params;
  if (typeof params !== "object" || params === null) return null;
  const fields = params as Record<string, unknown>;
  if (
    message.method === "ui/notifications/size-changed" &&
    typeof fields.height === "number" &&
    Number.isFinite(fields.height) &&
    fields.height > 0
  ) {
    return message as unknown as RenderBridgeMessage;
  }
  if (
    message.method === "ui/open-link" &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    (typeof message.id !== "string" || message.id.length <= 128) &&
    typeof fields.url === "string" &&
    /^https?:\/\//i.test(fields.url) &&
    fields.url.length <= 2048
  ) {
    return message as unknown as RenderBridgeMessage;
  }
  return null;
}

export function renderThemeMessage(theme: RenderTheme) {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  };
}

const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;scrollbar-width:none}html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

function themeCss(theme: RenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value.replace(/[;{}<>]/g, "")}`)
    .join(";");
  return `:root{color-scheme:${theme.appearance};${declarations}}${BASE_CSS}`;
}

function blankNonMarkup(html: string): string {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
}

export function prepareRenderDocument(
  html: string,
  theme: RenderTheme,
  nonce: string,
  renderId: string,
): string {
  const scan = blankNonMarkup(html);
  const payload = JSON.stringify({ nonce, renderId }).replace(/</g, "\\u003c");
  const script = `(function(){
    var p=${payload},s=document.getElementById("paseo-render-theme"),n=0;
    function apply(t){
      if(!t||!t.styles||!t.styles.variables)return;
      var v=t.styles.variables,c=":root{color-scheme:"+(t.theme==="light"?"light":"dark")+";";
      for(var k in v)if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(v[k]).replace(/[;{}<>]/g,"")+";";
      s.textContent=c+"}"+${JSON.stringify(BASE_CSS)};
    }
    window.addEventListener("message",function(e){
      if(e.source!==parent&&!(window.ReactNativeWebView&&e.source===null))return;
      var d=e.data;
      if(d&&d.jsonrpc==="2.0"&&d.method==="ui/notifications/host-context-changed")apply(d.params);
    });
    function send(method,params,id){
      var m={jsonrpc:"2.0",nonce:p.nonce,renderId:p.renderId,method:method,params:params};
      if(id)m.id=id;
      if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(m));
      else parent.postMessage(m,"*");
    }
    document.addEventListener("click",function(e){
      var a=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null;
      if(!a)return;
      try{
        var u=new URL(a.href);
        if(!/^https?:$/.test(u.protocol))return;
        e.preventDefault();
        send("ui/open-link",{url:u.href},"paseo-link-"+(++n));
      }catch(x){}
    },true);
    var h=0;
    function size(){
      var b=document.body,v=b?Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)):0;
      if(v>0&&v!==h){h=v;send("ui/notifications/size-changed",{height:v});}
    }
    document.addEventListener("DOMContentLoaded",function(){
      if(window.ResizeObserver){var o=new ResizeObserver(size);o.observe(document.documentElement);if(document.body)o.observe(document.body);}
      size();
    });
    window.addEventListener("load",size);
  })();`;
  const markup = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style id="paseo-render-theme">${themeCss(theme)}</style><script>${script}</script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(scan);
  let injected: string;
  if (head) {
    const at = head.index + head[0].length;
    injected = html.slice(0, at) + markup + html.slice(at);
  } else {
    const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
    if (htmlOpen) {
      const at = htmlOpen.index + htmlOpen[0].length;
      injected = `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
    } else {
      injected = `<head>${markup}</head>${html}`;
    }
  }
  // The parser creates a real head for this meta before it can see hostile source markup.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">${injected.replace(/^\uFEFF/, "")}`;
}
