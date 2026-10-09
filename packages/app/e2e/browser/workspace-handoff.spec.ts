import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import {
  handoffHosts as hosts,
  openHandoff,
  savedTransfer,
  forgetTransfer,
} from "../support/helpers/workspace-handoff";

test.describe("workspace handoff", () => {
  test.skip(process.platform === "win32", "Ownership release requires POSIX directory durability");

  test("chooses a destination-only reservation and resumes its original mode without a local record", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const host = await hosts(page);
    const firstId = "00000000-0000-4000-8000-000000000001";
    const chosenId = "00000000-0000-4000-8000-000000000002";
    try {
      const query = {
        sourceServerId: host.source.serverId,
        sourceWorkspaceId: host.workspace.workspaceId,
      };
      for (const [transferId, continuationMode] of [
        [firstId, "native"],
        [chosenId, "context"],
      ] as const) {
        const reserved = await host.destinationClient.handoffReserveDestination({
          ...query,
          transferId,
          continuationMode,
          sourceAgentIds: [],
          destinationParent: host.destinationParent,
        });
        expect(reserved.error).toBeNull();
      }
      await openHandoff(page);
      await page.getByTestId("handoff-host-trigger").click();
      await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
      await page.getByTestId("handoff-recovery-trigger").click();
      await expect(page.getByTestId(`handoff-recovery-${firstId}`)).toBeVisible();
      await expect(page.getByTestId(`handoff-recovery-${chosenId}`)).toBeVisible();
      await expect(page.getByTestId(`handoff-recovery-${firstId}`)).toHaveAccessibleName(
        "Keep native sessions",
      );
      await expect(page.getByTestId(`handoff-recovery-${chosenId}`)).toHaveAccessibleName(
        "Continue with exported history",
      );
      await page.screenshot({ path: testInfo.outputPath("handoff-existing-transfers.png") });
      await page.getByTestId(`handoff-recovery-${chosenId}`).click();
      await expect(page.getByText("Continue with exported history", { exact: true })).toBeVisible();
      expect(await savedTransfer(page, host.source.serverId, host.workspace.workspaceId)).toBe(
        chosenId,
      );
      expect(
        (await host.sourceClient.handoffFindSource({ workspaceId: host.workspace.workspaceId }))
          .result,
      ).toBeNull();
      expect((await host.destinationClient.fetchWorkspaces()).entries).toEqual([]);
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
        timeout: 30_000,
      });
      const prepared = await host.destinationClient.handoffGetDestinationStatus({
        transferId: chosenId,
      });
      expect(prepared.result).toMatchObject({
        transferId: chosenId,
        state: "staged",
        continuationMode: "context",
      });
      if (!prepared.result) throw new Error("Missing destination reservation");
      // The source accepted cancellation, but its reply never reached destination cleanup.
      const cancelledAtSource = await host.sourceClient.handoffCancelSource({
        transferId: chosenId,
        destinationServerId: host.destination.serverId,
        reservationId: prepared.result.reservationId,
      });
      expect(cancelledAtSource.error).toBeNull();
      await forgetTransfer(page, host.source.serverId, host.workspace.workspaceId);
      await page.reload();
      await openHandoff(page);
      await page.getByTestId("handoff-host-trigger").click();
      await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
      await page.getByTestId("handoff-recovery-trigger").click();
      await page.getByTestId(`handoff-recovery-${chosenId}`).click();
      await expect(page.getByTestId("handoff-status")).toHaveText(
        "Cancellation is incomplete. Resume to finish cancelling this transfer.",
      );
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-status")).toHaveText(
        "Transfer cancelled. The source can be used again.",
      );
      const remaining = await host.destinationClient.handoffListDestination(query);
      expect(remaining.result?.transfers.map((transfer) => transfer.transferId)).toEqual([firstId]);
    } finally {
      await host.close();
    }
  });

  test("recovers preparation and activation errors, reloads a transfer and finishes with source offline", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const host = await hosts(page);
    try {
      await writeFile(path.join(host.workspace.repoPath, ".gitignore"), ".env\n");
      await writeFile(path.join(host.workspace.repoPath, ".env"), "synthetic-secret\n");
      const terminal = await host.sourceClient.createTerminal(
        host.workspace.repoPath,
        "Preview terminal",
        undefined,
        {
          workspaceId: host.workspace.workspaceId,
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
      );
      expect(terminal.error).toBeNull();
      await openHandoff(page);
      await page.getByTestId("handoff-host-trigger").click();
      await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
      await page.getByTestId("handoff-parent").fill(path.join(host.destinationParent, "missing"));
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-error")).toBeVisible();
      await expect(page.getByTestId("handoff-parent")).toBeEditable();
      await page.getByTestId("handoff-parent").fill(host.destinationParent);
      await writeFile(path.join(host.workspace.repoPath, "CON.txt"), "unsupported filename");
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-error")).toHaveText(
        "Path is not portable between hosts: CON.txt",
      );
      await expect(page.getByTestId("handoff-parent")).toBeEditable();
      await rm(path.join(host.workspace.repoPath, "CON.txt"));
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-review")).toHaveText(
        "This workspace has no conversations.",
      );
      expect((await host.destinationClient.fetchWorkspaces()).entries).toEqual([]);
      await expect(page.getByTestId("handoff-submit")).toHaveText("Prepare transfer");
      await expect(page.getByTestId("handoff-data-review")).toContainText("1 KiB");
      // The shared directory fixture includes README.md alongside our files.
      await expect(page.getByTestId("handoff-data-review")).toContainText("Files: 3");
      await expect(page.getByTestId("handoff-omissions-review")).toHaveText(".env");
      await expect(page.getByTestId("handoff-stopped-work-review")).toContainText(
        "Preview terminal",
      );
      expect(
        (await host.sourceClient.listTerminals(host.workspace.repoPath)).terminals,
      ).toHaveLength(1);
      expect(
        (await host.sourceClient.handoffFindSource({ workspaceId: host.workspace.workspaceId }))
          .result,
      ).toBeNull();
      await page.screenshot({ path: testInfo.outputPath("handoff-preflight-desktop.png") });
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
        timeout: 30_000,
      });
      expect((await host.sourceClient.listTerminals(host.workspace.repoPath)).terminals).toEqual(
        [],
      );
      const transferId = await savedTransfer(
        page,
        host.source.serverId,
        host.workspace.workspaceId,
      );
      await page.screenshot({ path: testInfo.outputPath("handoff-ready-desktop.png") });
      await page.reload();
      await openHandoff(page);
      await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace");
      expect(await savedTransfer(page, host.source.serverId, host.workspace.workspaceId)).toBe(
        transferId,
      );
      const staged = await host.destinationClient.handoffGetDestinationStatus({ transferId });
      if (!staged.result) throw new Error("Missing prepared destination");
      // A real path conflict leaves the accepted release durable but activation unfinished.
      await mkdir(staged.result.destinationCwd);
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-error")).toHaveText(
        "Destination checkout already exists",
      );
      expect(
        (await host.destinationClient.handoffGetDestinationStatus({ transferId })).result?.state,
      ).toBe("released");
      await expect(page.getByTestId("handoff-cancel")).toHaveCount(0);
      await host.source.close();
      await rmdir(staged.result.destinationCwd);
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-status")).toHaveText(
        "Workspace moved. Continue on the destination host.",
      );
      await expect(page.getByTestId("handoff-close-notice")).toHaveCount(0);
      const active = await host.destinationClient.handoffGetDestinationStatus({ transferId });
      expect(active.error).toBeNull();
      expect(active.result?.state).toBe("active");
      if (!active.result) throw new Error("Missing destination");
      await expect(readFile(path.join(active.result.destinationCwd, ".env"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
      expect(
        await readFile(path.join(active.result.destinationCwd, "prior-work.txt"), "utf8"),
      ).toBe("work from the source\n");
      await page.getByTestId("handoff-submit").click();
      await expect(page).toHaveURL(
        new RegExp(`/h/${host.destination.serverId}/workspace/${active.result.workspaceId}`),
      );
      const destinationWorkspace = page.getByTestId(
        `workspace-deck-entry-${host.destination.serverId}:${active.result.workspaceId}`,
      );
      await expect(destinationWorkspace.getByTestId("workspace-header-title")).toBeVisible();
    } finally {
      await host.close();
    }
  });

  test("compact layout recovers explicit context choice after local state loss and cancels", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const host = await hosts(page);
    try {
      await openHandoff(page);
      await page.getByTestId("handoff-host-trigger").click();
      await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
      await page.getByTestId("handoff-parent").fill(host.destinationParent);
      await page.getByTestId("handoff-mode-trigger").click();
      await page.getByText("Continue with exported history", { exact: true }).last().click();
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-review")).toHaveText(
        "This workspace has no conversations.",
      );
      await waitForSettledPosition(page.getByTestId("handoff-submit"));
      await expect(page.getByTestId("handoff-data-review")).toContainText("Files: 2");
      await expect(page.getByTestId("handoff-omissions-review")).toHaveText(
        "No paths match ignore rules.",
      );
      await expect(page.getByTestId("handoff-stopped-work-review")).toContainText(
        "No open terminals.",
      );
      await page.getByTestId("handoff-stop-notice").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("handoff-stop-notice")).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId("handoff-submit")).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath("handoff-review-compact.png") });
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
        timeout: 30_000,
      });
      const transferId = await savedTransfer(
        page,
        host.source.serverId,
        host.workspace.workspaceId,
      );
      await forgetTransfer(page, host.source.serverId, host.workspace.workspaceId);
      await page.reload();
      await openHandoff(page);
      await expect(page.getByText("Continue with exported history", { exact: true })).toBeVisible();
      expect(await savedTransfer(page, host.source.serverId, host.workspace.workspaceId)).toBe(
        transferId,
      );
      // Visibility alone also passes while the new sheet is still below the viewport.
      await page.getByTestId("handoff-cancel").click({ trial: true });
      await waitForSettledPosition(page.getByTestId("handoff-cancel"));
      await expect(page.getByTestId("handoff-status")).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("handoff-ready-compact.png") });
      await page.getByTestId("handoff-cancel").click();
      await expect(page.getByTestId("handoff-status")).toHaveText(
        "Transfer cancelled. The source can be used again.",
      );
      await expect(page.getByTestId("handoff-close-notice")).toHaveCount(0);
      const cancelled = await host.destinationClient.handoffGetDestinationStatus({ transferId });
      expect(cancelled.result?.state).toBe("cancelled");
      expect(await readFile(path.join(host.workspace.repoPath, "prior-work.txt"), "utf8")).toBe(
        "work from the source\n",
      );
      await forgetTransfer(page, host.source.serverId, host.workspace.workspaceId);
      await page.reload();
      await openHandoff(page);
      await expect(page.getByTestId("handoff-parent")).toBeEditable();
    } finally {
      await host.close();
    }
  });
});
