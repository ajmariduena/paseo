import type { ToastVariant } from "@/components/toast-host";
import type { BrowserCookieImportErrorCode, BrowserCookieImportResult } from "@/desktop/host";

export const BROWSER_COOKIE_IMPORT_RECEIPT_QUERY_KEY = ["browser-cookie-import-receipt"] as const;

export interface CookieImportNotice {
  variant: ToastVariant;
  key: string;
  values: Record<string, string | number>;
}

const ERROR_KEYS: Record<BrowserCookieImportErrorCode, string> = {
  keychain_denied: "settings.browser.cookieImport.errors.keychainDenied",
  full_disk_access: "settings.browser.cookieImport.errors.fullDiskAccess",
  source_busy: "settings.browser.cookieImport.errors.sourceBusy",
  source_not_found: "settings.browser.cookieImport.errors.sourceNotFound",
  invalid_file: "settings.browser.cookieImport.errors.invalidFile",
  no_cookies: "settings.browser.cookieImport.errors.noCookies",
  unsupported_platform: "settings.browser.cookieImport.errors.unsupportedPlatform",
  failed: "settings.browser.cookieImport.errors.failed",
};

export function describeCookieImportResult(
  result: BrowserCookieImportResult,
  sourceLabel: string,
): CookieImportNotice | null {
  if (result.status === "canceled") {
    return null;
  }
  if (result.status === "error") {
    return { variant: "error", key: ERROR_KEYS[result.code], values: { source: sourceLabel } };
  }
  const source = result.sourceLabel;
  if (result.imported === 0) {
    return {
      variant: "error",
      key: "settings.browser.cookieImport.result.none",
      values: { source },
    };
  }
  const notLoaded = result.failed + result.partitionSkipped;
  if (notLoaded > 0) {
    return {
      variant: "warning",
      key: "settings.browser.cookieImport.result.partial",
      values: { count: result.imported, source, failed: notLoaded },
    };
  }
  if (result.skipped > 0) {
    return {
      variant: "success",
      key: "settings.browser.cookieImport.result.importedWithSkipped",
      values: { count: result.imported, source, skipped: result.skipped },
    };
  }
  return {
    variant: "success",
    key: "settings.browser.cookieImport.result.imported",
    values: { count: result.imported, source },
  };
}
