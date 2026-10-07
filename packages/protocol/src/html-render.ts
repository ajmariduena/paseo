export const MIN_RENDER_HEIGHT = 80;
export const MAX_RENDER_HEIGHT = 2000;
export const RENDER_WIDTHS = [320, 375, 430, 520, 640, 728, 860, 1000, 1144] as const;
export type RenderHeights = readonly (readonly [number, number])[];

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

export function validRenderHeights(value: unknown): value is RenderHeights {
  return (
    Array.isArray(value) &&
    value.length === RENDER_WIDTHS.length &&
    value.every(
      (entry, index) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry[0] === RENDER_WIDTHS[index] &&
        Number.isInteger(entry[1]) &&
        entry[1] > 0 &&
        entry[1] <= 100_000,
    )
  );
}

export function clampRenderHeight(height: number): number {
  return Math.min(MAX_RENDER_HEIGHT, Math.max(MIN_RENDER_HEIGHT, Math.ceil(height)));
}

export function renderFrameHeight(
  providedHeight: number,
  contentHeight: number | null,
  frameWidth: number,
  heights?: RenderHeights,
): number {
  const width = Number.isFinite(frameWidth) && frameWidth > 0 ? frameWidth : 728;
  if (!heights) {
    const cap = Math.min(
      MAX_RENDER_HEIGHT,
      Math.round(providedHeight * (width < 728 ? 728 / width : 1)),
    );
    return clampRenderHeight(Math.min(cap, contentHeight ?? cap));
  }
  const measuredAt = (at: number): number => {
    let lower = heights[0]!;
    for (const entry of heights) if (entry[0] <= at) lower = entry;
    const upper = heights.find(([sample]) => sample >= at) ?? heights[heights.length - 1]!;
    return Math.max(lower[1], upper[1]);
  };
  const cap = measuredAt(728) > providedHeight ? providedHeight : MAX_RENDER_HEIGHT;
  return clampRenderHeight(Math.min(cap, contentHeight ?? measuredAt(width)));
}

export const RENDER_BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;scrollbar-width:none}html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

export function renderThemeCss(theme: RenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value.replace(/[;{}<>]/g, "")}`)
    .join(";");
  return `:root{color-scheme:${theme.appearance};${declarations}}${RENDER_BASE_CSS}`;
}

export interface RenderBridgeMessage {
  jsonrpc: "2.0";
  nonce: string;
  renderId: string;
  id?: string | number;
  method: "ui/notifications/size-changed" | "ui/notifications/hover-changed" | "ui/open-link";
  params: { height: number } | { hovered: boolean } | { url: string };
}

function validRenderBridgeParams(
  message: Record<string, unknown>,
  fields: Record<string, unknown>,
): boolean {
  if (message.method === "ui/notifications/size-changed") {
    return typeof fields.height === "number" && Number.isFinite(fields.height) && fields.height > 0;
  }
  if (message.method === "ui/notifications/hover-changed") {
    return typeof fields.hovered === "boolean";
  }
  if (message.method === "ui/open-link") {
    return (
      (typeof message.id === "string" || typeof message.id === "number") &&
      (typeof message.id !== "string" || message.id.length <= 128) &&
      typeof fields.url === "string" &&
      /^https?:\/\//i.test(fields.url) &&
      fields.url.length <= 2048
    );
  }
  return false;
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
  return validRenderBridgeParams(message, fields)
    ? (message as unknown as RenderBridgeMessage)
    : null;
}

export function renderThemeMessage(theme: RenderTheme) {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  };
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
  const payload = JSON.stringify({ nonce, renderId, web: linkMode === "web" }).replace(
    /</g,
    "\\u003c",
  );
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
      s.textContent=c+"}"+${JSON.stringify(RENDER_BASE_CSS)};
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
    if(p.web){var hovering=false;function hover(value){if(hovering===value)return;hovering=value;send("ui/notifications/hover-changed",{hovered:value});}window.addEventListener("mouseenter",function(){hover(true);});document.addEventListener("pointermove",function(){hover(true);},{passive:true});window.addEventListener("mouseleave",function(){hover(false);});}
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
  const markup = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style id="paseo-render-theme">${renderThemeCss(theme)}</style><script>${script}</script>`;
  return `<!doctype html><head><meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">${markup}</head>${html.replace(/^\uFEFF/, "")}`;
}
