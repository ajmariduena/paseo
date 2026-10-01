import { RemoteBrowserPane } from "@/desktop/browser/remote/remote-browser-pane";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}

export function BrowserPane({ browserId, serverId, workspaceId }: BrowserPaneProps) {
  return <RemoteBrowserPane browserId={browserId} serverId={serverId} workspaceId={workspaceId} />;
}
