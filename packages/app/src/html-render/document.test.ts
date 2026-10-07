import { Script } from "node:vm";
import { parse } from "parse5";
import { expect, test } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import { RENDER_WIDTHS, validRenderHeights } from "@getpaseo/protocol/html-render";
import { STOCK_RENDER_THEMES } from "../../../server/src/server/agent/html-render/stock-theme";
import {
  clampRenderHeight,
  renderFrameHeight,
  mapRenderTheme,
  prepareRenderDocument,
  readRenderBridgeMessage,
  RENDER_CSP,
} from "./document";
import {
  NATIVE_FOLLOW_UP_PREFIX,
  NATIVE_EXTERNAL_PREFIX,
  prepareVisualizationDocument,
  readNativeFollowUpUrl,
  readNativeExternalUrl,
  readVisualizationBridgeMessage,
  VISUALIZATION_CSP,
} from "./visualize-bridge";
import { VISUALIZATION_BASE_CSS, visualizationVariables } from "./visualize-style";

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
  expect(dark.variables["--card"]).toBe(darkTheme.colors.surface1);
  expect(dark.variables["--background"]).not.toBe(dark.variables["--card"]);
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
  expect(renderFrameHeight(400, null, 728)).toBe(400);
  expect(renderFrameHeight(400, 700, 364)).toBe(700);
  expect(renderFrameHeight(400, 1200, 364)).toBe(800);
  expect(renderFrameHeight(400, 250, 364)).toBe(250);
  expect(renderFrameHeight(1500, null, 320)).toBe(2000);
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
  const hover = {
    jsonrpc: "2.0",
    nonce: "n",
    renderId: "r",
    method: "ui/notifications/hover-changed",
    params: { hovered: true },
  };
  expect(readRenderBridgeMessage(hover, "n", "r")).toEqual(hover);
  expect(readRenderBridgeMessage({ ...hover, params: { hovered: "yes" } }, "n", "r")).toBeNull();
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

test("stock preview theme matches the app's default themes", () => {
  expect(STOCK_RENDER_THEMES.dark).toEqual(mapRenderTheme(darkTheme));
  expect(STOCK_RENDER_THEMES.light).toEqual(mapRenderTheme(lightTheme));
});

test("measured heights grow on phones, honor intentional caps, and validate the whole table", () => {
  const heights = RENDER_WIDTHS.map((width) => [width, width < 728 ? 1500 : 900] as const);
  expect(validRenderHeights(heights)).toBe(true);
  expect(renderFrameHeight(900, null, 360, heights)).toBe(1500);
  expect(renderFrameHeight(900, 1300, 360, heights)).toBe(1300);
  expect(renderFrameHeight(900, 1500, 450, heights)).toBe(1500);
  expect(renderFrameHeight(600, 1500, 360, heights)).toBe(600);
  expect(renderFrameHeight(900, null, 1400, heights)).toBe(900);
  expect(validRenderHeights([...heights.slice(0, -1), [1144, Number.POSITIVE_INFINITY]])).toBe(
    false,
  );
  expect(validRenderHeights([...heights.slice(0, -1), [1143, 900]])).toBe(false);
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
    readVisualizationBridgeMessage(
      { ...size, method: "visualization/hover", params: { hovered: true } },
      "n",
      size.identity,
    ),
  ).not.toBeNull();
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
  const externalUrl = `${NATIVE_EXTERNAL_PREFIX}${encodeURIComponent(JSON.stringify({ nonce: "n", identity: size.identity, id: "2", url: "https://example.com/target" }))}`;
  expect(readNativeExternalUrl(externalUrl, "n", size.identity)).toEqual({
    id: "2",
    url: "https://example.com/target",
  });
  expect(readNativeExternalUrl(externalUrl, "wrong", size.identity)).toBeNull();
});

test("visualization bridge includes state, carousel, and conditional icon support", () => {
  const input = {
    theme: mapRenderTheme(lightTheme),
    nonce: "n",
    identity: "/work/fruit-chart.html",
    state: { modelContent: { chosen: "apple" }, privateContent: null },
    mode: "inline" as const,
    linkMode: "native" as const,
  };
  const plain = prepareVisualizationDocument({
    ...input,
    fragment:
      '<div class="viz-carousel"><section data-variant="A">A</section><section data-variant="B" hidden>B</section></div>',
  });
  expect(plain).toContain("window.openai=api");
  expect(plain).toContain('request("visualization/set-state"');
  expect(plain).toContain("p.nativeExternalPrefix");
  expect(plain).toContain('document.querySelectorAll(".viz-carousel")');
  expect(plain).toContain("document.fonts.ready.then(size)");
  expect(plain).toContain("trailing.bottom+offset");
  expect(VISUALIZATION_BASE_CSS).toContain("html{background:var(--background)");
  expect(VISUALIZATION_BASE_CSS).toContain(
    "body{margin:0;min-width:0;background:var(--background)",
  );
  expect(plain).toContain('picker.setAttribute("aria-label","Choose design")');
  expect(plain).not.toContain('src="https://unpkg.com/lucide@');
  const withIcons = prepareVisualizationDocument({
    ...input,
    fragment: '<i data-lucide="search"></i>',
  });
  expect(withIcons).toContain('src="https://unpkg.com/lucide@1.17.0/dist/umd/lucide.js"');
  expect(withIcons).toContain("window.lucide.createIcons");
  expect(withIcons).not.toContain('customElements.define("viz-calendar"');
});
