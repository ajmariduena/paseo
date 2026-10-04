import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSwitch } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";

type SaveState = { status: "idle" } | { status: "pending" } | { status: "failed"; message: string };

const SAVE_IDLE: SaveState = { status: "idle" };

/** "Continue interrupted agents", the host's restart-continuation setting. Off by default. */
export function RestartContinuationSection({
  serverId,
}: {
  serverId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const supportsRestartContinuation = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.restartContinuation === true,
  );
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [saveState, setSaveState] = useState<SaveState>(SAVE_IDLE);

  const handleValueChange = useCallback(
    async (next: boolean) => {
      setSaveState({ status: "pending" });
      try {
        await patchConfig({ continueAfterRestart: next });
        setSaveState(SAVE_IDLE);
      } catch (error) {
        setSaveState({ status: "failed", message: toErrorMessage(error) });
      }
    },
    [patchConfig],
  );
  const handleSwitch = useCallback(
    (next: boolean) => {
      void handleValueChange(next);
    },
    [handleValueChange],
  );

  if (!supportsRestartContinuation) return null;
  let error: string | null = null;
  if (saveState.status === "failed") {
    error = t("settings.host.restartContinuation.updateFailed", { message: saveState.message });
  }

  return (
    <SettingsSection
      title={t("settings.host.restartContinuation.sectionTitle")}
      info={t("settings.host.restartContinuation.sectionInfo")}
      testID="host-page-restart-continuation"
    >
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.host.restartContinuation.title")}
          hint={t("settings.host.restartContinuation.hint")}
          value={config?.continueAfterRestart === true}
          onValueChange={handleSwitch}
          disabled={config === null || saveState.status === "pending"}
          error={error}
          testID="host-page-restart-continuation-switch"
        />
      </SettingsCard>
    </SettingsSection>
  );
}
