import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { claudeProjectDirSync } from "../../../server/src/server/agent/providers/claude/project-dir";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { pressDirectNewTabShortcut } from "../support/helpers/launcher";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { openChangesPanel } from "../support/helpers/workspace-tabs";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { wsRoutePatternForPort } from "../support/helpers/daemon-port";
import { composerLocator } from "../support/helpers/composer";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { removeHostFromHostPage } from "../support/helpers/settings";
import {
  handoffHosts as hosts,
  openHandoff,
  savedTransfer,
  savedHandoffRecord,
  forgetTransfer,
  reconnectSourceDestination,
} from "../support/helpers/workspace-handoff";

function forgetSeededHost(sourceId: string) {
  const key = "@paseo:e2e-extra-hosts";
  const extra: Array<{ serverId: string }> = JSON.parse(localStorage.getItem(key) ?? "[]");
  localStorage.setItem(key, JSON.stringify(extra.filter(({ serverId }) => serverId !== sourceId)));
}

function registryIncludesHost(sourceId: string) {
  const registry: Array<{ serverId: string }> = JSON.parse(
    localStorage.getItem("@paseo:daemon-registry") ?? "[]",
  );
  return registry.some(({ serverId }) => serverId === sourceId);
}

function hasRecoveredLocalWork() {
  for (const [key, value] of Object.entries(localStorage)) {
    if (
      key.startsWith("paseo:file-editor-draft:") &&
      JSON.parse(value).draft.content === "local work to preserve\n"
    )
      return true;
  }
  return false;
}

async function inspectContinuedHistory(
  page: Page,
  host: Awaited<ReturnType<typeof hosts>>,
  contextAgentId: string,
  transferId: string,
  configDir: string,
  screenshotPath: string,
) {
  const { prepareWorkspaceHandoff, activateWorkspaceHandoff } =
    await import("../../../client/dist/workspace-handoff.js");
  const active = (await host.destinationClient.handoffGetDestinationStatus({ transferId })).result;
  const importedId = active?.agentMappings.find(
    (mapping) => mapping.sourceAgentId === contextAgentId,
  )?.destinationAgentId;
  if (!active || !importedId) throw new Error("Missing context destination");
  // Open a synthetic local session without a provider turn, then seed its transcript.
  // Real-provider continuation is covered separately in the authenticated spec.
  expect((await host.destinationClient.listCommands(importedId)).error).toBeNull();
  const current = (await host.destinationClient.fetchAgent(importedId))?.agent;
  if (!current?.persistence) throw new Error("Missing new local session");
  const project = claudeProjectDirSync(current.cwd, { configDir });
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, `${current.persistence.sessionId}.jsonl`),
    JSON.stringify({
      type: "user",
      uuid: randomUUID(),
      sessionId: current.persistence.sessionId,
      message: { role: "user", content: "New work on the VPS after the context export" },
    }) + "\n",
  );
  const returnId = randomUUID();
  await prepareWorkspaceHandoff({
    transferId: returnId,
    workspaceId: active.workspaceId,
    destinationParent: host.destinationParent,
    continuationMode: "native",
    source: host.destinationClient,
    destination: host.sourceClient,
  });
  const returned = await activateWorkspaceHandoff({
    transferId: returnId,
    sourceServerId: host.destination.serverId,
    getSource: () => host.destinationClient,
    destination: host.sourceClient,
  });
  const returnedId = returned.agentMappings.find(
    (mapping) => mapping.sourceAgentId === importedId,
  )?.destinationAgentId;
  if (!returnedId) throw new Error("Missing returned conversation");
  await page.goto(
    `/h/${host.source.serverId}/workspace/${returned.workspaceId}?open=${encodeURIComponent(`agent:${returnedId}`)}`,
  );
  await page.getByTestId("handoff-history-open").click();
  const content = page.getByTestId("handoff-history-content");
  await expect(content).toContainText("Read-only history from Destination VPS");
  await expect(content.getByTestId("user-message")).toContainText("New work on the VPS");
  await content.getByTestId("handoff-history-part").click();
  await page.getByTestId("handoff-history-part-1").click();
  await expect(page.getByTestId("handoff-history-part-1")).toBeHidden();
  await expect(content).toContainText("Read-only history from Source laptop");
  await expect(content.getByTestId("user-message")).toContainText("Keep the prior workspace task");
  await expect(content).not.toContainText("New work on the VPS");
  await page.screenshot({ path: screenshotPath });
  await content.getByTestId("handoff-history-part").click();
  await page.getByTestId("handoff-history-part-2").click();
  await expect(content).toContainText("Read-only history from Destination VPS");
  await expect(content.getByTestId("user-message")).toContainText("New work on the VPS");
  await expect(content.getByRole("textbox", { name: "Message agent..." })).toHaveCount(0);
  return returned;
}

test.describe("workspace handoff", () => {
  test.skip(process.platform === "win32", "Ownership release requires POSIX directory durability");

  for (const layout of ["desktop", "compact"] as const) {
    test(`${layout} preserves mixed conversation choices through recovery and activation`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(150_000);
      if (layout === "compact") await page.setViewportSize({ width: 390, height: 844 });
      const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "handoff-mixed-browser-"));
      const versionCommand = path.join(fixtureDirectory, "version.cjs");
      await writeFile(
        versionCommand,
        "if (process.argv[2] !== '--version') throw new Error('No provider turns in this fixture'); console.log('2.1.295');\n",
      );
      const sourceConfigDir = path.join(fixtureDirectory, "source");
      const host = await hosts(page, {
        providerSettings: {
          source: {
            claude: {
              command: { mode: "replace", argv: [process.execPath, versionCommand] },
              env: { CLAUDE_CONFIG_DIR: sourceConfigDir },
            },
          },
          destination: {
            claude: {
              command: { mode: "replace", argv: [process.execPath, versionCommand] },
              env: { CLAUDE_CONFIG_DIR: path.join(fixtureDirectory, "destination") },
            },
          },
        },
      }).catch(async (error: unknown) => {
        await rm(fixtureDirectory, { recursive: true, force: true });
        throw error;
      });
      try {
        const native = await host.sourceClient.createAgent({
          provider: "claude",
          cwd: host.workspace.repoPath,
          workspaceId: host.workspace.workspaceId,
          title: "Compatible conversation",
        });
        const context = await host.sourceClient.createAgent({
          provider: "claude",
          cwd: host.workspace.repoPath,
          workspaceId: host.workspace.workspaceId,
          title: "Conversation with a workflow",
        });
        const project = claudeProjectDirSync(host.workspace.repoPath, {
          configDir: sourceConfigDir,
        });
        await mkdir(project, { recursive: true });
        for (const agent of [native, context]) {
          if (!agent.persistence) throw new Error("Missing synthetic provider session");
          await writeFile(
            path.join(project, `${agent.persistence.sessionId}.jsonl`),
            JSON.stringify({
              type: "user",
              uuid: randomUUID(),
              sessionId: agent.persistence.sessionId,
              message: { role: "user", content: "Keep the prior workspace task" },
            }) + "\n",
          );
        }
        if (!context.persistence) throw new Error("Missing synthetic context session");
        const workflows = path.join(project, context.persistence.sessionId, "workflows");
        await mkdir(workflows, { recursive: true });
        await writeFile(path.join(workflows, "state.json"), JSON.stringify({ type: "state" }));
        // Seed a persisted watch without invoking a live forge or mixing TS/CJS with the ESM client.
        const watchFile = path.join(host.source.paseoHome, "pull-request-watches.json");
        const watch = {
          id: randomUUID(),
          agentId: native.id,
          cwd: host.workspace.repoPath,
          number: 42,
          url: "https://github.com/example/work/pull/42",
          title: "Finish the prior PR task",
          headRefName: "work",
          startedAt: new Date().toISOString(),
          progress: {
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: 0,
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        };
        await writeFile(watchFile, JSON.stringify({ version: 1, watches: [watch] }));
        await host.source.seedHeldQueue(native.id, "Keep this queued task");
        await openHandoff(page);
        await page.getByTestId("handoff-host-trigger").click();
        await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
        await page.getByTestId("handoff-parent").fill(host.destinationParent);
        await page.getByTestId("handoff-submit").click();
        const nativeChoice = page.getByTestId(`handoff-conversation-mode-${native.id}`);
        const contextChoice = page.getByTestId(`handoff-conversation-mode-${context.id}`);
        await expect(nativeChoice).toContainText("Keep native sessions");
        await expect(contextChoice).toContainText("Keep native sessions");
        await expect(page.getByTestId("handoff-submit")).toBeDisabled();
        await contextChoice.click();
        await page.getByText("Continue with exported history", { exact: true }).last().click();
        await expect(nativeChoice).toContainText("Keep native sessions");
        await expect(contextChoice).toContainText("Continue with exported history");
        await expect(
          page.getByText(
            "Conversations will start new provider sessions with readable exported history and a continuation brief.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(page.getByTestId("handoff-review")).toContainText(
          "Claude workflow state needs an explicit disposition before native continuation",
        );
        await expect(page.getByTestId("handoff-submit")).toBeEnabled();
        await expect(page.getByTestId("handoff-pr-watches-review")).toContainText(
          "#42 · Finish the prior PR task",
        );
        await expect(page.getByTestId("handoff-pr-watches-review")).toContainText(
          "These PR watches will stop.",
        );
        await contextChoice.scrollIntoViewIfNeeded();
        await waitForSettledPosition(contextChoice);
        await page.screenshot({
          path: path.join(__dirname, `../../../../docs/qa-evidence/handoff-mixed-${layout}.png`),
        });
        const watchReview = page.getByTestId("handoff-pr-watches-review");
        await watchReview.scrollIntoViewIfNeeded();
        await waitForSettledPosition(watchReview);
        await page.screenshot({
          path: path.join(__dirname, `../../../../docs/qa-evidence/handoff-watches-${layout}.png`),
        });
        const queueReview = page.getByTestId("handoff-queue-review");
        await expect(queueReview).toHaveText(
          "Pending messages: 1. They will move paused; resume the queue on the destination when ready.",
        );
        await queueReview.scrollIntoViewIfNeeded();
        await waitForSettledPosition(queueReview);
        await page.screenshot({
          path: path.join(__dirname, `../../../../docs/qa-evidence/handoff-queue-${layout}.png`),
        });
        await page.getByTestId("handoff-submit").click();
        await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
          timeout: 30_000,
        });
        expect(JSON.parse(await readFile(watchFile, "utf8")).watches).toEqual([]);
        const transferId = await savedTransfer(
          page,
          host.source.serverId,
          host.workspace.workspaceId,
        );
        await forgetTransfer(page, host.source.serverId, host.workspace.workspaceId);
        await page.reload();
        await page.getByTestId("handoff-source-open").click();
        await expect(
          page.getByText("Mixed: native sessions and exported history", { exact: true }),
        ).toBeVisible();
        expect(await savedTransfer(page, host.source.serverId, host.workspace.workspaceId)).toBe(
          transferId,
        );
        await page.getByTestId("handoff-submit").click();
        await expect(page.getByTestId("handoff-submit")).toHaveText("Open destination", {
          timeout: 30_000,
        });
        const active = await host.destinationClient.handoffGetDestinationStatus({ transferId });
        expect(active.result?.state).toBe("active");
        const destinationAgentId = active.result?.agentMappings.find(
          (mapping) => mapping.sourceAgentId === native.id,
        )?.destinationAgentId;
        if (!destinationAgentId) throw new Error("Missing destination queue mapping");
        expect(
          (await host.destinationClient.listAgentQueue(destinationAgentId)).queue,
        ).toMatchObject({
          held: true,
          entries: [{ origin: "user", textPreview: "Keep this queued task" }],
        });
        expect(active.result?.conversationModes).toEqual(
          expect.arrayContaining([
            { sourceAgentId: native.id, mode: "native" },
            { sourceAgentId: context.id, mode: "context" },
          ]),
        );
        await page.goto(
          `/h/${host.destination.serverId}/workspace/${active.result!.workspaceId}?open=${encodeURIComponent(`agent:${destinationAgentId}`)}`,
        );
        await expect(page.getByTestId("server-queue-track")).toContainText("Keep this queued task");
        await expect(page.getByTestId("held-queue-callout")).toBeVisible();
        await expect(page.getByTestId("held-queue-resume")).toBeEnabled();
        const returned = await inspectContinuedHistory(
          page,
          host,
          context.id,
          transferId,
          path.join(fixtureDirectory, "destination"),
          path.join(__dirname, `../../../../docs/qa-evidence/handoff-history-parts-${layout}.png`),
        );
        const returnedQueueAgentId = returned.agentMappings.find(
          (mapping) => mapping.sourceAgentId === destinationAgentId,
        )?.destinationAgentId;
        if (!returnedQueueAgentId) throw new Error("Missing returned queue mapping");
        expect((await host.sourceClient.listAgentQueue(returnedQueueAgentId)).queue).toMatchObject({
          held: true,
          entries: [{ origin: "user", textPreview: "Keep this queued task" }],
        });
      } catch (error) {
        await page.screenshot({ path: testInfo.outputPath("handoff-mixed-failure.png") });
        throw error;
      } finally {
        await host.close();
        await rm(fixtureDirectory, { recursive: true, force: true });
      }
    });
  }

  for (const layout of ["desktop", "compact"] as const) {
    test(`${layout} shows conversation MCP connections that need reconfiguration`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      if (layout === "compact") await page.setViewportSize({ width: 390, height: 844 });
      const host = await hosts(page, { mcpServersSupported: true });
      try {
        await host.sourceClient.createAgent({
          workspaceId: host.workspace.workspaceId,
          config: {
            provider: "claude",
            cwd: host.workspace.repoPath,
            mcpServers: {
              "issue-tracker": {
                type: "http",
                url: "https://PRIVATE_ENDPOINT.invalid/mcp",
                headers: { Authorization: "PRIVATE_TOKEN" },
              },
              "local-browser": { type: "stdio", command: "/PRIVATE_COMMAND" },
            },
          },
        });
        await openHandoff(page);
        await page.getByTestId("handoff-host-trigger").click();
        await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
        await page.getByTestId("handoff-parent").fill(host.destinationParent);
        await page.getByTestId("handoff-submit").click();
        const omissions = page.getByTestId("handoff-omitted-mcp");
        await expect(omissions).toHaveText(
          "MCP connections to reconfigure: issue-tracker, local-browser",
        );
        await expect(page.getByTestId("handoff-review")).toContainText(
          "Host and project MCP connections have not been checked.",
        );
        await expect(page.getByTestId("handoff-sheet")).not.toContainText("PRIVATE_");
        // The fake provider has no portable session. An integration warning must not hide that refusal.
        await expect(page.getByTestId("handoff-submit")).toBeDisabled();
        await omissions.scrollIntoViewIfNeeded();
        await waitForSettledPosition(omissions);
        await expect(omissions).toBeInViewport({ ratio: 1 });
        await page.screenshot({
          path: path.join(
            __dirname,
            `../../../../docs/qa-evidence/handoff-integrations-${layout}.png`,
          ),
        });
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
      } catch (error) {
        await page.screenshot({ path: testInfo.outputPath("handoff-integrations-failure.png") });
        throw error;
      } finally {
        await host.close();
      }
    });
  }

  for (const layout of ["desktop", "compact"] as const) {
    test(`${layout} pages all exclusions and requires a fresh review when later exclusions change`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      if (layout === "compact") await page.setViewportSize({ width: 390, height: 844 });
      const host = await hosts(page);
      try {
        await writeFile(path.join(host.workspace.repoPath, ".gitignore"), ".env*\nignored/\n");
        for (let index = 0; index < 103; index++)
          await writeFile(
            path.join(host.workspace.repoPath, `.env.${String(index).padStart(3, "0")}`),
            "synthetic omitted data",
          );
        await mkdir(path.join(host.workspace.repoPath, "ignored"));
        await writeFile(
          path.join(host.workspace.repoPath, "ignored", "child.txt"),
          "synthetic omitted child",
        );
        await openHandoff(page);
        await page.getByTestId("handoff-host-trigger").click();
        await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
        await page.getByTestId("handoff-parent").fill(host.destinationParent);
        await page.getByTestId("handoff-submit").click();
        await expect(page.getByTestId("handoff-omissions-range")).toHaveText("1–50 / 104");
        await expect(page.getByTestId("handoff-omissions-previous")).toBeDisabled();
        await page.getByTestId("handoff-omissions-next").click();
        await expect(page.getByTestId("handoff-omissions-range")).toHaveText("51–100 / 104");
        await expect(page.getByTestId("handoff-omissions-review")).toContainText(".env.050");
        await expect(page.getByTestId("handoff-omissions-review")).not.toContainText(".env.000");
        await rename(
          path.join(host.workspace.repoPath, ".env.102"),
          path.join(host.workspace.repoPath, ".env.changed"),
        );
        await page.getByTestId("handoff-omissions-next").click();
        await expect(page.getByTestId("handoff-error")).toHaveText(
          "Workspace files or exclusions changed after review; review the transfer again",
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
        await page.getByTestId("handoff-submit").click();
        await expect(page.getByTestId("handoff-omissions-range")).toHaveText("1–50 / 104");
        await page.getByTestId("handoff-omissions-next").click();
        await expect(page.getByTestId("handoff-omissions-range")).toHaveText("51–100 / 104");
        await page.getByTestId("handoff-omissions-next").click();
        await expect(page.getByTestId("handoff-omissions-range")).toHaveText("101–104 / 104");
        await expect(page.getByTestId("handoff-omissions-review")).toContainText(".env.changed");
        await expect(page.getByTestId("handoff-omissions-review")).toContainText("ignored/");
        await expect(
          page.getByText("An excluded directory includes all its contents.", { exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId("handoff-omissions-next")).toBeDisabled();
        for (const width of layout === "desktop"
          ? [390, 1280, 390, 1280]
          : [1280, 390, 1280, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
          await expect(page.getByTestId("handoff-submit")).toHaveCount(1);
          await expect(page.getByTestId("handoff-omissions-range")).toHaveText("101–104 / 104");
          await expect(page.getByTestId("handoff-submit")).toHaveText("Prepare transfer");
        }
        await waitForSettledPosition(page.getByTestId("handoff-submit"));
        await page.getByTestId("handoff-omissions-previous").scrollIntoViewIfNeeded();
        await expect(page.getByTestId("handoff-omissions-previous")).toBeInViewport({ ratio: 1 });
        await expect(page.getByTestId("handoff-submit")).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: testInfo.outputPath(`handoff-omissions-${layout}.png`) });
        await page.getByTestId("handoff-omissions-previous").click();
        await expect(page.getByTestId("handoff-omissions-range")).toHaveText("51–100 / 104");
        await page.getByTestId("handoff-submit").click();
        await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
          timeout: 30_000,
        });
        const transferId = await savedTransfer(
          page,
          host.source.serverId,
          host.workspace.workspaceId,
        );
        for (const width of layout === "desktop" ? [390, 1280] : [1280, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
          await expect(page.getByTestId("handoff-submit")).toHaveCount(1);
          await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace");
          expect(await savedTransfer(page, host.source.serverId, host.workspace.workspaceId)).toBe(
            transferId,
          );
        }
        await page.getByTestId("handoff-submit").click();
        await expect(page.getByTestId("handoff-submit")).toHaveText("Open destination", {
          timeout: 30_000,
        });
        const status = await host.destinationClient.handoffGetDestinationStatus({ transferId });
        if (!status.result) throw new Error("Missing transfer");
        expect(status.result.state).toBe("active");
        await expect(
          readFile(path.join(status.result.destinationCwd, ".env.changed")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          readFile(path.join(status.result.destinationCwd, "ignored", "child.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } catch (error) {
        await page.screenshot({ path: testInfo.outputPath("handoff-resize-failure.png") });
        throw error;
      } finally {
        await host.close();
      }
    });
  }

  for (const phase of ["reserved", "staged"] as const) {
    test(`recovers ${phase} cancellation without local state and finishes interrupted cleanup`, async ({
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
        await expect(
          page.getByText("Continue with exported history", { exact: true }),
        ).toBeVisible();
        expect(await savedTransfer(page, host.source.serverId, host.workspace.workspaceId)).toBe(
          chosenId,
        );
        expect(
          (await host.sourceClient.handoffFindSource({ workspaceId: host.workspace.workspaceId }))
            .result,
        ).toBeNull();
        expect((await host.destinationClient.fetchWorkspaces()).entries).toEqual([]);
        if (phase === "staged") {
          await page.getByTestId("handoff-submit").click();
          await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
            timeout: 30_000,
          });
        }
        const prepared = await host.destinationClient.handoffGetDestinationStatus({
          transferId: chosenId,
        });
        expect(prepared.result).toMatchObject({
          transferId: chosenId,
          state: phase,
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
        if (phase === "staged") {
          if (!cancelledAtSource.result) throw new Error("Missing cancellation proof");
          const container = path.join(
            host.destinationParent,
            `.paseo-handoff-${prepared.result.reservationId}`,
          );
          const moved = `${container}-original`;
          const unrelated = path.join(host.destinationParent, "unrelated");
          await mkdir(unrelated);
          await writeFile(path.join(unrelated, "keep.txt"), "user data");
          await rename(container, moved);
          await symlink(unrelated, container);
          const interrupted = await host.destinationClient.handoffCancelDestination({
            transferId: chosenId,
            proof: cancelledAtSource.result,
          });
          expect(interrupted.error?.code).toBe("storage_uncertain");
          expect(
            (await host.destinationClient.handoffGetDestinationStatus({ transferId: chosenId }))
              .result,
          ).toMatchObject({
            state: "cancelled",
            cleanupComplete: false,
            cancellationAccepted: true,
          });
          expect(await readFile(path.join(unrelated, "keep.txt"), "utf8")).toBe("user data");
          await rm(container);
          await rename(moved, container);
        }
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
        if (phase === "staged") {
          await host.sourceClient.close();
          await host.source.close();
          await page.reload();
          await openHandoff(page);
          await expect(page.getByTestId("handoff-status")).toHaveText(
            "Cancellation is incomplete. Resume to finish cancelling this transfer.",
          );
          await page.screenshot({ path: testInfo.outputPath("handoff-cancellation-offline.png") });
        }
        await page.getByTestId("handoff-submit").click();
        await expect(page.getByTestId("handoff-status")).toHaveText(
          "Transfer cancelled. The source can be used again.",
        );
        await page.screenshot({ path: testInfo.outputPath("handoff-cancellation-complete.png") });
        const remaining = await host.destinationClient.handoffListDestination(query);
        expect(remaining.result?.transfers.map((transfer) => transfer.transferId)).toEqual([
          firstId,
        ]);
      } finally {
        await host.close();
      }
    });
  }

  for (const layout of ["desktop", "compact"] as const) {
    test(`${layout} discovers incoming transfers after forgetting the source host and workspace`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(160_000);
      if (layout === "compact") await page.setViewportSize({ width: 390, height: 844 });
      const host = await hosts(page);
      try {
        const { prepareWorkspaceHandoff, activateWorkspaceHandoff } =
          await import("../../../client/dist/workspace-handoff.js");
        const transferId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        const staged = await prepareWorkspaceHandoff({
          source: host.sourceClient,
          destination: host.destinationClient,
          transferId,
          workspaceId: host.workspace.workspaceId,
          destinationParent: host.destinationParent,
          continuationMode: "context",
        });
        await mkdir(staged.destinationCwd);
        await expect(
          activateWorkspaceHandoff({
            sourceServerId: host.source.serverId,
            getSource: () => host.sourceClient,
            destination: host.destinationClient,
            transferId,
          }),
        ).rejects.toThrow("Destination checkout already exists");
        for (let index = 1; index <= 20; index++) {
          const result = await host.destinationClient.handoffReserveDestination({
            sourceServerId: "unpaired-source",
            sourceWorkspaceId: "missing-workspace",
            transferId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            sourceAgentIds: [],
            destinationParent: host.destinationParent,
            continuationMode: "context",
          });
          expect(result.error).toBeNull();
        }
        await page.goto(`/settings/hosts/${host.source.serverId}/host`);
        // Do not let the fixture re-pair the removed source on subsequent reloads.
        await page.evaluate(forgetSeededHost, host.source.serverId);
        await removeHostFromHostPage(page, host.source.serverId);
        await host.source.close();
        await forgetTransfer(page, host.source.serverId, host.workspace.workspaceId);
        const gate = await installDaemonWebSocketGate(
          page,
          wsRoutePatternForPort(host.destination.endpoint.split(":").at(-1)!),
        );
        const responseType = "workspace.handoff.list_destination.response";
        gate.holdNextServerMessage(responseType);
        await page.goto(`/settings/hosts/${host.destination.serverId}/workspaces`);
        await gate.waitForHeldServerMessage(responseType);
        await expect(page.getByTestId("incoming-handoffs")).toContainText("Loading...");
        await expect(page.getByTestId("incoming-handoffs-empty")).toHaveCount(0);
        gate.releaseHeldServerMessage(responseType);
        const firstId = "00000000-0000-4000-8000-000000000001";
        await expect(page.getByTestId(`incoming-handoff-${firstId}`)).toBeVisible();
        await expect(page.getByTestId(`incoming-handoff-${transferId}`)).toHaveCount(0);
        expect(await page.evaluate(registryIncludesHost, host.source.serverId)).toBe(false);
        await expect(
          savedTransfer(page, host.source.serverId, host.workspace.workspaceId),
        ).rejects.toThrow("No saved handoff");
        await page.screenshot({ path: testInfo.outputPath(`handoff-incoming-${layout}.png`) });
        // A reservation still needs its absent source; the error stays retryable in the sheet.
        await page.getByTestId(`incoming-handoff-${firstId}`).click();
        const recoveryError = page.getByRole("alert");
        await expect(recoveryError).toHaveText("Connect both hosts to continue");
        await page.getByTestId("handoff-submit").click();
        await expect(recoveryError).toHaveText("Connect both hosts to continue");
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page.getByTestId("incoming-handoffs-more").click();
        await expect(page.getByTestId(`incoming-handoff-${transferId}`)).toBeVisible();
        await page.getByTestId("incoming-handoffs-previous").click();
        await expect(page.getByTestId(`incoming-handoff-${firstId}`)).toBeVisible();
        await expect(page.getByTestId(`incoming-handoff-${transferId}`)).toHaveCount(0);
        await page.getByTestId("incoming-handoffs-more").click();
        await page.getByTestId(`incoming-handoff-${transferId}`).click();
        await expect(page.getByTestId("handoff-submit")).toHaveText("Resume");
        await expect(page.getByTestId("handoff-cancel")).toHaveCount(0);
        await page.getByTestId("handoff-submit").click();
        await expect(page.getByTestId("handoff-error")).toHaveText(
          "Destination checkout already exists",
        );
        await page.screenshot({
          path: testInfo.outputPath(`handoff-incoming-recovery-${layout}.png`),
        });
        await rmdir(staged.destinationCwd);
        await page.getByTestId("handoff-submit").click();
        await expect(page.getByTestId("handoff-status")).toHaveText(
          "Workspace moved. Continue on the destination host.",
        );
        expect(await readFile(path.join(staged.destinationCwd, "prior-work.txt"), "utf8")).toBe(
          "work from the source\n",
        );
        await page.getByTestId("handoff-submit").click();
        await expect(page).toHaveURL(
          new RegExp(`/h/${host.destination.serverId}/workspace/${staged.workspaceId}`),
        );
      } finally {
        await host.close();
      }
    });
  }

  test("recovers preparation errors and finishes offline after losing local transfer state", async ({
    page,
  }, testInfo) => {
    test.setTimeout(160_000);
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
      await writeFile(path.join(host.workspace.repoPath, ".gitignore"), "");
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-error")).toHaveText(
        "Workspace files or exclusions changed after review; review the transfer again",
      );
      expect(
        (
          await host.destinationClient.handoffListDestination({
            sourceServerId: host.source.serverId,
            sourceWorkspaceId: host.workspace.workspaceId,
          })
        ).result?.transfers,
      ).toEqual([]);
      expect(
        (await host.sourceClient.handoffFindSource({ workspaceId: host.workspace.workspaceId }))
          .result,
      ).toBeNull();
      expect(
        (await host.sourceClient.listTerminals(host.workspace.repoPath)).terminals,
      ).toHaveLength(1);
      await page.screenshot({ path: testInfo.outputPath("handoff-review-changed.png") });
      await writeFile(path.join(host.workspace.repoPath, ".gitignore"), ".env\n");
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-omissions-review")).toHaveText(".env");
      await expect(page.getByTestId("handoff-submit")).toHaveText("Prepare transfer");
      const added = await host.sourceClient.createTerminal(
        host.workspace.repoPath,
        "Started after review",
        undefined,
        {
          workspaceId: host.workspace.workspaceId,
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
      );
      expect(added.error).toBeNull();
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-error")).toHaveText(
        "Work that will stop changed after review; review the transfer again",
      );
      expect(
        (await host.sourceClient.listTerminals(host.workspace.repoPath)).terminals,
      ).toHaveLength(2);
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
      await page.screenshot({ path: testInfo.outputPath("handoff-writers-changed.png") });
      await page.getByTestId("handoff-submit").click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Prepare transfer");
      await expect(page.getByTestId("handoff-sheet")).toContainText("Started after review");
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
      const checkpoint = await savedHandoffRecord(
        page,
        host.source.serverId,
        host.workspace.workspaceId,
      );
      const staged = await host.destinationClient.handoffGetDestinationStatus({ transferId });
      if (!staged.result) throw new Error("Missing prepared destination");
      expect(checkpoint.sourcePublicKey).toBe(
        (await host.sourceClient.handoffGetSourceStatus({ transferId })).result?.source.publicKey,
      );
      expect(checkpoint.sourcePublicKey).toBe(staged.result.sourcePublicKey);
      expect(checkpoint.snapshot).toEqual(staged.result);
      await page.reload();
      await openHandoff(page);
      await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace");
      expect(await savedTransfer(page, host.source.serverId, host.workspace.workspaceId)).toBe(
        transferId,
      );
      expect(
        await savedHandoffRecord(page, host.source.serverId, host.workspace.workspaceId),
      ).toEqual(checkpoint);
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
      await forgetTransfer(page, host.source.serverId, host.workspace.workspaceId);
      await page
        .getByTestId("handoff-sheet")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.reload();
      await openHandoff(page);
      await page.getByTestId("handoff-host-trigger").click();
      await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
      await page.getByTestId("handoff-recovery-trigger").click();
      await page.getByTestId(`handoff-recovery-${transferId}`).click();
      await expect(page.getByTestId("handoff-submit")).toHaveText("Resume");
      await expect(page.getByTestId("handoff-cancel")).toHaveCount(0);
      expect(await savedTransfer(page, host.source.serverId, host.workspace.workspaceId)).toBe(
        transferId,
      );
      await page.screenshot({ path: testInfo.outputPath("handoff-offline-recovery.png") });
      const recovered = await savedHandoffRecord(
        page,
        host.source.serverId,
        host.workspace.workspaceId,
      );
      expect(recovered.sourcePublicKey).toBe(checkpoint.sourcePublicKey);
      expect(recovered.snapshot).toMatchObject({
        reservationId: checkpoint.snapshot?.reservationId,
        manifestDigest: checkpoint.snapshot?.manifestDigest,
        agentMappings: checkpoint.snapshot?.agentMappings,
      });
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
    test.setTimeout(150_000);
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
      await expect.poll(() => page.evaluate(hasRecoveredLocalWork)).toBe(true);
      await page.reload();
      await expect(editor).toContainText("local work to preserve");
      await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
      expect(await readFile(filePath, "utf8")).toBe("external work\n");
      // A deleted file still opens its persisted buffer after a cold reload.
      await rm(filePath);
      await page.reload();
      await expect(editor).toContainText("local work to preserve");
      await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("handoff-recovered-deleted-file.png") });
      await writeFile(filePath, "external work\n");
      await page.reload();
      await expect(editor).toContainText("local work to preserve");
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
