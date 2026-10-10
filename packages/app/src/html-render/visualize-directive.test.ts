import { expect, test } from "vitest";
import { hasWideCodexVisualization, splitCodexVisualizeDirectives } from "./visualize-directive";

const apple = '\uE200visualize\uE202{"path":"/work/apple-chart.html","title":"Apples"}\uE201';
const banana = '\uE200visualize\uE202{"path":"/work/banana-chart.html","mode":"wide"}\uE201';
const alias = '::visualize{"path":"/work/pear-chart.html"}';

test("extracts complete standalone Codex references in order outside fences and quotes", () => {
  const source = [
    "Intro",
    apple,
    "Middle",
    `   ${banana}`,
    alias,
    `> ${apple}`,
    "~~~html",
    banana,
    "~~~",
    `\`${alias}\``,
    '\uE200visualize\uE202{"path":bad}\uE201',
    "End",
  ].join("\n");
  const parts = splitCodexVisualizeDirectives(source, { complete: true });
  expect(parts.filter((part) => part.kind === "visual").map((part) => part.reference)).toEqual([
    { path: "/work/apple-chart.html", title: "Apples", occurrenceId: String(6) },
    {
      path: "/work/banana-chart.html",
      mode: "wide",
      occurrenceId: String(source.indexOf(`   ${banana}`)),
    },
    { path: "/work/pear-chart.html", occurrenceId: String(source.indexOf(alias)) },
  ]);
  const markdown = parts
    .filter((part) => part.kind === "markdown")
    .map((part) => part.text)
    .join("");
  expect(markdown).toContain("Intro\nMiddle\n");
  expect(markdown).toContain(`> ${apple}`);
  expect(markdown).toContain(`~~~html\n${banana}\n~~~`);
  expect(markdown).toContain('{"path":bad}');
  expect(markdown).toContain("End");
  expect(hasWideCodexVisualization(source, true)).toBe(true);
});

test("withholds a partial streaming marker until a newline or completed message", () => {
  expect(splitCodexVisualizeDirectives(`Lead\n\uE200visu`, { complete: false })).toEqual([
    { kind: "markdown", text: "Lead\n" },
  ]);
  expect(splitCodexVisualizeDirectives("Lead\n::", { complete: false })).toEqual([
    { kind: "markdown", text: "Lead\n" },
  ]);
  expect(splitCodexVisualizeDirectives(apple, { complete: false })).toEqual([
    { kind: "markdown", text: "" },
  ]);
  expect(splitCodexVisualizeDirectives(`${apple}\n`, { complete: false })).toEqual([
    {
      kind: "visual",
      reference: { path: "/work/apple-chart.html", title: "Apples", occurrenceId: "0" },
    },
  ]);
  expect(splitCodexVisualizeDirectives(apple, { complete: true })[0]?.kind).toBe("visual");
});

test("keeps malformed and unsupported directives as ordinary text", () => {
  for (const text of [
    '\uE200visualize\uE202{"path":"relative.html"}\uE201',
    '\uE200visualize\uE202{"path":"/work/Upper.html"}\uE201',
    '\uE200visualize\uE202{"path":"/work/ok.html","mode":"fullscreen"}\uE201',
    `    ${apple}`,
    `before ${apple}`,
    '::visualize{"path":"/work/ok.html"} after',
  ]) {
    expect(splitCodexVisualizeDirectives(text, { complete: true })).toEqual([
      { kind: "markdown", text },
    ]);
  }
});
