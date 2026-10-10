import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { validateQuickPrompts, type QuickPrompt } from "@getpaseo/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";

const EMPTY_PROMPTS: QuickPrompt[] = [];

export function useQuickPrompts(serverId: string) {
  const { t } = useTranslation();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  // COMPAT(quickPrompts): added in v0.11.0; remove gate after 2027-04-05 once the daemon floor supports it.
  const supported = useHostFeature(serverId, "quickPrompts");
  const save = useCallback(
    async (prompts: QuickPrompt[]) => {
      if (!connected || !supported) throw new Error(t("quickPrompts.unavailable"));
      validateQuickPrompts(prompts, {
        duplicateIds: t("quickPrompts.duplicateIds"),
        multipleDefaults: t("quickPrompts.multipleDefaults"),
        pinLimit: t("quickPrompts.pinLimit"),
        required: t("quickPrompts.required"),
      });
      const result = await patchConfig({ quickPrompts: prompts });
      if (!result) throw new Error(t("quickPrompts.unavailable"));
    },
    [connected, supported, patchConfig, t],
  );
  return {
    prompts: config?.quickPrompts ?? EMPTY_PROMPTS,
    loaded: config !== null,
    supported,
    connected,
    save,
  };
}
