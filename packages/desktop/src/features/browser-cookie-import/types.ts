export type BrowserCookieImportFamily =
  | "chrome"
  | "edge"
  | "arc"
  | "brave"
  | "comet"
  | "helium"
  | "chromium"
  | "firefox"
  | "safari";
export interface BrowserCookieImportSource {
  family: BrowserCookieImportFamily;
  label: string;
  profiles: Array<{ id: string; label: string }>;
  requiresFullDiskAccess?: boolean;
}
export type BrowserCookieImportRequest =
  | { kind: "browser"; family: BrowserCookieImportFamily; profileId?: string }
  | { kind: "file" };
export type BrowserCookieImportErrorCode =
  | "keychain_denied"
  | "full_disk_access"
  | "source_busy"
  | "source_not_found"
  | "invalid_file"
  | "no_cookies"
  | "unsupported_platform"
  | "failed";
export type BrowserCookieImportResult =
  | {
      status: "imported";
      sourceLabel: string;
      profileLabel?: string;
      imported: number;
      skipped: number;
      googleSkipped: number;
      partitionSkipped: number;
      failed: number;
      importedAt: string;
    }
  | { status: "canceled" }
  | { status: "error"; code: BrowserCookieImportErrorCode; message?: string };
export interface BrowserCookieImportReceipt {
  sourceLabel: string;
  profileLabel?: string;
  importedAt: string;
  imported: number;
  skipped: number;
}
export const FAMILIES: readonly BrowserCookieImportFamily[] = [
  "chrome",
  "edge",
  "arc",
  "brave",
  "comet",
  "helium",
  "chromium",
  "firefox",
  "safari",
];
export function parseRequest(raw: unknown): BrowserCookieImportRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.kind === "file" && Object.keys(record).length === 1) return { kind: "file" };
  if (
    record.kind !== "browser" ||
    typeof record.family !== "string" ||
    !FAMILIES.includes(record.family as BrowserCookieImportFamily)
  )
    return null;
  if (
    record.profileId !== undefined &&
    (typeof record.profileId !== "string" ||
      !record.profileId ||
      record.profileId === "." ||
      record.profileId.includes("..") ||
      /[/\\]/.test(record.profileId) ||
      record.profileId.includes("\0"))
  )
    return null;
  if (Object.keys(record).some((key) => !["kind", "family", "profileId"].includes(key)))
    return null;
  return {
    kind: "browser",
    family: record.family as BrowserCookieImportFamily,
    ...(record.profileId === undefined ? {} : { profileId: record.profileId as string }),
  };
}
