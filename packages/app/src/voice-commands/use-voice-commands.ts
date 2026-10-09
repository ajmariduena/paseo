import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { VoiceCommandsSettings } from "@getpaseo/protocol/voice-commands/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { VoiceCommandsApi } from "./form";

export type VoiceCommandsLoadState =
  | { status: "disconnected" }
  | { status: "unsupported" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; settings: VoiceCommandsSettings };

export function voiceCommandsQueryKey(serverId: string) {
  return ["voice-commands-settings", serverId] as const;
}

export function useVoiceCommands(serverId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  // COMPAT(voiceCommands): added in v0.11.1; remove gate after 2027-10-09 once the daemon floor supports it.
  const supported = useHostFeature(serverId, "voiceCommands");
  const available = Boolean(client) && connected && supported;
  const queryKey = useMemo(() => voiceCommandsQueryKey(serverId), [serverId]);

  const query = useFetchQuery({
    queryKey,
    queryFn: () => {
      if (!client) throw new Error(t("settings.voiceCommands.unavailable"));
      return client.getVoiceCommandsSettings();
    },
    // Disabled while offline, so a reconnect re-enables it and refetches the stale settings.
    enabled: available,
    dataShape: "value",
    staleTimeMs: 0,
    retry: false,
  });

  const api = useMemo<VoiceCommandsApi>(() => {
    const requireClient = () => {
      if (!client || !available) throw new Error(t("settings.voiceCommands.unavailable"));
      return client;
    };
    const store = (settings: VoiceCommandsSettings) => {
      queryClient.setQueryData(queryKey, settings);
      return settings;
    };
    return {
      setModel: async (params) => store(await requireClient().setVoiceCommandsModel(params)),
      setKey: async (params) => store(await requireClient().setVoiceCommandsKey(params)),
      test: async (target) => {
        const result = await requireClient().testVoiceCommandsModel(target);
        if (result.settings) store(result.settings);
        return result;
      },
    };
  }, [available, client, queryClient, queryKey, t]);

  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  let state: VoiceCommandsLoadState;
  if (!connected) state = { status: "disconnected" };
  else if (!supported) state = { status: "unsupported" };
  else if (query.data) state = { status: "ready", settings: query.data };
  else if (query.error) state = { status: "error", message: query.error.message };
  else state = { status: "loading" };

  return { state, api, retry };
}
