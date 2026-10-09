import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test, type Page } from "../support/fixtures";
import { startTestDaemon } from "../support/helpers/daemon-update";
import { addScheduleHostAndReload } from "../support/helpers/schedule-host";
import { seedWorkspace } from "../support/helpers/seed-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";

async function openHandoff(page: Page) {
  await page.getByTestId("workspace-header-menu-trigger").click();
  await page.getByTestId("workspace-header-handoff").click();
  await expect(page.getByTestId("handoff-sheet")).toBeVisible();
}

async function hosts(page: Page) {
  const cleanupSteps: (() => Promise<unknown>)[] = [];
  async function close() {
    const errors: unknown[] = [];
    for (const cleanup of cleanupSteps.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Handoff test cleanup failed");
  }
  try {
    const source = await startTestDaemon({ version: "0.11.1", workspaceHandoffCapability: true });
    cleanupSteps.push(() => source.close());
    const destination = await startTestDaemon({
      version: "0.11.1",
      workspaceHandoffCapability: true,
    });
    cleanupSteps.push(() => destination.close());
    const sourcePort = Number(source.endpoint.split(":").at(-1));
    const destinationPort = Number(destination.endpoint.split(":").at(-1));
    const workspace = await seedWorkspace({
      repoPrefix: "handoff-browser-",
      git: false,
      port: sourcePort,
    });
    cleanupSteps.push(() => workspace.cleanup());
    const destinationParent = await mkdtemp(path.join(tmpdir(), "handoff-browser-destination-"));
    cleanupSteps.push(() => rm(destinationParent, { recursive: true, force: true }));
    const destinationClient = await connectDaemonClient<DaemonClient>({
      port: destinationPort,
      clientIdPrefix: "handoff-browser",
    });
    cleanupSteps.push(() => destinationClient.close());
    cleanupSteps.push(async () => {
      const projects = await destinationClient.listProjects();
      for (const project of projects.projects)
        await destinationClient.removeProject(project.projectId);
    });
    await writeFile(path.join(workspace.repoPath, "prior-work.txt"), "work from the source\n");
    await gotoAppShell(page);
    await addScheduleHostAndReload({
      page,
      serverId: source.serverId,
      port: sourcePort,
      label: "Source laptop",
    });
    await addScheduleHostAndReload({
      page,
      serverId: destination.serverId,
      port: destinationPort,
      label: "Destination VPS",
    });
    const route = `/h/${encodeURIComponent(source.serverId)}/workspace/${encodeURIComponent(workspace.workspaceId)}`;
    await page.goto(route);
    return { source, destination, workspace, destinationParent, destinationClient, route, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function savedTransfer(page: Page, sourceServerId: string, workspaceId: string) {
  const key = `paseo:workspace-handoff:${JSON.stringify([sourceServerId, workspaceId])}`;
  return page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    if (!raw) throw new Error("No saved handoff");
    const value: { transferId: string } = JSON.parse(raw);
    return value.transferId;
  }, key);
}

async function forgetTransfer(page: Page, sourceServerId: string, workspaceId: string) {
  const key = `paseo:workspace-handoff:${JSON.stringify([sourceServerId, workspaceId])}`;
  await page.evaluate((storageKey) => localStorage.removeItem(storageKey), key);
}

test.describe("workspace handoff", () => {
  test.skip(process.platform === "win32", "Ownership release requires POSIX directory durability");

  test("recovers preparation and activation errors, reloads a transfer and finishes with source offline", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const host = await hosts(page);
    try {
      await openHandoff(page);
      await page.getByTestId("handoff-host-trigger").click();
      await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
      await page.getByTestId("handoff-parent").fill(path.join(host.destinationParent, "missing"));
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-error")).toBeVisible();
      await expect(page.getByTestId("handoff-parent")).toBeEditable();
      await page.getByTestId("handoff-parent").fill(host.destinationParent);
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-review")).toHaveText(
        "This workspace has no conversations.",
      );
      expect((await host.destinationClient.fetchWorkspaces()).entries).toEqual([]);
      await expect(page.getByTestId("handoff-submit")).toHaveText("Prepare transfer");
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
        timeout: 30_000,
      });
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
      await expect(page.getByTestId("handoff-stop-notice")).toBeInViewport({ ratio: 1 });
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
