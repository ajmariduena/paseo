import { isElectronRuntime } from "@/desktop/host";
import {
  loadAppSettingsFromStorage,
  persistAppSettings,
  type ServiceUrlBehavior,
} from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";
import { askLinkDestination } from "@/utils/ask-link-destination";
import { openExternalUrl } from "@/utils/open-external-url";

export interface OpenServiceUrlOptions {
  openInApp?: (url: string) => void;
}

export async function openServiceUrl(url: string, options?: OpenServiceUrlOptions): Promise<void> {
  const openInApp = options?.openInApp;
  if (!openInApp || !isElectronRuntime()) {
    await openExternalUrl(url);
    return;
  }

  const behavior = await resolveBehavior(url);
  if (behavior === "in-app") {
    openInApp(url);
    return;
  }
  await openExternalUrl(url);
}

async function resolveBehavior(url: string): Promise<Exclude<ServiceUrlBehavior, "ask">> {
  const settings = await loadAppSettingsFromStorage();
  if (settings.serviceUrlBehavior === "in-app" || settings.serviceUrlBehavior === "external") {
    return settings.serviceUrlBehavior;
  }

  const decision = await askLinkDestination({
    title: i18n.t("serviceUrl.title"),
    message: i18n.t("serviceUrl.message", { url }),
    inAppLabel: i18n.t("serviceUrl.inPaseo"),
    externalLabel: i18n.t("serviceUrl.externalBrowser"),
    rememberLabel: i18n.t("serviceUrl.dontAskAgain"),
  });
  if (!decision) {
    return "external";
  }
  if (decision.remember) {
    await persistAppSettings({ serviceUrlBehavior: decision.choice });
  }
  return decision.choice;
}
