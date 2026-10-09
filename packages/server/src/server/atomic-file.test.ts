import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { writeJsonFileCreateOnce, type CreateOncePort } from "./atomic-file.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atomic-file-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function withoutLinks(): CreateOncePort {
  return {
    link: async () => {
      throw Object.assign(new Error("link not supported"), { code: "ENOTSUP" });
    },
    open: fs.open,
  };
}

/** No links, and the first write through the exclusive handle dies after ten bytes. */
function withoutLinksAndFullDisk(): CreateOncePort {
  let failures = 1;
  return {
    link: withoutLinks().link,
    open: async (filePath, flags) => {
      const handle = await fs.open(filePath, flags);
      if (failures === 0) return handle;
      failures -= 1;
      return {
        writeFile: async (content: string | Uint8Array) => {
          await handle.write(String(content).slice(0, 10));
          throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  };
}

test("create-once publishes exactly one winner with hard links", async () => {
  const target = join(root, "one.json");

  const results = await Promise.all([
    writeJsonFileCreateOnce(target, { winner: "a" }),
    writeJsonFileCreateOnce(target, { winner: "b" }),
  ]);

  expect(results.filter(Boolean)).toHaveLength(1);
  const written = JSON.parse(readFileSync(target, "utf8")) as { winner: string };
  expect(results[written.winner === "a" ? 0 : 1]).toBe(true);
  expect(await writeJsonFileCreateOnce(target, { winner: "c" })).toBe(false);
});

test("create-once still has exactly one winner on a filesystem without hard links", async () => {
  const target = join(root, "one.json");
  const port = withoutLinks();

  const results = await Promise.all([
    writeJsonFileCreateOnce(target, { winner: "a" }, port),
    writeJsonFileCreateOnce(target, { winner: "b" }, port),
  ]);

  expect(results.filter(Boolean)).toHaveLength(1);
  const written = JSON.parse(readFileSync(target, "utf8")) as { winner: string };
  expect(results[written.winner === "a" ? 0 : 1]).toBe(true);
  expect(await writeJsonFileCreateOnce(target, { winner: "c" }, port)).toBe(false);
  expect(await fs.readdir(root)).toEqual(["one.json"]);
});

test("a fallback write that fails leaves nothing behind, so a healthy retry wins", async () => {
  const target = join(root, "one.json");
  const port = withoutLinksAndFullDisk();

  await expect(writeJsonFileCreateOnce(target, { winner: "a" }, port)).rejects.toMatchObject({
    code: "ENOSPC",
  });
  expect(await fs.readdir(root)).toEqual([]);

  expect(await writeJsonFileCreateOnce(target, { winner: "b" }, port)).toBe(true);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ winner: "b" });
});

test("an abandoned partial fallback write is replaced once it is old, never while fresh", async () => {
  const target = join(root, "one.json");
  const port = withoutLinks();
  writeFileSync(target, '{"winner": "half');

  expect(await writeJsonFileCreateOnce(target, { winner: "b" }, port)).toBe(false);

  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(target, old, old);
  expect(await writeJsonFileCreateOnce(target, { winner: "b" }, port)).toBe(true);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ winner: "b" });
});
