import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { writeJsonFileCreateOnce } from "./atomic-file.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atomic-file-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function withoutLinks(): Pick<typeof fs, "link"> {
  return {
    link: async () => {
      throw Object.assign(new Error("link not supported"), { code: "ENOTSUP" });
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
