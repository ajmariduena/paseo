import { describe, expect, it } from "vitest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import { createDefaultLayout } from "@/stores/workspace-layout-store";
import { FOCUSED_PANE_PLACEMENT, openTabInLayoutFocused } from "@/stores/workspace-layout-actions";
import { collectAllPanes } from "@/stores/workspace-layout-actions";
import { resolveBrowserNewTabRequest } from ".";

function createLayoutWithBrowser(browserId: string): WorkspaceLayout {
  return openTabInLayoutFocused({
    layout: createDefaultLayout(),
    target: { kind: "browser", browserId },
    now: 1,
    placement: FOCUSED_PANE_PLACEMENT,
    explorerSidebarPaneId: null,
  })!.layout;
}

describe("browser new-tab requests", () => {
  it("accepts desktop requests from browser tabs in the current workspace", () => {
    const request = resolveBrowserNewTabRequest({
      payload: {
        sourceBrowserId: "browser-1",
        url: "https://example.com/target",
      },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    });

    const layout = createLayoutWithBrowser("browser-1");
    const [pane] = collectAllPanes(layout.root);
    expect(request).toEqual({
      url: "https://example.com/target",
      background: false,
      opener: { paneId: pane.id, tabId: pane.tabIds[0] },
    });
  });

  it("keeps background intent from middle and modifier clicks", () => {
    const request = resolveBrowserNewTabRequest({
      payload: {
        sourceBrowserId: "browser-1",
        url: "https://example.com/target",
        background: true,
      },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    });

    expect(request?.background).toBe(true);
  });

  it("ignores desktop requests from another workspace", () => {
    const request = resolveBrowserNewTabRequest({
      payload: {
        sourceBrowserId: "browser-from-other-workspace",
        url: "https://example.com/target",
      },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    });

    expect(request).toBeNull();
  });

  it("rejects unsupported desktop request URLs", () => {
    const request = resolveBrowserNewTabRequest({
      payload: {
        sourceBrowserId: "browser-1",
        url: "file:///etc/passwd",
      },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    });

    expect(request).toBeNull();
  });
});
