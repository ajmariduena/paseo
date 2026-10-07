import type { RenderTheme } from "./document";
import {
  VISUALIZATION_BASE_CSS,
  visualizationThemeCss,
  visualizationVariables,
} from "./visualize-style";

const CDN_HOSTS = [
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://fonts.bunny.net",
];

export const VISUALIZATION_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: ${CDN_HOSTS.join(" ")}`,
  `style-src 'unsafe-inline' ${CDN_HOSTS.join(" ")}`,
  `img-src blob: data: ${CDN_HOSTS.join(" ")}`,
  `font-src blob: data: ${CDN_HOSTS.join(" ")}`,
  `media-src blob: data: ${CDN_HOSTS.join(" ")}`,
  "worker-src blob:",
  "connect-src blob: data:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export const VISUALIZATION_MIN_HEIGHT = 240;
export const VISUALIZATION_MAX_HEIGHT = 10_000;
export const NATIVE_FOLLOW_UP_PREFIX = "paseo-visualization-follow-up://";

export interface VisualizationFrameOptions {
  canonicalPath: string;
  revision: string;
  state: unknown;
  mode: "inline" | "wide";
  onSetState: (state: unknown) => Promise<unknown>;
  onFollowUp: (prompt: string, title?: string) => Promise<boolean>;
  onError: (message: string) => void;
}

export interface VisualizationBridgeMessage {
  jsonrpc: "2.0";
  nonce: string;
  identity: string;
  id?: string;
  method:
    | "visualization/size"
    | "visualization/set-state"
    | "visualization/follow-up"
    | "visualization/open-external";
  params: Record<string, unknown>;
}

function validBridgeParams(method: unknown, params: Record<string, unknown>): boolean {
  if (method === "visualization/size") {
    return (
      typeof params.height === "number" &&
      Number.isFinite(params.height) &&
      params.height > 0 &&
      params.height <= 100_000
    );
  }
  if (method === "visualization/set-state") {
    if (!("state" in params)) return false;
    try {
      const encoded = JSON.stringify(params.state);
      return typeof encoded === "string" && new TextEncoder().encode(encoded).length <= 16 * 1024;
    } catch {
      return false;
    }
  }
  if (method === "visualization/follow-up") return validFollowUpParams(params);
  if (method === "visualization/open-external") {
    return typeof params.url === "string" && params.url.length <= 2048 && isHttpsUrl(params.url);
  }
  return false;
}

export function readVisualizationBridgeMessage(
  value: unknown,
  nonce: string,
  identity: string,
): VisualizationBridgeMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0" || message.nonce !== nonce || message.identity !== identity)
    return null;
  if (typeof message.params !== "object" || message.params === null) return null;
  const params = message.params as Record<string, unknown>;
  if (message.method !== "visualization/size") {
    if (typeof message.id !== "string" || message.id.length === 0 || message.id.length > 128)
      return null;
  }
  return validBridgeParams(message.method, params)
    ? (message as unknown as VisualizationBridgeMessage)
    : null;
}

export function validFollowUpParams(value: unknown): value is { prompt: string; title?: string } {
  if (typeof value !== "object" || value === null) return false;
  const params = value as Record<string, unknown>;
  return (
    typeof params.prompt === "string" &&
    params.prompt.trim().length > 0 &&
    params.prompt.length <= 4000 &&
    (params.title === undefined || (typeof params.title === "string" && params.title.length <= 250))
  );
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function readNativeFollowUpUrl(
  url: string,
  nonce: string,
  identity: string,
): { id: string; prompt: string; title?: string } | null {
  if (!url.startsWith(NATIVE_FOLLOW_UP_PREFIX) || url.length > 24_000) return null;
  try {
    const value: unknown = JSON.parse(
      decodeURIComponent(url.slice(NATIVE_FOLLOW_UP_PREFIX.length)),
    );
    if (typeof value !== "object" || value === null) return null;
    const fields = value as Record<string, unknown>;
    const id = fields.id;
    if (
      fields.nonce !== nonce ||
      fields.identity !== identity ||
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 128 ||
      !validFollowUpParams(fields)
    ) {
      return null;
    }
    return {
      id,
      prompt: fields.prompt,
      ...(typeof fields.title === "string" ? { title: fields.title } : {}),
    };
  } catch {
    return null;
  }
}

export function visualizationThemeMessage(theme: RenderTheme, nonce: string, identity: string) {
  return {
    jsonrpc: "2.0",
    method: "visualization/theme",
    nonce,
    identity,
    params: { theme: theme.appearance, variables: visualizationVariables(theme) },
  };
}

export function visualizationReply(
  nonce: string,
  identity: string,
  id: string,
  result: unknown,
  error: string | null,
) {
  return { jsonrpc: "2.0", nonce, identity, id, result, error };
}

export function prepareVisualizationDocument(input: {
  fragment: string;
  theme: RenderTheme;
  nonce: string;
  identity: string;
  state: unknown;
  mode: "inline" | "wide" | "fullscreen";
  linkMode: "web" | "native";
}): string {
  const payload = JSON.stringify({
    nonce: input.nonce,
    identity: input.identity,
    state: input.state,
    mode: input.mode,
    theme: input.theme.appearance,
    variables: visualizationVariables(input.theme),
    maxWidth: input.mode === "wide" ? 1024 : 736,
    maxHeight: VISUALIZATION_MAX_HEIGHT,
    native: input.linkMode === "native",
    nativeFollowUpPrefix: NATIVE_FOLLOW_UP_PREFIX,
  }).replace(/</g, "\\u003c");
  const script = `(function(){
    var p=${payload},seq=0,pending={},state=p.state==null?null:p.state,style=document.getElementById("paseo-viz-theme");
    function globals(){return {widgetState:state,theme:p.theme,visualizationTheme:p.theme,visualizationStyleVariables:p.variables,displayMode:p.mode,maxWidth:Math.min(p.maxWidth,innerWidth),maxHeight:p.maxHeight,statePersistence:"daemon",stateModelContext:"none"};}
    function emit(){window.dispatchEvent(new CustomEvent("openai:set_globals",{detail:{globals:globals()}}));}
    function send(method,params,id){var m={jsonrpc:"2.0",nonce:p.nonce,identity:p.identity,method:method,params:params};if(id)m.id=id;if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(m));else parent.postMessage(m,"*");}
    function request(method,params){return new Promise(function(resolve,reject){var id="v"+(++seq);pending[id]={resolve:resolve,reject:reject};send(method,params,id);});}
    function accept(e){if(e.source!==parent&&!(window.ReactNativeWebView&&e.source===null))return;var m=e.data;if(!m||m.jsonrpc!=="2.0"||m.nonce!==p.nonce||m.identity!==p.identity)return;
      if(m.method==="visualization/theme"&&m.params&&m.params.variables){p.theme=m.params.theme;p.variables=m.params.variables;var s=":root{color-scheme:"+(p.theme==="dark"?"dark":"light")+";";for(var k in p.variables)if(/^--[a-z0-9-]+$/.test(k))s+=k+":"+String(p.variables[k]).replace(/[;{}<>]/g,"")+";";style.textContent=s+"}";emit();return;}
      if(m.id&&pending[m.id]){var task=pending[m.id];delete pending[m.id];if(m.error)task.reject(new Error(String(m.error)));else task.resolve(m.result);}
    }
    window.addEventListener("message",accept);
    function normalize(next){if(!next||typeof next!=="object"||Array.isArray(next))throw new Error("Widget state must be an object");return {modelContent:next.modelContent===undefined?null:next.modelContent,privateContent:next.privateContent===undefined?null:next.privateContent};}
    var api={
      setWidgetState:function(next){var old=state;try{state=normalize(typeof next==="function"?next(state):next);if(new TextEncoder().encode(JSON.stringify(state)).length>16384)throw new Error("Widget state exceeds 16 KiB");emit();return request("visualization/set-state",{state:state}).then(function(result){state=result&&result.state?result.state:state;emit();return state;}).catch(function(error){state=old;emit();throw error;});}catch(error){state=old;return Promise.reject(error);}},
      sendFollowUpMessage:function(input){if(!input||typeof input.prompt!=="string"||!input.prompt.trim()||input.prompt.length>4000||typeof input.title!=="undefined"&&(typeof input.title!=="string"||input.title.length>250))return Promise.reject(new Error("Invalid follow-up"));
        if(p.native){return new Promise(function(resolve,reject){var id="v"+(++seq);pending[id]={resolve:resolve,reject:reject};window.open(p.nativeFollowUpPrefix+encodeURIComponent(JSON.stringify({nonce:p.nonce,identity:p.identity,id:id,prompt:input.prompt,title:input.title})),"_blank");setTimeout(function(){if(pending[id]){delete pending[id];reject(new Error("Follow-up was not opened"));}},30000);});}
        return request("visualization/follow-up",{prompt:input.prompt,title:input.title});},
      openExternal:function(url){if(typeof url!=="string"||!/^https:\\/\\//i.test(url))return Promise.reject(new Error("HTTPS URL required"));if(p.native){window.open(url,"_blank","noopener");return Promise.resolve();}return request("visualization/open-external",{url:url});}
    };
    Object.defineProperties(api,{widgetState:{get:function(){return state;}},theme:{get:function(){return p.theme;}},visualizationTheme:{get:function(){return p.theme;}},visualizationStyleVariables:{get:function(){return p.variables;}},displayMode:{get:function(){return p.mode;}},maxWidth:{get:function(){return Math.min(p.maxWidth,innerWidth);}},maxHeight:{get:function(){return p.maxHeight;}},statePersistence:{value:"daemon"},stateModelContext:{value:"none"}});
    window.openai=api;
    function Tweak(){this.supported=false;}Tweak.supported=false;["addSlider","addColorPicker","addToggle","addSelect"].forEach(function(name){Tweak.prototype[name]=function(){return this;};});window.Tweak=Tweak;
    document.addEventListener("click",function(e){var a=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null;if(!a)return;try{var u=new URL(a.href);if(!/^https?:$/.test(u.protocol))return;if(p.native){a.setAttribute("target","_blank");a.setAttribute("rel","noopener");}else{e.preventDefault();request("visualization/open-external",{url:u.href}).catch(function(){});}}catch(x){}},true);
    var h=0;function size(){var b=document.body,v=b?Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)):0;if(v>0&&v!==h){h=v;send("visualization/size",{height:v});}}
    document.addEventListener("DOMContentLoaded",function(){if(window.ResizeObserver){var o=new ResizeObserver(size);o.observe(document.documentElement);if(document.body)o.observe(document.body);}size();});window.addEventListener("load",size);window.addEventListener("resize",function(){emit();size();});
  })();`;
  const runtime = `(function(){
    document.addEventListener("click",function(e){var tab=e.target.closest&&e.target.closest('.nav[role="tablist"] [role="tab"]');if(!tab||tab.disabled||tab.getAttribute("aria-disabled")==="true")return;var group=tab.closest('[role="tablist"]');group.querySelectorAll('[role="tab"]').forEach(function(item){var active=item===tab;item.classList.toggle("active",active);item.setAttribute("aria-selected",String(active));item.tabIndex=active?0:-1;var id=item.getAttribute("aria-controls");if(id){var panel=document.getElementById(id);if(panel)panel.hidden=!active;}});});
    document.addEventListener("keydown",function(e){var tab=e.target.closest&&e.target.closest('.nav[role="tablist"] [role="tab"]');if(!tab||!["ArrowLeft","ArrowRight","Home","End"].includes(e.key))return;var tabs=Array.from(tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')).filter(function(item){return !item.disabled&&item.getAttribute("aria-disabled")!=="true";});var at=tabs.indexOf(tab),next=e.key==="Home"?0:e.key==="End"?tabs.length-1:(at+(e.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;e.preventDefault();tabs[next].focus();tabs[next].click();});
    var tip=null;function hide(){if(tip){tip.remove();tip=null;}}function show(target){hide();var label=target.getAttribute("data-tooltip");if(!label)return;tip=document.createElement("div");tip.className="paseo-viz-tooltip";tip.setAttribute("role","tooltip");tip.textContent=label;document.body.appendChild(tip);var r=target.getBoundingClientRect();tip.style.left=Math.max(4,Math.min(r.left,innerWidth-tip.offsetWidth-4))+"px";tip.style.top=Math.max(4,r.top-tip.offsetHeight-6)+"px";}
    document.addEventListener("pointerover",function(e){var target=e.target.closest&&e.target.closest("[data-tooltip]");if(target)show(target);});document.addEventListener("pointerout",function(e){if(e.target.closest&&e.target.closest("[data-tooltip]"))hide();});document.addEventListener("focusin",function(e){var target=e.target.closest&&e.target.closest("[data-tooltip]");if(target)show(target);});document.addEventListener("focusout",hide);
  })();`;
  return `<!doctype html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${VISUALIZATION_CSP}"><style id="paseo-viz-theme">${visualizationThemeCss(input.theme)}</style><style>${VISUALIZATION_BASE_CSS}</style><script>${script}</script><script>${runtime}</script></head><body>${input.fragment}</body>`;
}
