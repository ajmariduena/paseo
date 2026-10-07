import { mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { HtmlRenderStore, inlineLocalImages, prepareHtmlPreview, MAX_HTML_CHARS } from "./store.js";

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

test("rejects a symlinked agent directory on publish and get", async () => {
  const home = await tempDirectory();
  const store = new HtmlRenderStore(home);
  const render = await store.publish({
    agentId: "agent_a",
    cwd: home,
    html: "<p>Private</p>",
    title: "Private",
    height: 100,
  });
  const root = path.join(home, "html-renders");
  await symlink(path.join(root, "agent_a"), path.join(root, "agent_b"), "dir");
  await expect(store.get("agent_b", render.renderId)).rejects.toThrow();
  await expect(
    store.publish({
      agentId: "agent_b",
      cwd: home,
      html: "<p>Write</p>",
      title: "Write",
      height: 100,
    }),
  ).rejects.toThrow();
  expect((await store.get("agent_a", render.renderId)).html).toBe("<p>Private</p>");
});

test("rejects symlinked render files and a symlinked render root", async () => {
  const home = await tempDirectory();
  const store = new HtmlRenderStore(home);
  const render = await store.publish({
    agentId: "agent_a",
    cwd: home,
    html: "<p>Page</p>",
    title: "Page",
    height: 100,
  });
  const directory = path.join(home, "html-renders", "agent_a");
  const filename = path.join(directory, `${render.renderId}.html`);
  const moved = path.join(directory, "moved.html");
  await rename(filename, moved);
  await symlink(moved, filename);
  await expect(store.get("agent_a", render.renderId)).rejects.toThrow();

  const secondHome = await tempDirectory();
  await symlink(path.join(home, "html-renders"), path.join(secondHome, "html-renders"), "dir");
  const secondStore = new HtmlRenderStore(secondHome);
  await expect(secondStore.get("agent_a", render.renderId)).rejects.toThrow();
  await expect(
    secondStore.publish({
      agentId: "agent_a",
      cwd: secondHome,
      html: "<p>Write</p>",
      title: "Write",
      height: 100,
    }),
  ).rejects.toThrow();
});

test("rejects a render file swapped to a symlink after validation", async () => {
  const home = await tempDirectory();
  const ordinary = new HtmlRenderStore(home);
  const render = await ordinary.publish({
    agentId: "agent_a",
    cwd: home,
    html: "<p>Original</p>",
    title: "Original",
    height: 100,
  });
  const filename = path.join(home, "html-renders", "agent_a", `${render.renderId}.html`);
  const target = path.join(home, "elsewhere.html");
  await writeFile(target, "<p>Other agent</p>");
  let swapped = false;
  const store = new HtmlRenderStore(home, async () => {
    if (swapped) return;
    swapped = true;
    await rm(filename);
    await symlink(target, filename);
  });
  await expect(store.get("agent_a", render.renderId)).rejects.toThrow();
});

test("rejects an agent directory swapped after validation", async () => {
  const home = await tempDirectory();
  const ordinary = new HtmlRenderStore(home);
  const render = await ordinary.publish({
    agentId: "agent_a",
    cwd: home,
    html: "<p>Original</p>",
    title: "Original",
    height: 100,
  });
  const directory = path.join(home, "html-renders", "agent_a");
  const moved = path.join(home, "html-renders", "moved");
  let swapped = false;
  const store = new HtmlRenderStore(home, async () => {
    if (swapped) return;
    swapped = true;
    await rename(directory, moved);
    await symlink(moved, directory, "dir");
  });
  await expect(store.get("agent_a", render.renderId)).rejects.toThrow();
});

test("startup sweep removes only temp files older than an hour", async () => {
  const home = await tempDirectory();
  const store = new HtmlRenderStore(home);
  const render = await store.publish({
    agentId: "agent_a",
    cwd: home,
    html: "<p>Keep</p>",
    title: "Keep",
    height: 100,
  });
  const directory = path.join(home, "html-renders", "agent_a");
  const old = path.join(directory, `.${render.renderId}.${render.renderId}.tmp`);
  const fresh = path.join(
    directory,
    `.${render.renderId}.00000000-0000-0000-0000-000000000000.tmp`,
  );
  await writeFile(old, "old");
  await writeFile(fresh, "fresh");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(old, twoHoursAgo, twoHoursAgo);
  await store.initialize();
  await expect(readFile(old)).rejects.toThrow();
  expect(await readFile(fresh, "utf8")).toBe("fresh");
  expect((await store.get("agent_a", render.renderId)).html).toBe("<p>Keep</p>");
});

test("local image symlinks are rejected before reading", async () => {
  const home = await tempDirectory();
  const image = path.join(home, "source.png");
  const linked = path.join(home, "linked.png");
  await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  await symlink(image, linked);
  await expect(inlineLocalImages(`<img src="${linked}">`, home)).rejects.toThrow(/regular file/);
});

test("preview keeps refused images as diagnostics while publish remains fail closed", async () => {
  const home = await tempDirectory();
  const missing = path.join(home, "missing.png");
  const html = `<img src="${missing}"><p>Content</p>`;
  expect(await prepareHtmlPreview(html, home)).toEqual({ html, missingImages: [missing] });
  await expect(inlineLocalImages(html, home)).rejects.toThrow(/Cannot inline local image/);
});
