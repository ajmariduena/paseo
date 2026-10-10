import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProviderRuntimeSettingsMap } from "@getpaseo/protocol/provider-config";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { HandoffRecord } from "../../../src/handoff/persistence";
import { expect, type Page } from "@playwright/test";
import { startTestDaemon } from "./daemon-update";
import { addScheduleHostAndReload } from "./schedule-host";
import { seedWorkspace } from "./seed-client";
import { connectDaemonClient } from "./daemon-client-loader";
import { gotoAppShell } from "./app";
import { openHostSection, removeHostFromHostPage } from "./settings";

export async function openHandoff(page: Page) {
  await page.getByTestId("workspace-header-menu-trigger").click();
  await page.getByTestId("workspace-header-handoff").click();
  await expect(page.getByTestId("handoff-sheet")).toBeVisible();
}

export async function handoffHosts(
  page: Page,
  options: {
    git?: boolean;
    mcpServersSupported?: boolean;
    providerSettings?: {
      source: AgentProviderRuntimeSettingsMap;
      destination: AgentProviderRuntimeSettingsMap;
    };
    repo?: Parameters<typeof seedWorkspace>[0]["repo"];
    claudeConfigDirs?: { source: string; destination: string };
  } = {},
) {
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
    const source = await startTestDaemon({
      version: "0.11.1",
      workspaceHandoffCapability: true,
      realClaudeConfigDir: options.claudeConfigDirs?.source,
      mcpServersSupported: options.mcpServersSupported,
      providerSettings: options.providerSettings?.source,
    });
    cleanupSteps.push(() => source.close());
    const destination = await startTestDaemon({
      realClaudeConfigDir: options.claudeConfigDirs?.destination,
      providerSettings: options.providerSettings?.destination,
      version: "0.11.1",
      workspaceHandoffCapability: true,
    });
    cleanupSteps.push(() => destination.close());
    const sourcePort = Number(source.endpoint.split(":").at(-1));
    const destinationPort = Number(destination.endpoint.split(":").at(-1));
    const workspace = await seedWorkspace({
      repoPrefix: "handoff-browser-",
      git: options.git ?? false,
      repo: options.repo,
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
    const sourceClient = await connectDaemonClient<DaemonClient>({
      port: sourcePort,
      clientIdPrefix: "handoff-source-browser",
    });
    cleanupSteps.push(() => sourceClient.close());
    // Each isolated daemon removes its project registry on shutdown. A return trip
    // leaves a released source fenced, so deleting its project through RPC must refuse.
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
    return {
      source,
      destination,
      workspace,
      destinationParent,
      sourceClient,
      destinationClient,
      route,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function savedTransfer(page: Page, sourceServerId: string, workspaceId: string) {
  return (await savedHandoffRecord(page, sourceServerId, workspaceId)).transferId;
}

export async function savedHandoffRecord(page: Page, sourceServerId: string, workspaceId: string) {
  const key = `paseo:workspace-handoff:${JSON.stringify([sourceServerId, workspaceId])}`;
  return page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    if (!raw) throw new Error("No saved handoff");
    const value: HandoffRecord = JSON.parse(raw);
    return value;
  }, key);
}

export async function forgetTransfer(page: Page, sourceServerId: string, workspaceId: string) {
  const key = `paseo:workspace-handoff:${JSON.stringify([sourceServerId, workspaceId])}`;
  await page.evaluate((storageKey) => localStorage.removeItem(storageKey), key);
}

export async function reconnectSourceDestination(
  page: Page,
  host: Awaited<ReturnType<typeof handoffHosts>>,
  destinationWorkspaceId: string,
) {
  const sourceRoute = page.url();
  await page.goto(`/settings/hosts/${host.destination.serverId}`);
  await openHostSection(page, host.destination.serverId, "host");
  await removeHostFromHostPage(page, host.destination.serverId);
  // Keep the fixture from re-pairing the host on this full page navigation.
  await page.evaluate(() => {
    const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
    if (!nonce) throw new Error("Expected e2e seed nonce");
    localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
  });
  await page.goto(sourceRoute);
  await page.getByTestId("handoff-source-open").click();
  await expect(page.getByTestId("handoff-source-error")).toHaveText(
    "Reconnect the destination host to recover this handoff",
  );
  await expect(page.getByTestId("handoff-source-open")).toBeEnabled();
  await addScheduleHostAndReload({
    page,
    serverId: host.destination.serverId,
    port: Number(host.destination.endpoint.split(":").at(-1)),
    label: "Destination VPS",
  });
  await page.getByTestId("handoff-source-open").click();
  await expect(page).toHaveURL(
    new RegExp(`/h/${host.destination.serverId}/workspace/${destinationWorkspaceId}`),
  );
  expect((await host.destinationClient.fetchWorkspaces()).entries.map((entry) => entry.id)).toEqual(
    [destinationWorkspaceId],
  );
}
