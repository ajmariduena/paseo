import { describe, expect, it } from "vitest";
import type { BrowserCookieImportResult } from "@/desktop/host";
import { describeCookieImportResult } from "./browser-cookie-import-result";

function imported(
  overrides: Partial<Extract<BrowserCookieImportResult, { status: "imported" }>> = {},
): BrowserCookieImportResult {
  return {
    status: "imported",
    sourceLabel: "Google Chrome",
    profileLabel: "Personal",
    imported: 120,
    skipped: 0,
    googleSkipped: 0,
    partitionSkipped: 0,
    failed: 0,
    importedAt: "2026-10-01T19:00:00.000Z",
    ...overrides,
  };
}

describe("describeCookieImportResult", () => {
  it("stays silent when the file picker is canceled", () => {
    expect(describeCookieImportResult({ status: "canceled" }, "JSON")).toBeNull();
  });

  it("reports a clean import as success", () => {
    expect(describeCookieImportResult(imported(), "Google Chrome")).toEqual({
      variant: "success",
      key: "settings.browser.cookieImport.result.imported",
      values: { count: 120, source: "Google Chrome" },
    });
  });

  it("mentions skipped cookies without downgrading the success", () => {
    expect(describeCookieImportResult(imported({ skipped: 7 }), "Google Chrome")).toMatchObject({
      variant: "success",
      values: { skipped: 7 },
    });
  });

  it("warns when some cookies could not be loaded", () => {
    expect(
      describeCookieImportResult(imported({ failed: 2, partitionSkipped: 3 }), "Google Chrome"),
    ).toMatchObject({
      variant: "warning",
      key: "settings.browser.cookieImport.result.partial",
      values: { failed: 5 },
    });
  });

  it("never reports success when nothing was imported", () => {
    expect(
      describeCookieImportResult(imported({ imported: 0, skipped: 40 }), "Google Chrome"),
    ).toMatchObject({ variant: "error", key: "settings.browser.cookieImport.result.none" });
  });

  it("maps each error code to its own message", () => {
    expect(describeCookieImportResult({ status: "error", code: "keychain_denied" }, "Arc")).toEqual(
      {
        variant: "error",
        key: "settings.browser.cookieImport.errors.keychainDenied",
        values: { source: "Arc" },
      },
    );
  });
});
