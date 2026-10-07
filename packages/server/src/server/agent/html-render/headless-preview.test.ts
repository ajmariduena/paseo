import { expect, test } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RENDER_WIDTHS } from "@getpaseo/protocol/html-render";
import {
  CdpFrameDecoder,
  captureHtmlPreview,
  measureHtmlRenderHeights,
} from "./headless-preview.js";
import { STOCK_RENDER_THEMES } from "./stock-theme.js";

const executable = process.env.PASEO_TEST_HEADLESS_SHELL;
const live = test.skipIf(!executable);

test("decodes a CDP frame split inside a UTF-8 character", () => {
  const decoder = new CdpFrameDecoder();
  const frame = Buffer.from(
    `${JSON.stringify({ method: "Runtime.consoleAPICalled", params: { text: "café 🍋" } })}\0`,
  );
  const split = frame.indexOf(Buffer.from("é")) + 1;
  expect(decoder.push(frame.subarray(0, split))).toEqual([]);
  expect(decoder.push(frame.subarray(split))).toEqual([
    JSON.stringify({ method: "Runtime.consoleAPICalled", params: { text: "café 🍋" } }),
  ]);
});

live(
  "releases browser slots when profile creation fails",
  async () => {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = path.join(tmpdir(), "paseo-missing-preview-temp", "missing");
    const input = {
      executable: executable!,
      width: 320,
      theme: STOCK_RENDER_THEMES.dark,
      html: "<html><body>Recovered</body></html>",
    };
    try {
      await expect(captureHtmlPreview(input)).rejects.toThrow(/ENOENT/);
      await expect(captureHtmlPreview(input)).rejects.toThrow(/ENOENT/);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    const result = await captureHtmlPreview(input);
    expect(result.png.length).toBeGreaterThan(100);
  },
  30_000,
);

live(
  "captures a real PNG at the requested width with theme, console, and short-page height",
  async () => {
    const result = await captureHtmlPreview({
      executable: executable!,
      width: 390,
      theme: STOCK_RENDER_THEMES.dark,
      html: `<html><body><div style="height:42px"></div><script>
      console.log(getComputedStyle(document.documentElement).getPropertyValue('--background').trim());
      console.info('info'); console.warn('warn'); console.error('error');
      console.log('webrtc', typeof RTCPeerConnection);
      fetch('https://example.com').catch(() => console.log('fetch blocked'));
      throw new Error('preview exception');
    </script></body></html>`,
    });
    const png = Buffer.from(result.png, "base64");
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(390);
    expect(png.readUInt32BE(20)).toBe(result.capturedHeight);
    expect(result.contentHeight).toBeLessThan(800);
    expect(result.consoleMessages.map((message) => message.text).join(" ")).toContain(
      "preview exception",
    );
    expect(result.consoleMessages.map((message) => message.text).join(" ")).toContain(
      "webrtc undefined",
    );
    expect(result.consoleMessages.map((message) => message.text).join(" ")).toContain(
      STOCK_RENDER_THEMES.dark.variables["--background"],
    );
  },
  30_000,
);

live(
  "measures fresh loads at nine widths",
  async () => {
    const heights = await measureHtmlRenderHeights({
      executable: executable!,
      widths: RENDER_WIDTHS,
      theme: STOCK_RENDER_THEMES.light,
      html: `<html><body><script>document.body.innerHTML = '<div style="height:' + (innerWidth < 728 ? 1500 : 900) + 'px"></div>'</script></body></html>`,
    });
    expect(heights.map(([width]) => width)).toEqual(RENDER_WIDTHS);
    expect(heights[0]![1]).toBeGreaterThan(heights[5]![1]);
    expect(heights[5]![1]).toBeGreaterThan(800);
  },
  30_000,
);

live(
  "refuses file URLs, local HTTPS resources, popups, and WebRTC",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-preview-secret-"));
    try {
      const secret = path.join(directory, "secret.txt");
      await writeFile(secret, "private preview sentinel");
      const result = await captureHtmlPreview({
        executable: executable!,
        width: 390,
        theme: STOCK_RENDER_THEMES.dark,
        html: `<html><body><script>
        fetch('file://${secret}').then(() => console.log('file leaked'), () => console.log('file refused'));
        var image = new Image(); image.onerror = () => console.log('loopback refused'); image.src = 'https://127.0.0.1:6767/private';
        console.log('popup', window.open('https://example.com') === null);
        console.log('webrtc', typeof RTCPeerConnection);
      </script></body></html>`,
      });
      const output = result.consoleMessages.map((message) => message.text).join(" ");
      expect(output).toContain("file refused");
      expect(output).not.toContain("file leaked");
      expect(output).toContain("loopback refused");
      expect(output).toContain("popup true");
      expect(output).toContain("webrtc undefined");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

live(
  "cancellation kills the browser and removes its profile",
  async () => {
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("paseo-html-preview-")),
    );
    const controller = new AbortController();
    const pending = captureHtmlPreview({
      executable: executable!,
      width: 390,
      theme: STOCK_RENDER_THEMES.dark,
      html: "<html><body><script>for(;;){}</script></body></html>",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow(/cancelled/);
    const after = (await readdir(tmpdir())).filter(
      (name) => name.startsWith("paseo-html-preview-") && !before.has(name),
    );
    expect(after).toEqual([]);
  },
  30_000,
);

live(
  "bounds console output and marks omitted entries",
  async () => {
    const result = await captureHtmlPreview({
      executable: executable!,
      width: 320,
      theme: STOCK_RENDER_THEMES.dark,
      html: '<html><body><script>for(let i=0;i<35;i++)console.log("x".repeat(600))</script></body></html>',
    });
    expect(result.consoleMessages).toHaveLength(21);
    expect(result.consoleMessages[0]!.text.length).toBe(500);
    expect(result.consoleMessages[20]!.text).toContain("omitted");
  },
  30_000,
);
