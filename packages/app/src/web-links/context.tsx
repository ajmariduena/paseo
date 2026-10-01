import { createContext, useCallback, useContext, type ReactNode } from "react";
import { openContentWebLink } from "./open-content-web-link";
import type { WebLinkModifiers } from "./routing";

type OpenInApp = (url: string) => void;

const WebLinkOpenInAppContext = createContext<OpenInApp | null>(null);

/** Gives content inside a workspace a way to open web links in that workspace's browser. */
export function WebLinkOpenInAppProvider({
  openInApp,
  children,
}: {
  openInApp: OpenInApp;
  children: ReactNode;
}) {
  return (
    <WebLinkOpenInAppContext.Provider value={openInApp}>
      {children}
    </WebLinkOpenInAppContext.Provider>
  );
}

export type OpenContentWebLink = (url: string, modifiers?: WebLinkModifiers) => Promise<void>;

export function useOpenContentWebLink(): OpenContentWebLink {
  const openInApp = useContext(WebLinkOpenInAppContext);
  return useCallback(
    (url: string, modifiers?: WebLinkModifiers) =>
      openContentWebLink(url, { openInApp: openInApp ?? undefined, modifiers }),
    [openInApp],
  );
}

/** Markdown `onLinkPress` that routes web links and tells the renderer the press was handled. */
export function useMarkdownWebLinkPress(): (url: string, modifiers?: WebLinkModifiers) => boolean {
  const openWebLink = useOpenContentWebLink();
  return useCallback(
    (url: string, modifiers?: WebLinkModifiers) => {
      void openWebLink(url, modifiers);
      return false;
    },
    [openWebLink],
  );
}
