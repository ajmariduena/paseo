import { Script } from "node:vm";
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
