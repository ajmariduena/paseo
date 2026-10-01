import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "electron";
import { expect, it } from "vitest";
import type { CookieAdapter } from "./cdp.js";
import { deleteReceipt, getReceipt, importCookies, withCookieImportLock } from "./service.js";

it("writes a receipt only after live CDP success and deletes it on clear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-receipt-test-"));
  try {
    const filePath = join(dir, "cookies.json");
    writeFileSync(
      filePath,
      JSON.stringify([{ domain: "example.com", name: "session", value: "abc" }]),
    );
    const written: string[] = [];
    const adapter: CookieAdapter = {
      get: async () => [],
      set: async (identity) => {
        written.push(identity.name);
      },
      remove: async () => {},
      close: () => {},
    };
    const result = await importCookies(
      { kind: "file" },
      {
        session: {} as Session,
        userData: dir,
        filePath,
        openAdapter: async () => adapter,
        log: () => {},
      },
    );
    expect(result).toMatchObject({
      status: "imported",
      sourceLabel: "JSON file",
      imported: 1,
      skipped: 0,
      failed: 0,
    });
    expect(written).toEqual(["session"]);
    expect(getReceipt(dir)).toMatchObject({ sourceLabel: "JSON file", imported: 1, skipped: 0 });
    deleteReceipt(dir);
    expect(getReceipt(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("serializes clear behind an import on the same session", async () => {
  const session = {};
  const events: string[] = [];
  let finishImport!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishImport = resolve;
  });
  const importing = withCookieImportLock(session, async () => {
    events.push("import-start");
    await gate;
    events.push("import-end");
  });
  const clearing = withCookieImportLock(session, async () => {
    events.push("clear");
  });
  await Promise.resolve();
  expect(events).toEqual(["import-start"]);
  finishImport();
  await Promise.all([importing, clearing]);
  expect(events).toEqual(["import-start", "import-end", "clear"]);
});
