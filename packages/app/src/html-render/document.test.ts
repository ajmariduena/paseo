import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { parse } from "parse5";
import { expect, test } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import {
  clampRenderHeight,
  mapRenderTheme,
  prepareRenderDocument,
  readRenderBridgeMessage,
  RENDER_CSP,
} from "./document";
import {
  NATIVE_FOLLOW_UP_PREFIX,
  prepareVisualizationDocument,
  readNativeFollowUpUrl,
  readVisualizationBridgeMessage,
  VISUALIZATION_CSP,
  visualizationReply,
  visualizationThemeMessage,
} from "./visualize-bridge";
import { visualizationVariables } from "./visualize-style";

test("places CSP before source and bootstrap in the real head", () => {
  for (const html of [
    '<!-- <head>fake</head> --><template><head>fake</head></template><script>"<head>"</script><html><head><title>Page</title></head><body>ok</body></html>',
    '<!DOCTYPE html [<!ENTITY x ">">]><html><head><title>Malformed</title></head><body>ok</body></html>',
  ]) {
    const prepared = prepareRenderDocument({
      html,
      theme: mapRenderTheme(darkTheme),
      nonce: "nonce",
      renderId: "render",
      linkMode: "web",
    });
    const root = parse(prepared).childNodes.find((node) => node.nodeName === "html");
    if (!root || !("childNodes" in root)) throw new Error("Render HTML root missing");
    const head = root.childNodes.find((node) => node.nodeName === "head");
    if (!head || !("childNodes" in head)) throw new Error("Render head missing");
    const nodes = head.childNodes.filter((node) => "tagName" in node);
    expect(nodes.slice(0, 5).map((node) => node.tagName)).toEqual([
      "meta",
      "meta",
      "meta",
      "style",
      "script",
    ]);
    expect(nodes[0].attrs.find((attribute) => attribute.name === "http-equiv")?.value).toBe(
      "Content-Security-Policy",
    );
    expect(nodes[0].attrs.find((attribute) => attribute.name === "content")?.value).toBe(
      RENDER_CSP,
    );
    expect(nodes[3].attrs.find((attribute) => attribute.name === "id")?.value).toBe(
      "paseo-render-theme",
    );
    expect(prepared).toContain("ui/notifications/host-context-changed");
    expect(prepared).toContain("ui/notifications/size-changed");
    expect(prepared).toContain("ui/open-link");
    const bootstrap = /<script>([\s\S]*?)<\/script>/.exec(prepared)?.[1];
    if (!bootstrap) throw new Error("Render bootstrap script missing");
    expect(() => new Script(bootstrap)).not.toThrow();
  }
});

test("native bootstrap opens trusted links in a new WebView window without a link message", () => {
  const prepared = prepareRenderDocument({
    html: '<a href="https://example.com">Example</a>',
    theme: mapRenderTheme(lightTheme),
    nonce: "nonce",
    renderId: "render",
    linkMode: "native",
  });
  expect(prepared).toContain('a.setAttribute("target","_blank")');
  expect(prepared).toContain('a.setAttribute("rel","noopener")');
  expect(prepared).toContain("e.isTrusted");
  expect(prepared).not.toContain("ui/open-link");
});

test("maps live light and dark themes and bounds height messages", () => {
  const dark = mapRenderTheme(darkTheme);
  const light = mapRenderTheme(lightTheme);
  expect(dark.variables["--background"]).toBe(darkTheme.colors.background);
  expect(light.variables["--background"]).toBe(lightTheme.colors.background);
  expect(light.variables["--background"]).not.toBe(dark.variables["--background"]);
  for (const mapped of [dark, light]) {
    expect(
      new Set(Array.from({ length: 6 }, (_, index) => mapped.variables[`--chart-${index + 1}`]))
        .size,
    ).toBe(6);
  }
  expect(clampRenderHeight(1)).toBe(80);
  expect(clampRenderHeight(10_000)).toBe(2000);
  expect(
    readRenderBridgeMessage(
      {
        jsonrpc: "2.0",
        nonce: "n",
        renderId: "r",
        method: "ui/notifications/size-changed",
        params: { height: 500 },
      },
      "n",
      "r",
    ),
  ).not.toBeNull();
  expect(
    readRenderBridgeMessage(
      {
        jsonrpc: "2.0",
        nonce: "wrong",
        renderId: "r",
        method: "ui/notifications/size-changed",
        params: { height: 500 },
      },
      "n",
      "r",
    ),
  ).toBeNull();
  expect(
    readRenderBridgeMessage(
      {
        jsonrpc: "2.0",
        nonce: "n",
        renderId: "r",
        id: "link-1",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      },
      "n",
      "r",
    ),
  ).not.toBeNull();
  expect(
    readRenderBridgeMessage(
      {
        jsonrpc: "2.0",
        nonce: "n",
        renderId: "r",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      },
      "n",
      "r",
    ),
  ).toBeNull();
});

test("visualization fragment has its own CDN CSP, base classes, and parseable bootstrap", () => {
  const prepared = prepareVisualizationDocument({
    fragment:
      '<div class="table-responsive"><table class="table"><tr><td>Fruit</td></tr></table></div>',
    theme: mapRenderTheme(lightTheme),
    nonce: "nonce",
    identity: "/work/fruit-chart.html",
    state: { modelContent: { chosen: "apple" }, privateContent: null },
    mode: "wide",
    linkMode: "web",
  });
  const root = parse(prepared).childNodes.find((node) => node.nodeName === "html");
  if (!root || !("childNodes" in root)) throw new Error("Visual root missing");
  const head = root.childNodes.find((node) => node.nodeName === "head");
  if (!head || !("childNodes" in head)) throw new Error("Visual head missing");
  const nodes = head.childNodes.filter((node) => "tagName" in node);
  expect(nodes.slice(0, 7).map((node) => node.tagName)).toEqual([
    "meta",
    "meta",
    "meta",
    "style",
    "style",
    "script",
    "script",
  ]);
  expect(nodes[2].attrs.find((attribute) => attribute.name === "content")?.value).toBe(
    VISUALIZATION_CSP,
  );
  expect(prepared).toContain(".table-responsive");
  expect(prepared).toContain("openai:set_globals");
  expect(prepared).toContain('stateModelContext:"none"');
  expect(prepared).toContain("Tweak.supported=false");
  for (const match of prepared.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    expect(() => new Script(match[1])).not.toThrow();
  }
  expect(VISUALIZATION_CSP).toContain("connect-src blob: data:");
  expect(VISUALIZATION_CSP).toContain("https://cdn.jsdelivr.net");
  expect(VISUALIZATION_CSP).not.toContain("https:;");
  expect(RENDER_CSP).toContain("connect-src 'none'");
});

test("visualization themes and bridge reject forged or unsafe requests", () => {
  for (const theme of [lightTheme, darkTheme]) {
    const vars = visualizationVariables(mapRenderTheme(theme));
    expect(vars["--font-size-base"]).toBe(`${theme.fontSize.base}px`);
    expect(vars["--viz-series-1"]).toBe(vars["--primary"]);
    expect(
      new Set(Array.from({ length: 6 }, (_, index) => vars[`--viz-series-${index + 1}`])).size,
    ).toBe(6);
    for (const named of ["blue", "orange", "green", "red", "purple", "yellow"]) {
      expect(vars[`--${named}`]).toMatch(/^#[0-9a-f]{6}$/);
    }
  }
  const size = {
    jsonrpc: "2.0",
    nonce: "n",
    identity: "/work/fruit-chart.html",
    method: "visualization/size",
    params: { height: 360 },
  };
  expect(readVisualizationBridgeMessage(size, "n", "/work/fruit-chart.html")).toEqual(size);
  expect(readVisualizationBridgeMessage(size, "wrong", "/work/fruit-chart.html")).toBeNull();
  expect(
    readVisualizationBridgeMessage({ ...size, params: { height: 0 } }, "n", size.identity),
  ).toBeNull();
  expect(
    readVisualizationBridgeMessage(
      { ...size, id: "1", method: "visualization/open-external", params: { url: "http://host" } },
      "n",
      size.identity,
    ),
  ).toBeNull();
  const followUpUrl = `${NATIVE_FOLLOW_UP_PREFIX}${encodeURIComponent(JSON.stringify({ nonce: "n", identity: size.identity, id: "1", prompt: "Explain apples" }))}`;
  expect(readNativeFollowUpUrl(followUpUrl, "n", size.identity)).toEqual({
    id: "1",
    prompt: "Explain apples",
  });
  expect(readNativeFollowUpUrl(followUpUrl, "wrong", size.identity)).toBeNull();
});

test("visualization runtime restores state, acknowledges writes, updates theme, tabs and tooltips", async () => {
  const sent: Array<{ id?: string; method: string; params: Record<string, unknown> }> = [];
  const prepared = prepareVisualizationDocument({
    fragment:
      '<div class="nav nav-pills" role="tablist"><button id="first" role="tab" class="nav-link active" aria-selected="true" aria-controls="first-panel">First</button><button id="second" role="tab" class="nav-link" aria-selected="false" aria-controls="second-panel" data-tooltip="Second fruit">Second</button></div><section id="first-panel" role="tabpanel">Apple</section><section id="second-panel" role="tabpanel" hidden>Banana</section><script>window.initialState=window.openai.widgetState;window.tweakSupported=Tweak.supported;</script>',
    theme: mapRenderTheme(lightTheme),
    nonce: "n",
    identity: "/work/fruit-chart.html",
    state: { modelContent: { chosen: "apple" }, privateContent: null },
    mode: "inline",
    linkMode: "native",
  });
  const dom = new JSDOM(prepared, {
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperty(window, "TextEncoder", { value: TextEncoder });
      Object.defineProperty(window, "ReactNativeWebView", {
        value: { postMessage: (encoded: string) => sent.push(JSON.parse(encoded)) },
      });
    },
  });
  const host = dom.window as unknown as {
    initialState: unknown;
    tweakSupported: boolean;
    openai: {
      widgetState: unknown;
      theme: string;
      setWidgetState: (value: unknown) => Promise<unknown>;
    };
  };
  expect(host.initialState).toEqual({ modelContent: { chosen: "apple" }, privateContent: null });
  expect(host.tweakSupported).toBe(false);
  const write = host.openai.setWidgetState({ modelContent: { chosen: "banana" } });
  expect(host.openai.widgetState).toEqual({
    modelContent: { chosen: "banana" },
    privateContent: null,
  });
  const message = sent.find((item) => item.method === "visualization/set-state");
  if (!message?.id) throw new Error("State message missing");
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: visualizationReply(
        "n",
        "/work/fruit-chart.html",
        message.id,
        { state: { modelContent: { chosen: "banana" }, privateContent: null } },
        null,
      ),
    }),
  );
  await expect(write).resolves.toEqual({
    modelContent: { chosen: "banana" },
    privateContent: null,
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: visualizationThemeMessage(mapRenderTheme(darkTheme), "n", "/work/fruit-chart.html"),
    }),
  );
  expect(host.openai.theme).toBe("dark");
  expect(dom.window.document.getElementById("paseo-viz-theme")?.textContent).toContain(
    "color-scheme:dark",
  );
  dom.window.document.getElementById("second")?.click();
  expect(dom.window.document.getElementById("first-panel")?.hasAttribute("hidden")).toBe(true);
  expect(dom.window.document.getElementById("second-panel")?.hasAttribute("hidden")).toBe(false);
  const second = dom.window.document.getElementById("second");
  second?.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
  expect(dom.window.document.querySelector(".paseo-viz-tooltip")?.textContent).toBe("Second fruit");
  second?.dispatchEvent(new dom.window.Event("pointerout", { bubbles: true }));
  expect(dom.window.document.querySelector(".paseo-viz-tooltip")).toBeNull();
  dom.window.close();
});
