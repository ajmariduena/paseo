import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useBrowserStore } from "@/desktop/browser/store";
import { getIsElectron } from "@/constants/platform";

export function useRemoteBrowserTabsSupported(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.browserScreencast === true,
  );
}

/** Electron hosts its own tabs; other clients need a daemon that reaches a desktop browser. */
export function useCanCreateBrowserTab(serverId: string): boolean {
  const remoteSupported = useRemoteBrowserTabsSupported(serverId);
  return getIsElectron() || remoteSupported;
}

/** Opens a browser tab on the connected desktop app and hands its ID to `open`. */
export function useCreateRemoteBrowserTab(input: { serverId: string; workspaceId: string }) {
  const { serverId, workspaceId } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);

  return useCallback(
    async (open: (target: { kind: "browser"; browserId: string }) => void, url?: string) => {
      if (!client || !workspaceId) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return;
      }
      try {
        const reply = await client.executeBrowserRemoteCommand({
          workspaceId,
          command: { command: "new_tab", args: url ? { url } : {} },
        });
        if (!reply.ok || reply.result?.command !== "new_tab") {
          toast.error(
            reply.error?.code === "browser_no_host"
              ? t("workspace.browser.remote.errors.noDesktop")
              : t("workspace.browser.remote.newTabFailed"),
          );
          return;
        }
        useBrowserStore.getState().adoptBrowser(reply.result.browserId, {
          initialUrl: reply.result.url,
        });
        open({ kind: "browser", browserId: reply.result.browserId });
      } catch {
        toast.error(t("workspace.browser.remote.newTabFailed"));
      }
    },
    [client, t, toast, workspaceId],
  );
}
