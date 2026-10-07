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

const CHART_COLORS = {
  light: ["#2563eb", "#d97706", "#9333ea", "#e11d48", "#0891b2"],
  dark: ["#60a5fa", "#fbbf24", "#c084fc", "#fb7185", "#22d3ee"],
} as const;

export function mapRenderTheme(theme: Theme): RenderTheme {
  const colors = theme.colors;
  const charts = CHART_COLORS[theme.colorScheme];
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
      "--chart-2": charts[0],
      "--chart-3": charts[1],
      "--chart-4": charts[2],
      "--chart-5": charts[3],
      "--chart-6": charts[4],
      "--radius": "10px",
      "--font-sans": theme.fontFamily.ui,
      "--font-mono": theme.fontFamily.mono,
      "--font-size-base": `${theme.fontSize.base}px`,
    },
  };
}

export function clampRenderHeight(height: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)));
}

export function renderFrameHeight(
  providedHeight: number,
  contentHeight: number | null,
  frameWidth: number,
): number {
  const width = Number.isFinite(frameWidth) && frameWidth > 0 ? frameWidth : 728;
  const cap = Math.min(MAX_HEIGHT, Math.round(providedHeight * (width < 728 ? 728 / width : 1)));
  return clampRenderHeight(Math.min(cap, contentHeight ?? cap));
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

export interface PrepareRenderDocumentInput {
  html: string;
  theme: RenderTheme;
  nonce: string;
  renderId: string;
  linkMode: "web" | "native";
}

export function prepareRenderDocument(input: PrepareRenderDocumentInput): string {
  const { html, theme, nonce, renderId, linkMode } = input;
  const payload = JSON.stringify({ nonce, renderId }).replace(/</g, "\\u003c");
  const linkAction =
    linkMode === "native"
      ? 'a.setAttribute("target","_blank");a.setAttribute("rel","noopener");'
      : 'e.preventDefault();send("ui/open-link",{url:u.href},"paseo-link-"+(++n));';
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
        ${linkAction}
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
  return `<!doctype html><head><meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">${markup}</head>${html.replace(/^\uFEFF/, "")}`;
}
