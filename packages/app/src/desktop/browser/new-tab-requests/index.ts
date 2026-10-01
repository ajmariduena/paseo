import { useEffect } from "react";
import { getDesktopHost, type DesktopBrowserNewTabRequestEvent } from "@/desktop/host";
import {
  collectAllTabs,
  findPaneContainingTab,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { getIsElectron } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";

export type BrowserNewTabRequest = DesktopBrowserNewTabRequestEvent;

export interface ResolvedBrowserNewTabRequest {
  url: string;
  background: boolean;
  opener: { paneId: string; tabId: string };
}

function isAllowedBrowserNewTabUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.href === "about:blank"
    );
  } catch {
    return false;
  }
}

function readDesktopBrowserNewTabRequest(payload: unknown): BrowserNewTabRequest | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Partial<BrowserNewTabRequest>;
  if (typeof candidate.sourceBrowserId !== "string" || !candidate.sourceBrowserId.trim()) {
    return null;
  }
  if (typeof candidate.url !== "string" || !isAllowedBrowserNewTabUrl(candidate.url)) {
    return null;
  }
  return {
    sourceBrowserId: candidate.sourceBrowserId,
    url: candidate.url,
    background: candidate.background === true,
  };
}

function findOpenerTab(input: {
  workspaceLayout: WorkspaceLayout | null | undefined;
  browserId: string;
}): { paneId: string; tabId: string } | null {
  if (!input.workspaceLayout) {
    return null;
  }
  const root = input.workspaceLayout.root;
  const tab = collectAllTabs(root).find(
    (candidate) =>
      candidate.target.kind === "browser" && candidate.target.browserId === input.browserId,
  );
  const pane = tab ? findPaneContainingTab(root, tab.tabId) : null;
  return tab && pane ? { paneId: pane.id, tabId: tab.tabId } : null;
}

export function resolveBrowserNewTabRequest(input: {
  payload: unknown;
  workspaceLayout: WorkspaceLayout | null | undefined;
}): ResolvedBrowserNewTabRequest | null {
  const request = readDesktopBrowserNewTabRequest(input.payload);
  if (!request) {
    return null;
  }
  const opener = findOpenerTab({
    workspaceLayout: input.workspaceLayout,
    browserId: request.sourceBrowserId,
  });
  if (!opener) {
    return null;
  }
  return { url: request.url, background: request.background === true, opener };
}

export function useDesktopBrowserNewTabRequests(input: {
  enabled: boolean;
  workspaceLayout: WorkspaceLayout | null | undefined;
  openRequest: (request: ResolvedBrowserNewTabRequest) => void;
}): void {
  const handleNewTabRequest = useStableEvent((payload: unknown) => {
    const request = resolveBrowserNewTabRequest({
      payload,
      workspaceLayout: input.workspaceLayout,
    });
    if (!request) {
      return;
    }
    input.openRequest(request);
  });

  useEffect(() => {
    if (!input.enabled || !getIsElectron()) {
      return;
    }
    const unsubscribe = getDesktopHost()?.events?.on?.(
      "browser-new-tab-request",
      handleNewTabRequest,
    );
    if (typeof unsubscribe === "function") {
      return unsubscribe;
    }
    return () => {
      void unsubscribe?.then((dispose) => dispose());
    };
  }, [handleNewTabRequest, input.enabled]);
}
