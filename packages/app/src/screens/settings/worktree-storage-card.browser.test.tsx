import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceStorageListResponse } from "@getpaseo/protocol/messages";
import { i18n as testI18n } from "@/i18n/i18next";
import { WorktreeStorageCardView } from "./worktree-storage-card-view";

void testI18n;

const data: WorkspaceStorageListResponse["payload"] = {
  entries: [
    {
      entryId: "owned",
      name: "owned",
      project: "repo",
      sizeBytes: 2 * 1024 * 1024,
      freeable: true,
      reason: "archived",
    },
    {
      entryId: "legacy",
      name: "legacy",
      project: "repo",
      sizeBytes: 3 * 1024 * 1024,
      freeable: false,
      requiresExplicitOptIn: true,
      reason: "Created before ownership tracking",
    },
    {
      entryId: "dirty",
      name: "dirty",
      project: "repo",
      sizeBytes: 1024 * 1024,
      freeable: false,
      reason: "1 uncommitted change",
    },
  ],
  totalBytes: 6 * 1024 * 1024,
  freeableBytes: 2 * 1024 * 1024,
  sizesComplete: true,
  processCheckUnavailableReason: null,
  error: null,
  requestId: "list-1",
};

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
const noopRefresh = () => undefined;
const noopAfterCleanup = async () => undefined;

function removedResults(entryIds: string[]) {
  return entryIds.map((entryId) => ({ entryId, removed: true, error: null }));
}

beforeEach(() => {
  vi.stubGlobal("React", React);
});
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mountCard(
  onCleanup: (
    entryIds: string[],
    legacyEntryIds: string[],
  ) => Promise<{
    results: Array<{ entryId: string; removed: boolean; error: string | null }>;
    error: string | null;
    requestId: string;
  }>,
  cardData = data,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <WorktreeStorageCardView
        data={cardData}
        isPending={false}
        loadError={null}
        onRefresh={noopRefresh}
        onCleanup={onCleanup}
        onAfterCleanup={noopAfterCleanup}
      />,
    ),
  );
  mounted.push({ root, container });
  return within(document.body);
}

describe("worktree storage card", () => {
  it("shows totals and groups, leaves legacy unchecked, and submits only checked IDs", async () => {
    const calls: Array<[string[], string[]]> = [];
    const view = mountCard(async (entryIds, legacyEntryIds) => {
      calls.push([entryIds, legacyEntryIds]);
      return {
        results: removedResults(entryIds),
        error: null,
        requestId: "cleanup-1",
      };
    });
    expect(view.getByTestId("worktree-storage-totals").textContent).toContain(
      "6 MB in 3 worktrees",
    );
    expect(view.getByTestId("worktree-storage-totals").textContent).toContain("2 MB can be freed");

    await act(async () => view.getByTestId("worktree-storage-open").click());
    expect(view.getByText("Will be removed").isConnected).toBe(true);
    expect(view.getByText("Requires your selection").isConnected).toBe(true);
    expect(view.getByText("Kept").isConnected).toBe(true);
    expect(view.getByTestId("worktree-storage-select-owned").textContent).toContain("✓");
    expect(view.getByTestId("worktree-storage-select-legacy").textContent).not.toContain("✓");
    expect(view.getByTestId("worktree-storage-kept-dirty").isConnected).toBe(true);

    await act(async () => view.getByTestId("worktree-storage-select-owned").click());
    await act(async () => view.getByTestId("worktree-storage-select-legacy").click());
    await act(async () => view.getByTestId("worktree-storage-remove").click());
    expect(calls).toEqual([[["legacy"], ["legacy"]]]);
  });

  it("keeps a cleanup failure visible with retry available", async () => {
    const view = mountCard(async () => {
      throw new Error("teardown failed");
    });
    await act(async () => view.getByTestId("worktree-storage-open").click());
    await act(async () => view.getByTestId("worktree-storage-remove").click());
    await waitFor(() => expect(view.getByText("teardown failed").isConnected).toBe(true));
    expect(view.getByTestId("worktree-storage-remove").getAttribute("aria-disabled")).not.toBe(
      "true",
    );
  });

  it("explains why automatic cleanup cannot act without lsof", () => {
    const view = mountCard(async () => ({ results: [], error: null, requestId: "cleanup-1" }), {
      ...data,
      processCheckUnavailableReason: "lsof_missing",
    });
    expect(
      view.getByText("Automatic cleanup cannot run because lsof is not installed on this host.")
        .isConnected,
    ).toBe(true);
  });
});
