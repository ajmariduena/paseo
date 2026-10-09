import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  REAL_CREATE_ONCE_PORT,
  writeJsonFileCreateOnce,
  type CreateOncePort,
} from "./atomic-file.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atomic-file-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function withoutLinks(overrides: Partial<CreateOncePort> = {}): CreateOncePort {
  return {
    ...REAL_CREATE_ONCE_PORT,
    link: async () => {
      throw Object.assign(new Error("link not supported"), { code: "ENOTSUP" });
    },
    ...overrides,
  };
}

/** The first temp write dies after ten bytes; later writes are healthy. */
function withFullDiskOnce(port: CreateOncePort): CreateOncePort {
  let failures = 1;
  return {
    ...port,
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
  expect(await fs.readdir(root)).toEqual(["one.json"]);
});

test("without hard links the complete temp file is renamed into a free path only", async () => {
  const target = join(root, "one.json");
  const port = withoutLinks();

  expect(await writeJsonFileCreateOnce(target, { winner: "a" }, port)).toBe(true);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ winner: "a" });
  expect(await writeJsonFileCreateOnce(target, { winner: "b" }, port)).toBe(false);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ winner: "a" });
  expect(await fs.readdir(root)).toEqual(["one.json"]);
});

test.each([
  ["with hard links", REAL_CREATE_ONCE_PORT],
  ["without hard links", withoutLinks()],
])(
  "a write that fails midway leaves no file %s, and a healthy retry wins",
  async (_label, base) => {
    const target = join(root, "one.json");
    const port = withFullDiskOnce(base);

    await expect(writeJsonFileCreateOnce(target, { winner: "a" }, port)).rejects.toMatchObject({
      code: "ENOSPC",
    });
    expect(await fs.readdir(root)).toEqual([]);

    expect(await writeJsonFileCreateOnce(target, { winner: "b" }, port)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ winner: "b" });
    expect(await fs.readdir(root)).toEqual(["one.json"]);
  },
);
