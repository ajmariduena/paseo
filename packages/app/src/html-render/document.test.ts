import { Script } from "node:vm";
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
  const html =
    '<!-- <head>fake</head> --><template><head>fake</head></template><script>"<head>"</script><html><head><title>Page</title></head><body>ok</body></html>';
  const prepared = prepareRenderDocument(html, mapRenderTheme(darkTheme), "nonce", "render");
  expect(prepared.indexOf("Content-Security-Policy")).toBeLessThan(prepared.indexOf("<script>"));
  expect(prepared.indexOf('id="paseo-render-theme"')).toBeGreaterThan(
    prepared.indexOf("<html><head>"),
  );
  expect(prepared).toContain(RENDER_CSP);
  expect(prepared).toContain("ui/notifications/host-context-changed");
  expect(prepared).toContain("ui/notifications/size-changed");
  expect(prepared).toContain("ui/open-link");
  const bootstrap = /<script>([\s\S]*?)<\/script>/.exec(prepared)?.[1];
  if (!bootstrap) throw new Error("Render bootstrap script missing");
  expect(() => new Script(bootstrap)).not.toThrow();
});

test("maps live light and dark themes and bounds height messages", () => {
  const dark = mapRenderTheme(darkTheme);
  const light = mapRenderTheme(lightTheme);
  expect(dark.variables["--background"]).toBe(darkTheme.colors.background);
  expect(light.variables["--background"]).toBe(lightTheme.colors.background);
  expect(light.variables["--background"]).not.toBe(dark.variables["--background"]);
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
