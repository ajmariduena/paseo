import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { pressDirectNewTabShortcut } from "../support/helpers/launcher";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { openChangesPanel } from "../support/helpers/workspace-tabs";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { wsRoutePatternForPort } from "../support/helpers/daemon-port";
import { composerLocator } from "../support/helpers/composer";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import {
  handoffHosts as hosts,
  openHandoff,
  savedTransfer,
  forgetTransfer,
  reconnectSourceDestination,
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
      await page
        .getByTestId("handoff-sheet")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(page.getByTestId("handoff-source-state")).toContainText(
        "Continue on Destination VPS",
      );
      await page.getByTestId("handoff-source-open").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Resume");
      await expect(page).toHaveURL(new RegExp(host.route));
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

  test("resolves an unsaved file conflict and waits for its save before capturing the workspace", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const host = await hosts(page);
    const filePath = path.join(host.workspace.repoPath, "prior-work.txt");
    const editor = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .locator(".cm-content");
    try {
      const gate = await installDaemonWebSocketGate(
        page,
        wsRoutePatternForPort(host.source.endpoint.split(":").at(-1)!),
      );
      await page.reload();
      await openFileExplorer(page);
      await openFileFromExplorer(page, "prior-work.txt");
      // Delay the real write so the disk change reliably wins its revision check.
      gate.holdNextClientRequest("fs.file.write.request");
      await editor.fill("local work to preserve\n");
      await gate.waitForHeldClientRequest();
      await writeFile(filePath, "external work\n");
      gate.releaseHeldClientRequest();
      await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
      await openHandoff(page);
      await page.getByTestId("handoff-host-trigger").click();
      await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
      await page.getByTestId("handoff-parent").fill(host.destinationParent);
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-unsaved-files")).toContainText("prior-work.txt");
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-error")).toHaveText(
        "Save or resolve changes in prior-work.txt, then resume the transfer.",
      );
      expect(
        (await host.sourceClient.handoffFindSource({ workspaceId: host.workspace.workspaceId }))
          .result,
      ).toBeNull();
      expect(
        (
          await host.destinationClient.handoffListDestination({
            sourceServerId: host.source.serverId,
            sourceWorkspaceId: host.workspace.workspaceId,
          })
        ).result?.transfers,
      ).toEqual([]);
      expect(await readFile(filePath, "utf8")).toBe("external work\n");
      await page.screenshot({ path: testInfo.outputPath("handoff-unsaved-file-error.png") });
      await page
        .getByTestId("handoff-sheet")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(editor).toBeEditable();
      await expect(editor).toContainText("local work to preserve");
      await page.getByRole("button", { name: "Overwrite", exact: true }).click();
      await expect.poll(() => readFile(filePath, "utf8")).toBe("local work to preserve\n");
      await expect(page.getByLabel("Editor status clean")).toBeVisible();
      gate.holdNextClientRequest("fs.file.write.request");
      await editor.fill("saved before the move\n");
      await gate.waitForHeldClientRequest();
      await openHandoff(page);
      await page.getByTestId("handoff-host-trigger").click();
      await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
      await page.getByTestId("handoff-parent").fill(host.destinationParent);
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Prepare transfer");
      await page.getByTestId("handoff-submit").click();
      await expect(editor).not.toBeEditable();
      expect(
        (await host.sourceClient.handoffFindSource({ workspaceId: host.workspace.workspaceId }))
          .result,
      ).toBeNull();
      gate.releaseHeldClientRequest();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
        timeout: 30_000,
      });
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Open destination", {
        timeout: 30_000,
      });
      const transferId = await savedTransfer(
        page,
        host.source.serverId,
        host.workspace.workspaceId,
      );
      const destination = await host.destinationClient.handoffGetDestinationStatus({ transferId });
      expect(destination.result?.state).toBe("active");
      if (!destination.result) throw new Error("Missing destination record");
      expect(
        await readFile(path.join(destination.result.destinationCwd, "prior-work.txt"), "utf8"),
      ).toBe("saved before the move\n");
    } finally {
      await host.close();
    }
  });

  test("keeps source files readable while editing, Git and scripts are held until cancellation", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const host = await hosts(page, {
      git: true,
      repo: {
        withRemote: false,
        files: [{ path: "file.ts", content: "export const value = 1;\n" }],
        paseoConfig: {
          scripts: {
            check: {
              type: "task",
              command: "node -e \"require('fs').writeFileSync('script-ran.txt', 'ran')\"",
            },
          },
        },
      },
    });
    const editor = page
      .getByTestId("file-source-editor")
      .filter({ visible: true })
      .locator(".cm-content");
    try {
      await openFileExplorer(page);
      await openFileFromExplorer(page, "file.ts");
      await editor.fill("export const value = 2;\n");
      await expect
        .poll(() => readFile(path.join(host.workspace.repoPath, "file.ts"), "utf8"))
        .toBe("export const value = 2;\n");
      await openHandoff(page);
      await page.getByTestId("handoff-host-trigger").click();
      await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
      await page.getByTestId("handoff-parent").fill(host.destinationParent);
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Prepare transfer");
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
        timeout: 30_000,
      });
      await page
        .getByTestId("handoff-sheet")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(editor).not.toBeEditable();
      await expect(editor).toContainText("export const value = 2;");
      await editor.press("ControlOrMeta+s");
      await page.reload();
      await expect(editor).not.toBeEditable();
      await expect(editor).toContainText("export const value = 2;");
      await writeFile(path.join(host.workspace.repoPath, "file.ts"), "export const value = 7;\n");
      await expect(editor).toContainText("export const value = 7;");
      await expect(editor).not.toBeEditable();
      await openFileExplorer(page);
      await expect(page.getByTestId("files-new-file")).toHaveCount(0);
      await expect(page.getByTestId("files-new-folder")).toHaveCount(0);
      await page
        .getByTestId("file-explorer-tree-scroll")
        .getByText("file.ts", { exact: true })
        .click({ button: "right" });
      await expect(page.getByText("Rename", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Duplicate", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Delete", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Copy path", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await openChangesPanel(page);
      await expect(page.getByTestId("diff-file-0")).toBeVisible();
      await expect(page.getByTestId("diff-file-0-revert")).toHaveCount(0);
      await expect(
        page.getByTestId("changes-primary-cta").filter({ visible: true }).first(),
      ).toBeDisabled();
      await page.getByTestId("workspace-scripts-button").click();
      await expect(page.getByTestId("workspace-scripts-start-check")).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.screenshot({ path: testInfo.outputPath("handoff-source-mutations-held.png") });
      await page.getByTestId("handoff-source-open").click();
      await page.getByTestId("handoff-cancel").click();
      await expect(page.getByTestId("handoff-status")).toHaveText(
        "Transfer cancelled. The source can be used again.",
      );
      await page
        .getByTestId("handoff-sheet")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(
        page.getByTestId("changes-primary-cta").filter({ visible: true }).first(),
      ).toBeEnabled();
      await openFileExplorer(page);
      await expect(page.getByTestId("files-new-file")).toBeVisible();
      await openFileFromExplorer(page, "file.ts");
      await expect(editor).toBeEditable();
      await editor.fill("export const value = 3;\n");
      await expect
        .poll(() => readFile(path.join(host.workspace.repoPath, "file.ts"), "utf8"))
        .toBe("export const value = 3;\n");
      await page.getByTestId("workspace-scripts-button").click();
      await page.getByTestId("workspace-scripts-start-check").click();
      await expect
        .poll(async () => {
          try {
            return await readFile(path.join(host.workspace.repoPath, "script-ran.txt"), "utf8");
          } catch {
            return null;
          }
        })
        .toBe("ran");
    } finally {
      await host.close();
    }
  });

  test("source destination link reports an unpaired host and retries the same workspace", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const host = await hosts(page);
    try {
      await openHandoff(page);
      await page.getByTestId("handoff-host-trigger").click();
      await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
      await page.getByTestId("handoff-parent").fill(host.destinationParent);
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Prepare transfer");
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
        timeout: 30_000,
      });
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Open destination", {
        timeout: 30_000,
      });
      const transferId = await savedTransfer(
        page,
        host.source.serverId,
        host.workspace.workspaceId,
      );
      const destination = await host.destinationClient.handoffGetDestinationStatus({ transferId });
      if (!destination.result) throw new Error("Missing active destination");
      await page
        .getByTestId("handoff-sheet")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(page.getByTestId("handoff-source-state")).toContainText(
        "Continue on Destination VPS",
      );
      await page.reload();
      await expect(page.getByTestId("workspace-new-tab-agent")).toBeDisabled();
      await expect(page.getByTestId("workspace-new-tab-terminal")).toBeDisabled();
      await expect(page.getByTestId("workspace-new-tab-terminal-profile:claude")).toBeDisabled();
      await pressDirectNewTabShortcut(page, "a");
      await pressDirectNewTabShortcut(page, "t");
      await expect(page.getByTestId("workspace-new-tab-panel")).toBeVisible();
      await expect(composerLocator(page)).toHaveCount(0);
      expect((await host.sourceClient.listTerminals(host.workspace.repoPath)).terminals).toEqual(
        [],
      );
      await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
      await expect(page.getByTestId("workspace-new-tab-menu-agent")).toBeDisabled();
      await expect(page.getByTestId("workspace-new-tab-menu-terminal")).toBeDisabled();
      await expect(
        page.getByTestId("workspace-new-tab-menu-terminal-profile:claude"),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.screenshot({ path: testInfo.outputPath("handoff-source-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("handoff-source-open")).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath("handoff-source-compact.png") });
      await page.setViewportSize({ width: 1280, height: 720 });
      await reconnectSourceDestination(page, host, destination.result.workspaceId);
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
      await page.getByTestId("workspace-new-tab-agent").click();
      await composerLocator(page).fill("Keep this unsent source draft");
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
      await expect(page.getByTestId("handoff-source-state")).toContainText(
        "read-only while the move to Destination VPS is prepared",
      );
      await expect(composerLocator(page)).toHaveCount(0);
      await page.getByTestId("workspace-header-menu-trigger").click();
      await expect(page.getByTestId("workspace-header-new-agent")).toBeDisabled();
      await expect(page.getByTestId("workspace-header-new-terminal")).toBeDisabled();
      await expect(page.getByTestId("workspace-header-import-agent")).toBeDisabled();
      await page
        .getByRole("button", { name: "Bottom sheet backdrop", exact: true })
        .click({ position: { x: 8, y: 8 } });
      await expect(page.getByTestId("workspace-header-menu")).toHaveCount(0);
      await page.getByTestId("handoff-source-open").click();
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
      await expect(page.getByTestId("handoff-source-state")).toHaveCount(0);
      const cancelled = await host.destinationClient.handoffGetDestinationStatus({ transferId });
      expect(cancelled.result?.state).toBe("cancelled");
      expect(await readFile(path.join(host.workspace.repoPath, "prior-work.txt"), "utf8")).toBe(
        "work from the source\n",
      );
      await forgetTransfer(page, host.source.serverId, host.workspace.workspaceId);
      await page.reload();
      await expect(composerLocator(page)).toHaveValue("Keep this unsent source draft");
      await expect(composerLocator(page)).toBeEditable();
      await page.getByTestId("workspace-header-menu-trigger").click();
      await expect(page.getByTestId("workspace-header-new-agent")).toBeEnabled();
      await expect(page.getByTestId("workspace-header-new-terminal")).toBeEnabled();
      await expect(page.getByTestId("workspace-header-import-agent")).toBeEnabled();
      await page.getByTestId("workspace-header-new-terminal").click();
      await expect
        .poll(
          async () =>
            (await host.sourceClient.listTerminals(host.workspace.repoPath)).terminals.length,
        )
        .toBe(1);
      await openHandoff(page);
      await expect(page.getByTestId("handoff-parent")).toBeEditable();
    } finally {
      await host.close();
    }
  });
});
