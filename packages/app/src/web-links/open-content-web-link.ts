import { isElectronRuntime, isElectronRuntimeMac } from "@/desktop/host";
import { loadAppSettingsFromStorage, persistAppSettings } from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";
import { askLinkDestination, type LinkDestinationDecision } from "@/utils/ask-link-destination";
import { isHttpUrl } from "@/utils/http-url";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  isAlternateWebLinkChord,
  resolveWebLinkDestination,
  type WebLinkDestination,
  type WebLinkModifiers,
} from "./routing";

export interface OpenContentWebLinkOptions {
  openInApp?: (url: string) => void;
  modifiers?: WebLinkModifiers;
}

let pendingDecision: Promise<LinkDestinationDecision | null> | null = null;

export async function openContentWebLink(
  url: string,
  options: OpenContentWebLinkOptions = {},
): Promise<void> {
  if (!isHttpUrl(url)) {
    return;
  }
  const openInApp = options.openInApp;
  if (!openInApp || !isElectronRuntime()) {
    await openExternalUrl(url);
    return;
  }

  const destination = await resolveDestination(url, options.modifiers);
  if (destination === "in-app") {
    openInApp(url);
    return;
  }
  await openExternalUrl(url);
}

async function resolveDestination(
  url: string,
  modifiers: WebLinkModifiers | undefined,
): Promise<WebLinkDestination> {
  const settings = await loadAppSettingsFromStorage();
  const destination = resolveWebLinkDestination({
    behavior: settings.webLinkBehavior,
    invertModifier: settings.invertWebLinkModifier,
    alternateChord: isAlternateWebLinkChord(modifiers, isElectronRuntimeMac()),
  });
  if (destination !== "ask") {
    return destination;
  }
  const decision = await askOnce(url);
  return decision?.choice ?? "external";
}

// Clicks that land while the dialog is open share its answer instead of stacking dialogs.
function askOnce(url: string): Promise<LinkDestinationDecision | null> {
  if (pendingDecision) {
    return pendingDecision;
  }
  pendingDecision = askLinkDestination({
    title: i18n.t("webLink.title"),
    message: i18n.t("webLink.message", { url }),
    inAppLabel: i18n.t("webLink.inPaseo"),
    externalLabel: i18n.t("webLink.externalBrowser"),
    rememberLabel: i18n.t("webLink.dontAskAgain"),
  })
    .then(async (decision) => {
      if (decision?.remember) {
        await persistAppSettings({ webLinkBehavior: decision.choice });
      }
      return decision;
    })
    .finally(() => {
      pendingDecision = null;
    });
  return pendingDecision;
}
