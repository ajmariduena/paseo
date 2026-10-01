// Adapted from stablyai/orca (MIT).
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "electron";
import { openCookieAdapter, replaceCookies, type CookieAdapter } from "./cdp.js";
import { parseJsonCookies, planCookies, type SourceCookie } from "./policy.js";
import { readSourceCookies, selectedSource, SourceError } from "./sources.js";
import type {
  BrowserCookieImportReceipt,
  BrowserCookieImportRequest,
  BrowserCookieImportResult,
} from "./types.js";

const locks = new WeakMap<object, Promise<void>>();
export async function withCookieImportLock<T>(
  session: object,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(session) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(session, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(session) === tail) locks.delete(session);
  }
}
function receiptPath(userData: string): string {
  return join(userData, "browser-cookie-import-receipt.json");
}
export function getReceipt(userData: string): BrowserCookieImportReceipt | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(receiptPath(userData), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const item = parsed as Record<string, unknown>;
    if (
      typeof item.sourceLabel !== "string" ||
      typeof item.importedAt !== "string" ||
      typeof item.imported !== "number" ||
      typeof item.skipped !== "number" ||
      (item.profileLabel !== undefined && typeof item.profileLabel !== "string")
    )
      return null;
    return {
      sourceLabel: item.sourceLabel,
      ...(typeof item.profileLabel === "string" ? { profileLabel: item.profileLabel } : {}),
      importedAt: item.importedAt,
      imported: item.imported,
      skipped: item.skipped,
    };
  } catch {
    return null;
  }
}
function writeReceipt(userData: string, receipt: BrowserCookieImportReceipt): void {
  const target = receiptPath(userData);
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Renamed or failed before creation. */
    }
  }
}
export function deleteReceipt(userData: string): void {
  try {
    unlinkSync(receiptPath(userData));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export interface ImportContext {
  session: Session;
  userData: string;
  filePath?: string;
  openAdapter?: (session: Session) => Promise<CookieAdapter>;
  log: (stage: string, fields: Record<string, string | number>) => void;
}
interface PreparedSource {
  sourceLabel: string;
  profileLabel?: string;
  raw: { cookies: SourceCookie[]; total: number };
}
async function prepareSource(
  request: BrowserCookieImportRequest,
  filePath?: string,
): Promise<PreparedSource | BrowserCookieImportResult> {
  if (request.kind === "file") {
    if (!filePath) return { status: "canceled" };
    let file: string;
    try {
      file = readFileSync(filePath, "utf8");
    } catch {
      return { status: "error", code: "invalid_file" };
    }
    const parsed = parseJsonCookies(file);
    return parsed
      ? { sourceLabel: "JSON file", raw: parsed }
      : { status: "error", code: "invalid_file" };
  }
  if (
    (request.family === "safari" || request.family === "arc" || request.family === "helium") &&
    process.platform !== "darwin"
  ) {
    return { status: "error", code: "unsupported_platform" };
  }
  const selection = selectedSource(request.family, request.profileId);
  if (!selection) return { status: "error", code: "source_not_found" };
  return {
    sourceLabel: selection.source.label,
    profileLabel: selection.profile.label,
    raw: await readSourceCookies(selection.source, selection.profile.path),
  };
}
export async function importCookies(
  request: BrowserCookieImportRequest,
  context: ImportContext,
): Promise<BrowserCookieImportResult> {
  return withCookieImportLock(context.session, async () => {
    const family = request.kind === "browser" ? request.family : "file";
    context.log("prepare", { family });
    try {
      const prepared = await prepareSource(request, context.filePath);
      if ("status" in prepared) return prepared;
      const { sourceLabel, profileLabel, raw } = prepared;
      if (!raw.total) return { status: "error", code: "no_cookies" };
      const plan = planCookies(raw.cookies);
      const skipped = raw.total - plan.writes.length - plan.googleSkipped - plan.partitionSkipped;
      context.log("planned", {
        family,
        total: raw.total,
        writes: plan.writes.length,
        skipped,
        googleSkipped: plan.googleSkipped,
        partitionSkipped: plan.partitionSkipped,
        domainCount: new Set(plan.writes.map((cookie) => cookie.domain)).size,
      });
      let imported = 0,
        failed = 0;
      if (plan.writes.length) {
        const adapter = await (context.openAdapter ?? openCookieAdapter)(context.session);
        try {
          const result = await replaceCookies(
            adapter,
            plan.writes,
            request.kind !== "browser" ||
              request.family === "firefox" ||
              request.family === "safari",
          );
          imported = result.imported;
          failed = result.failed;
          context.log("written", { family, imported, failed, domainCount: result.domainCount });
        } finally {
          adapter.close();
        }
      }
      const importedAt = new Date().toISOString();
      const result: BrowserCookieImportResult = {
        status: "imported",
        sourceLabel,
        ...(profileLabel ? { profileLabel } : {}),
        imported,
        skipped,
        googleSkipped: plan.googleSkipped,
        partitionSkipped: plan.partitionSkipped,
        failed,
        importedAt,
      };
      if (imported > 0)
        writeReceipt(context.userData, {
          sourceLabel,
          ...(profileLabel ? { profileLabel } : {}),
          importedAt,
          imported,
          skipped,
        });
      return result;
    } catch (error) {
      const code = error instanceof SourceError ? error.code : "failed";
      context.log("error", { family, code });
      return { status: "error", code };
    }
  });
}
