import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { isElectronRuntimeMac } from "@/desktop/host";
import { useAppSettings, type ServiceUrlBehavior } from "@/hooks/use-settings";

const LINK_BEHAVIORS: readonly ServiceUrlBehavior[] = ["ask", "in-app", "external"];

const LINK_BEHAVIOR_LABEL_KEYS: Record<ServiceUrlBehavior, string> = {
  ask: "settings.general.serviceUrls.options.ask",
  "in-app": "settings.general.serviceUrls.options.inApp",
  external: "settings.general.serviceUrls.options.external",
};

export function BrowserLinksSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const options = useMemo(
    () => LINK_BEHAVIORS.map((value) => ({ value, label: t(LINK_BEHAVIOR_LABEL_KEYS[value]) })),
    [t],
  );
  const changeWebLinks = useCallback(
    (webLinkBehavior: ServiceUrlBehavior) => void updateSettings({ webLinkBehavior }),
    [updateSettings],
  );
  const changeServiceUrls = useCallback(
    (serviceUrlBehavior: ServiceUrlBehavior) => void updateSettings({ serviceUrlBehavior }),
    [updateSettings],
  );
  const changeInvert = useCallback(
    (invertWebLinkModifier: boolean) => void updateSettings({ invertWebLinkModifier }),
    [updateSettings],
  );
  const shortcut = isElectronRuntimeMac() ? "⇧⌘" : "Shift+Ctrl";

  return (
    <SettingsSection title={t("settings.browser.links.title")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.browser.links.webLinks.label")}
          hint={t("settings.browser.links.webLinks.hint")}
          value={settings.webLinkBehavior}
          options={options}
          onValueChange={changeWebLinks}
        />
        <SettingsSelect
          label={t("settings.browser.links.serviceUrls.label")}
          hint={t("settings.browser.links.serviceUrls.hint")}
          value={settings.serviceUrlBehavior}
          options={options}
          onValueChange={changeServiceUrls}
        />
        <SettingsSwitch
          label={t("settings.browser.links.invert.label", { shortcut })}
          hint={
            settings.webLinkBehavior === "ask"
              ? t("settings.browser.links.invert.hintAsk")
              : t("settings.browser.links.invert.hint")
          }
          value={settings.invertWebLinkModifier}
          onValueChange={changeInvert}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
