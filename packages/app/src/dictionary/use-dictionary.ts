import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { validateDictionary } from "@getpaseo/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { normalizeDictionary, type DictionaryEntries } from "./catalog";

export function useDictionary(serverId: string) {
  const { t } = useTranslation();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  // COMPAT(dictionary): added in v0.11.1; remove gate after 2027-10-09 once the daemon floor supports it.
  const supported = useHostFeature(serverId, "dictionary");
  const dictionary = useMemo(() => normalizeDictionary(config?.dictionary), [config?.dictionary]);
  const save = useCallback(
    async (next: DictionaryEntries) => {
      if (!connected || !supported) throw new Error(t("settings.dictionary.unavailable"));
      validateDictionary(next);
      const result = await patchConfig({ dictionary: next });
      if (!result) throw new Error(t("settings.dictionary.unavailable"));
    },
    [connected, supported, patchConfig, t],
  );
  return { dictionary, loaded: config !== null, supported, connected, save };
}
