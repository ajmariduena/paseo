import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import React from "react";
import type { ToastApi } from "@/components/toast-host";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { useOpenContentWebLink, type OpenContentWebLink } from "@/web-links/context";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkContext, GetDirectorySuggestions } from "./resolver";

export interface AssistantFileLinkDaemonClient {
  getDirectorySuggestions: GetDirectorySuggestions;
  listDirectory?: (cwd: string, path: string) => Promise<unknown>;
}

export interface AssistantFileLinkResolverConfig {
  client?: AssistantFileLinkDaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
  openWebLink?: OpenContentWebLink;
}

export interface AssistantFileLinkResolverProviderProps extends AssistantFileLinkResolverConfig {
  children: ReactNode;
}

export interface AssistantFileLinkResolverContextValue {
  configRef: MutableRefObject<AssistantFileLinkResolverConfig>;
  getDirectorySuggestions: GetDirectorySuggestions;
  isDirectory: (path: string) => Promise<boolean>;
}

const AssistantFileLinkResolverContext =
  createContext<AssistantFileLinkResolverContextValue | null>(null);

export function AssistantFileLinkResolverProvider({
  client,
  serverId,
  workspaceRoot,
  onOpenWorkspaceFile,
  toast,
  children,
}: AssistantFileLinkResolverProviderProps) {
  const openWebLink = useOpenContentWebLink();
  const configRef = useRef<AssistantFileLinkResolverConfig>({
    client,
    serverId,
    workspaceRoot,
    onOpenWorkspaceFile,
    toast,
    openWebLink,
  });
  configRef.current = { client, serverId, workspaceRoot, onOpenWorkspaceFile, toast, openWebLink };

  const getDirectorySuggestions = useCallback<GetDirectorySuggestions>(async (input) => {
    const activeClient = configRef.current.client;
    if (!activeClient) {
      return { entries: [], error: null };
    }

    const result = await activeClient.getDirectorySuggestions(input);
    return { entries: result.entries, error: result.error };
  }, []);

  const isDirectory = useCallback(async (path: string) => {
    const { client: activeClient, workspaceRoot: activeRoot } = configRef.current;
    if (!activeClient?.listDirectory || !activeRoot) {
      return false;
    }
    try {
      await activeClient.listDirectory(activeRoot, path);
      return true;
    } catch {
      return false;
    }
  }, []);

  const value = useMemo<AssistantFileLinkResolverContextValue>(
    () => ({ configRef, getDirectorySuggestions, isDirectory }),
    [getDirectorySuggestions, isDirectory],
  );

  return (
    <AssistantFileLinkResolverContext.Provider value={value}>
      {children}
    </AssistantFileLinkResolverContext.Provider>
  );
}

export function useAssistantFileLinkResolverContext(): AssistantFileLinkResolverContextValue {
  const context = useContext(AssistantFileLinkResolverContext);
  if (!context) {
    throw new Error("AssistantFileLinkResolverProvider is required for assistant file links.");
  }
  return context;
}

export type { AssistantFileLinkContext };
