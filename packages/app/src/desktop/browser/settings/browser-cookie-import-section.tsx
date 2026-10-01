import { useCallback, useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import {
  getDesktopHost,
  type BrowserCookieImportFamily,
  type BrowserCookieImportReceipt,
  type BrowserCookieImportRequest,
  type BrowserCookieImportSource,
} from "@/desktop/host";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import {
  BROWSER_COOKIE_IMPORT_RECEIPT_QUERY_KEY,
  describeCookieImportResult,
} from "./browser-cookie-import-result";

type DetectionState =
  | { status: "loading" }
  | { status: "ready"; sources: BrowserCookieImportSource[] }
  | { status: "error" };

type RunImport = (request: BrowserCookieImportRequest, sourceLabel: string) => Promise<void>;

export function BrowserCookieImportSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const browser = getDesktopHost()?.browser;
  const [detection, setDetection] = useState<DetectionState>({ status: "loading" });
  const [importing, setImporting] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const importInFlightRef = useRef(false);

  const receiptQuery = useFetchQuery({
    queryKey: BROWSER_COOKIE_IMPORT_RECEIPT_QUERY_KEY,
    queryFn: async () => (await browser?.getCookieImportReceipt?.()) ?? null,
    dataShape: "value",
    staleTimeMs: 0,
    enabled: Boolean(browser?.getCookieImportReceipt),
  });
  const receipt = receiptQuery.data ?? null;
  const importedAt = useMemo(() => (receipt ? new Date(receipt.importedAt) : null), [receipt]);
  const timeAgo = useCompactTimeAgo(
    importedAt && !Number.isNaN(importedAt.getTime()) ? importedAt : null,
  );

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      const detect = browser?.detectCookieImportSources;
      if (!open || !detect) {
        return;
      }
      setDetection({ status: "loading" });
      detect().then(
        (sources) => setDetection({ status: "ready", sources }),
        () => setDetection({ status: "error" }),
      );
    },
    [browser],
  );

  const runImport = useCallback<RunImport>(
    async (request, sourceLabel) => {
      const importCookies = browser?.importCookies;
      if (!importCookies || importInFlightRef.current) {
        return;
      }
      importInFlightRef.current = true;
      setImporting(true);
      try {
        const result = await importCookies(request);
        const notice = describeCookieImportResult(result, sourceLabel);
        if (notice) {
          toast.show(t(notice.key, notice.values), { variant: notice.variant });
        }
        if (result.status === "imported" && result.imported > 0) {
          setNeedsReload(true);
        }
        await queryClient.invalidateQueries({ queryKey: BROWSER_COOKIE_IMPORT_RECEIPT_QUERY_KEY });
      } catch {
        toast.error(t("settings.browser.cookieImport.errors.failed"));
      } finally {
        importInFlightRef.current = false;
        setImporting(false);
      }
    },
    [browser, queryClient, t, toast],
  );

  const handleReload = useCallback(async () => {
    setNeedsReload(false);
    await browser?.reloadBrowserGuests?.();
  }, [browser]);

  if (!browser?.importCookies) {
    return null;
  }

  return (
    <SettingsSection title={t("settings.browser.cookieImport.title")}>
      <SettingsCard>
        <SettingsRow
          label={
            receipt ? formatReceiptTitle(receipt) : t("settings.browser.cookieImport.emptyTitle")
          }
          hint={
            receipt
              ? t("settings.browser.cookieImport.receipt", { count: receipt.imported, timeAgo })
              : t("settings.browser.cookieImport.emptyHint")
          }
        >
          <ImportSourceMenu
            detection={detection}
            importing={importing}
            onOpenChange={handleMenuOpenChange}
            onImport={runImport}
          />
        </SettingsRow>
        {needsReload ? (
          <SettingsRow
            label={t("settings.browser.cookieImport.reload.label")}
            hint={t("settings.browser.cookieImport.reload.hint")}
          >
            <Button variant="outline" size="sm" onPress={handleReload}>
              {t("settings.browser.cookieImport.reload.action")}
            </Button>
          </SettingsRow>
        ) : null}
      </SettingsCard>
      <Text style={styles.footnote}>{t("settings.browser.cookieImport.footnote")}</Text>
    </SettingsSection>
  );
}

function formatReceiptTitle(receipt: BrowserCookieImportReceipt): string {
  return receipt.profileLabel
    ? `${receipt.sourceLabel} · ${receipt.profileLabel}`
    : receipt.sourceLabel;
}

function profilesPageId(family: BrowserCookieImportFamily): string {
  return `cookie-import-${family}`;
}

function ImportSourceMenu({
  detection,
  importing,
  onOpenChange,
  onImport,
}: {
  detection: DetectionState;
  importing: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: RunImport;
}) {
  const { t } = useTranslation();
  const sources = useMemo(
    () => (detection.status === "ready" ? detection.sources : []),
    [detection],
  );
  const pages = useMemo<MenuPageDefinition[]>(
    () =>
      sources
        .filter((source) => source.profiles.length > 1)
        .map((source) => ({
          id: profilesPageId(source.family),
          title: source.label,
          content: source.profiles.map((profile) => (
            <SourceItem
              key={profile.id}
              label={profile.label}
              family={source.family}
              profileId={profile.id}
              sourceLabel={source.label}
              onImport={onImport}
            />
          )),
        })),
    [onImport, sources],
  );

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownTrigger disabled={importing} accessibilityRole="button">
        {importing
          ? t("settings.browser.cookieImport.importing")
          : t("settings.browser.cookieImport.importFrom")}
      </DropdownTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        width={260}
        pages={pages}
        sheetTitle={t("settings.browser.cookieImport.importFrom")}
      >
        <DropdownMenuLabel>{t("settings.browser.cookieImport.onThisComputer")}</DropdownMenuLabel>
        {detection.status === "loading" ? (
          <DropdownMenuItem disabled>
            {t("settings.browser.cookieImport.detecting")}
          </DropdownMenuItem>
        ) : null}
        {detection.status === "error" ? (
          <DropdownMenuItem disabled>
            {t("settings.browser.cookieImport.detectFailed")}
          </DropdownMenuItem>
        ) : null}
        {detection.status === "ready" && sources.length === 0 ? (
          <DropdownMenuItem disabled>
            {t("settings.browser.cookieImport.noBrowsers")}
          </DropdownMenuItem>
        ) : null}
        {sources.map((source) =>
          source.profiles.length > 1 ? (
            <DropdownMenuSubTrigger
              key={source.family}
              id={profilesPageId(source.family)}
              value={t("settings.browser.cookieImport.profileCount", {
                count: source.profiles.length,
              })}
            >
              {source.label}
            </DropdownMenuSubTrigger>
          ) : (
            <SourceItem
              key={source.family}
              label={source.label}
              description={
                source.requiresFullDiskAccess
                  ? t("settings.browser.cookieImport.requiresFullDiskAccess")
                  : undefined
              }
              family={source.family}
              profileId={source.profiles[0]?.id}
              sourceLabel={source.label}
              onImport={onImport}
            />
          ),
        )}
        <DropdownMenuSeparator />
        <SourceItem
          label={t("settings.browser.cookieImport.fromFile")}
          sourceLabel={t("settings.browser.cookieImport.fileSource")}
          onImport={onImport}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Without a `family`, the item imports from a JSON file the user picks. */
function SourceItem({
  label,
  description,
  family,
  profileId,
  sourceLabel,
  onImport,
}: {
  label: string;
  description?: string;
  family?: BrowserCookieImportFamily;
  profileId?: string;
  sourceLabel: string;
  onImport: RunImport;
}) {
  const select = useCallback(() => {
    const request: BrowserCookieImportRequest = family
      ? { kind: "browser", family, ...(profileId ? { profileId } : {}) }
      : { kind: "file" };
    void onImport(request, sourceLabel);
  }, [family, onImport, profileId, sourceLabel]);
  return (
    <DropdownMenuItem description={description} onSelect={select}>
      {label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  footnote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
    marginHorizontal: theme.spacing[1],
  },
}));
