import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { HtmlRenderStore, inlineLocalImages, MAX_HTML_CHARS } from "./store.js";

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-html-render-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("publishes a render atomically, scopes reads to its agent, and deletes on hard delete", async () => {
  const home = await tempDirectory();
  const store = new HtmlRenderStore(home);
  const render = await store.publish({
    agentId: "agent_a",
    cwd: home,
    html: "<h1>Hello</h1>",
    title: "Hello",
    height: 3000,
  });
  expect(render.height).toBe(2000);
  expect(await store.get("agent_a", render.renderId)).toEqual({
    html: "<h1>Hello</h1>",
    title: "Hello",
  });
  await expect(store.get("agent_b", render.renderId)).rejects.toThrow();
  expect(
    await readFile(path.join(home, "html-renders", "agent_a", `${render.renderId}.html`), "utf8"),
  ).toBe("<h1>Hello</h1>");
  await store.deleteAgent("agent_a");
  await expect(store.get("agent_a", render.renderId)).rejects.toThrow();
});

test("inlines uppercase image paths and refuses an invalid signature", async () => {
  const home = await tempDirectory();
  const image = path.join(home, "picture.PNG");
  await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  expect(await inlineLocalImages(`<img src="${image}">`, home)).toContain("data:image/png;base64,");
  await writeFile(image, "not an image");
  await expect(inlineLocalImages(`<img src="${image}">`, home)).rejects.toThrow(/signature/);
  const svg = path.join(home, "diagram.svg");
  await writeFile(
    svg,
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY name "chart">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
  );
  expect(await inlineLocalImages(`<img src="${svg}">`, home)).toContain(
    "data:image/svg+xml;base64,",
  );
  await writeFile(svg, "<!-- <svg> --><html></html>");
  await expect(inlineLocalImages(`<img src="${svg}">`, home)).rejects.toThrow(/signature/);
});

test("enforces input and prepared page limits", async () => {
  const home = await tempDirectory();
  const store = new HtmlRenderStore(home);
  await expect(
    store.publish({
      agentId: "agent_a",
      cwd: home,
      html: "x".repeat(MAX_HTML_CHARS + 1),
      title: "Too long",
      height: 80,
    }),
  ).rejects.toThrow(/512,000/);
  const image = path.join(home, "large.png");
  await writeFile(
    image,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(5 * 1024 * 1024)]),
  );
  await expect(
    store.publish({
      agentId: "agent_a",
      cwd: home,
      html: `<img src="${image}">`,
      title: "Too large",
      height: 100,
    }),
  ).rejects.toThrow(/6 MiB/);
  await writeFile(image, Buffer.alloc(10 * 1024 * 1024 + 1));
  await expect(inlineLocalImages(`<img src="${image}">`, home)).rejects.toThrow(/10 MiB/);
});
