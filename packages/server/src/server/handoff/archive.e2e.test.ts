import {
  transferHandoffArchive,
  prepareWorkspaceHandoff,
  activateWorkspaceHandoff,
  cancelWorkspaceHandoff,
  type HandoffTransferProgress,
  DaemonClient as TransportClient,
} from "@getpaseo/client/internal/daemon-client";
import { WebSocket, type RawData } from "ws";
import { WSOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { HANDOFF_CHUNK_BYTES } from "@getpaseo/protocol/handoff";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { HandoffArchiveStore } from "./archive.js";
import { readHandoffBundle } from "./bundle.js";
import { parseStoredAgentRecord } from "../agent/agent-storage.js";
import { captureWorkspace, packWorkspaceArchive, restoreWorkspaceArchive } from "./workspace.js";

const exec = promisify(execFile);

interface Host {
  daemon: TestPaseoDaemon;
  client: DaemonClient;
}
let root: string;
const running = new Set<Host>();

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-network-"));
});
afterEach(async () => {
  for (const host of running) await stopHost(host);
  await rm(root, { recursive: true, force: true });
}, 30_000);

async function startHost(name: string, nativeSessions = false): Promise<Host> {
  const home = path.join(root, name);
  const staticDir = path.join(home, "static");
  await mkdir(staticDir, { recursive: true });
  const versionCommand = path.join(home, "claude-version.cjs");
  if (nativeSessions)
    await writeFile(
      versionCommand,
      "if (process.argv[2] !== '--version') throw new Error('Must not start a conversation'); console.log('2.1.295');\n",
    );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: home,
    staticDir,
    cleanup: false,
    mcpEnabled: false,
    agentClients: {},
    agentProviderSettings: nativeSessions
      ? {
          claude: {
            command: { mode: "replace", argv: [process.execPath, versionCommand] },
            env: { CLAUDE_CONFIG_DIR: path.join(home, "claude") },
          },
        }
      : undefined,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.1",
  });
  const host = { daemon, client };
  running.add(host);
  await client.connect();
  return host;
}

async function stopHost(host: Host): Promise<void> {
  running.delete(host);
  await host.client.close();
  await host.daemon.close();
}

test.skipIf(process.platform === "win32").each(["reserved", "staged"] as const)(
  "cancels a %s handoff after a lost source cancellation reply and host restart",
  async (phase) => {
    let source = await startHost("source");
    let destination = await startHost("destination");
    const cwd = path.join(root, "cancel-workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "work.txt"), "Original work");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing workspace");
    const transferId = randomUUID();
    const request = {
      transferId,
      workspaceId: created.workspace.id,
      destinationParent: root,
      continuationMode: "native" as const,
    };
    const reservation = await destination.client.handoffReserveDestination({
      transferId,
      sourceServerId: source.daemon.daemon.getServerId(),
      sourceWorkspaceId: request.workspaceId,
      sourceAgentIds: [],
      destinationParent: root,
      continuationMode: "native",
    });
    if (!reservation.result) throw new Error("Missing reservation");
    if (phase === "staged")
      await prepareWorkspaceHandoff({
        ...request,
        source: source.client,
        destination: destination.client,
      });
    const cancelRequest = {
      transferId,
      destinationServerId: destination.daemon.daemon.getServerId(),
      reservationId: reservation.result.reservationId,
    };
    const cancelled = await source.client.handoffCancelSource(cancelRequest);
    expect(cancelled.error).toBeNull();
    if (!cancelled.result) throw new Error("Missing cancellation proof");
    const invalid = await destination.client.handoffCancelDestination({
      transferId,
      proof: {
        ...cancelled.result,
        receipt: { ...cancelled.result.receipt, signature: "invalid-signature" },
      },
    });
    expect(invalid.error?.code).toBe("invalid_cancellation");
    expect(
      (await destination.client.handoffGetDestinationStatus({ transferId })).result?.state,
    ).toBe(phase);
    // Source committed cancellation, but its reply was not forwarded before both hosts restarted.
    await stopHost(source);
    await stopHost(destination);
    source = await startHost("source");
    destination = await startHost("destination");
    expect((await source.client.handoffCancelSource(cancelRequest)).result).toEqual(
      cancelled.result,
    );
    const delayed = await source.client.handoffPrepareSource({
      ...cancelRequest,
      workspaceId: request.workspaceId,
      agentIds: [],
    });
    expect(delayed.error?.code).toBe("invalid_state");
    const result = await cancelWorkspaceHandoff({
      source: source.client,
      destination: destination.client,
      transferId,
    });
    expect(result.state).toBe("cancelled");
    expect(
      await cancelWorkspaceHandoff({
        source: source.client,
        destination: destination.client,
        transferId,
      }),
    ).toEqual(result);
    expect(await readFile(path.join(cwd, "work.txt"), "utf8")).toBe("Original work");
    expect(
      await source.daemon.daemon.handoffOwnership.withMutation({ cwd }, async () => "resumed"),
    ).toBe("resumed");
    await expect(
      readdir(path.join(root, `.paseo-handoff-${result.reservationId}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "coordinates handoff over RPC and recovers a lost release reply after reconnect",
  async () => {
    let source = await startHost("source");
    const sourceServerId = source.daemon.daemon.getServerId();
    let destination = await startHost("destination");
    const cwd = path.join(root, "rpc-workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "work.txt"), "Pending work");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Workspace creation failed");
    const inspected = await source.client.handoffInspectSource({
      workspaceId: created.workspace.id,
    });
    expect(inspected.error).toBeNull();
    expect(inspected.result).toMatchObject({ workspaceId: created.workspace.id, agentIds: [] });
    const transferId = randomUUID();
    const request = {
      transferId,
      workspaceId: created.workspace.id,
      destinationParent: root,
      continuationMode: "native" as const,
    };
    const staged = await prepareWorkspaceHandoff({
      ...request,
      source: source.client,
      destination: destination.client,
    });
    expect(staged.state).toBe("staged");
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
    const unreleased = await destination.client.handoffActivateDestination({ transferId });
    expect(unreleased.error?.code).toBe("invalid_state");
    await expect(
      activateWorkspaceHandoff({
        sourceServerId,
        getSource: () => destination.client,
        destination: destination.client,
        transferId,
      }),
    ).rejects.toThrow("Source connection belongs to another host");
    const release = await source.client.handoffReleaseSource({ transferId });
    expect(release.error).toBeNull();
    if (!release.result) throw new Error("Missing release receipt");
    await expect(
      cancelWorkspaceHandoff({
        source: source.client,
        destination: destination.client,
        transferId,
      }),
    ).rejects.toThrow("Source ownership was released");
    const refused = await destination.client.handoffActivateDestination({
      transferId,
      receipt: { ...release.result, signature: "invalid-signature" },
    });
    expect(refused.error?.code).toBe("invalid_release");
    expect(
      (await destination.client.handoffGetDestinationStatus({ transferId })).result?.state,
    ).toBe("staged");
    // The client lost the reply before forwarding it, then both hosts restarted.
    await stopHost(source);
    await stopHost(destination);
    await rm(cwd, { recursive: true });
    destination = await startHost("destination");
    await expect(
      activateWorkspaceHandoff({
        sourceServerId,
        getSource: () => source.client,
        destination: destination.client,
        transferId,
      }),
    ).rejects.toThrow("Connect both handoff hosts before continuing");
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
    source = await startHost("source");
    const resumed = await prepareWorkspaceHandoff({
      ...request,
      source: source.client,
      destination: destination.client,
    });
    expect(resumed).toEqual(staged);
    // A previous client reached release acceptance but stopped before activation.
    await destination.daemon.daemon.handoffDestination.acceptRelease(transferId, release.result);
    const accepted = await prepareWorkspaceHandoff({
      ...request,
      source: source.client,
      destination: destination.client,
    });
    expect(accepted.state).toBe("released");
    // Once the destination has the signed release, recovery must not need the source.
    await stopHost(source);
    await stopHost(destination);
    destination = await startHost("destination");
    const activation = {
      sourceServerId,
      getSource: () => {
        throw new Error("Source must not be accessed after destination accepted release");
      },
      destination: destination.client,
      transferId,
    };
    const active = await activateWorkspaceHandoff(activation);
    expect(active.state).toBe("active");
    expect(active.workspaceId).toBe(staged.workspaceId);
    expect(await readFile(path.join(active.destinationCwd, "work.txt"), "utf8")).toBe(
      "Pending work",
    );
    expect(await activateWorkspaceHandoff(activation)).toEqual(active);
    await expect(
      activateWorkspaceHandoff({ ...activation, sourceServerId: "another-source" }),
    ).rejects.toThrow("Destination reservation belongs to another source host");
    expect((await destination.client.fetchWorkspaces()).entries.map((entry) => entry.id)).toEqual([
      active.workspaceId,
    ]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "activates an explicit context export without installing a native session",
  async () => {
    const source = await startHost("source", true);
    let destination = await startHost("destination", true);
    const origin = source.daemon.daemon;
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing source workspace");
    const sourceAgentId = randomUUID();
    const sessionId = randomUUID();
    const project = claudeProjectDirSync(cwd, { configDir: path.join(root, "source", "claude") });
    await mkdir(project, { recursive: true });
    const transcript =
      JSON.stringify({
        type: "user",
        sessionId,
        message: { role: "user", content: "Remember the export token: previous-only-token" },
      }) + "\n";
    await writeFile(path.join(project, `${sessionId}.jsonl`), transcript);
    const timestamp = new Date().toISOString();
    await origin.agentStorage.upsert(
      parseStoredAgentRecord({
        id: sourceAgentId,
        provider: "claude",
        cwd,
        workspaceId: created.workspace.id,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastStatus: "closed",
        persistence: { provider: "claude", sessionId },
      }),
    );
    const preview = await source.client.handoffPreviewSource({ workspaceId: created.workspace.id });
    expect(preview.error).toBeNull();
    if (!preview.result) throw new Error("Missing source preview");
    expect(preview.result.conversations).toEqual([
      {
        agentId: sourceAgentId,
        title: null,
        provider: "claude",
        state: "available",
        cliVersion: "2.1.295",
        hasWorkflows: false,
      },
    ]);
    const compatibility = await destination.client.handoffPreviewDestination({
      conversations: preview.result.conversations,
    });
    expect(compatibility.error).toBeNull();
    expect(compatibility.result?.conversations).toEqual([
      {
        agentId: sourceAgentId,
        title: null,
        provider: "claude",
        native: { available: true, reason: null },
        context: { available: true, reason: null },
      },
    ]);
    await rm(path.join(project, `${sessionId}.jsonl`));
    const missingHistory = await source.client.handoffPreviewSource({
      workspaceId: created.workspace.id,
    });
    expect(missingHistory.result?.conversations).toEqual([
      {
        agentId: sourceAgentId,
        title: null,
        provider: "claude",
        state: "blocked",
        reason: "Saved Claude session files are missing on the source host",
      },
    ]);
    if (!missingHistory.result) throw new Error("Missing source failure preview");
    const blocked = await destination.client.handoffPreviewDestination({
      conversations: missingHistory.result.conversations,
    });
    expect(blocked.result?.conversations[0]).toMatchObject({
      native: {
        available: false,
        reason: "Saved Claude session files are missing on the source host",
      },
      context: {
        available: false,
        reason: "Saved Claude session files are missing on the source host",
      },
    });
    await writeFile(path.join(project, `${sessionId}.jsonl`), transcript);
    await writeFile(
      path.join(root, "destination", "claude-version.cjs"),
      "console.log('2.1.296');\n",
    );
    const mismatched = await destination.client.handoffPreviewDestination({
      conversations: preview.result.conversations,
    });
    expect(mismatched.result?.conversations[0]).toMatchObject({
      native: {
        available: false,
        reason: "Native Claude handoff requires matching Claude Code versions, at least 2.1.295",
      },
      context: { available: true, reason: null },
    });
    await writeFile(
      path.join(root, "destination", "claude-version.cjs"),
      "console.log('2.1.295');\n",
    );
    const workflows = path.join(project, sessionId, "workflows");
    await mkdir(workflows, { recursive: true });
    await writeFile(path.join(workflows, "state.json"), JSON.stringify({ type: "state" }));
    const withWorkflow = await source.client.handoffPreviewSource({
      workspaceId: created.workspace.id,
    });
    expect(withWorkflow.result?.conversations[0]).toMatchObject({ hasWorkflows: true });
    if (!withWorkflow.result) throw new Error("Missing workflow preview");
    const workflowCompatibility = await destination.client.handoffPreviewDestination({
      conversations: withWorkflow.result.conversations,
    });
    expect(workflowCompatibility.result?.conversations[0]).toMatchObject({
      native: {
        available: false,
        reason: "Claude workflow state needs an explicit disposition before native continuation",
      },
      context: { available: true, reason: null },
    });
    expect(await origin.handoffOwnership.withMutation({ cwd }, async () => "still writable")).toBe(
      "still writable",
    );
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
    const transferId = randomUUID();
    await expect(
      prepareWorkspaceHandoff({
        source: source.client,
        destination: destination.client,
        transferId,
        workspaceId: created.workspace.id,
        destinationParent: root,
        continuationMode: "context",
        expectedAgentIds: [],
      }),
    ).rejects.toThrow("Source conversations changed after review");
    expect((await destination.client.handoffGetDestinationStatus({ transferId })).error?.code).toBe(
      "not_found",
    );
    const request = {
      transferId,
      sourceServerId: origin.getServerId(),
      sourceWorkspaceId: created.workspace.id,
      sourceAgentIds: [sourceAgentId],
      destinationParent: root,
      continuationMode: "context" as const,
    };
    const reserved = await destination.daemon.daemon.handoffDestination.reserve(request);
    expect(reserved.continuationMode).toBe("context");
    await expect(
      destination.daemon.daemon.handoffDestination.reserve({
        ...request,
        continuationMode: "native",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const prepared = await origin.handoffSource.prepare({
      transferId,
      workspaceId: created.workspace.id,
      agentIds: [sourceAgentId],
      destinationServerId: destination.daemon.daemon.getServerId(),
      reservationId: reserved.reservationId,
    });
    await destination.daemon.daemon.handoffDestination.bindSource({
      transferId,
      manifest: prepared.manifest,
      publicKey: prepared.source.publicKey,
    });
    await transferHandoffArchive({
      source: source.client,
      destination: destination.client,
      transferId,
      manifest: prepared.manifest,
    });
    // Context mode must not inspect or launch the destination native importer.
    await writeFile(
      path.join(root, "destination", "claude-version.cjs"),
      "throw new Error('Native importer must not be used');\n",
    );
    const staged = await destination.daemon.daemon.handoffDestination.stage(transferId);
    expect(staged.claudeRuntime).toBeNull();
    expect(staged.preparedConversations).toEqual([{ sourceAgentId, title: null, mode: "context" }]);
    expect((await destination.client.fetchAgents()).entries).toEqual([]);
    const receipt = await origin.handoffSource.release(transferId);
    const stagedContext = path.join(
      staged.stagingCwd,
      `handoff-context-${staged.reservationId}`,
      staged.agentMappings[0].destinationAgentId,
      "timeline.json",
    );
    await writeFile(stagedContext, "modified context");
    await expect(
      destination.daemon.daemon.handoffDestination.acceptRelease(transferId, receipt),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(destination.daemon.daemon.handoffDestination.status(transferId).state).toBe("staged");
    await destination.daemon.daemon.handoffDestination.stage(transferId);
    expect(await readFile(stagedContext, "utf8")).toContain("previous-only-token");
    await destination.daemon.daemon.handoffDestination.acceptRelease(transferId, receipt);
    await stopHost(destination);
    destination = await startHost("destination", true);
    const active = await destination.daemon.daemon.handoffDestination.activate(transferId);
    const agentId = active.agentMappings[0].destinationAgentId;
    const record = await destination.daemon.daemon.agentStorage.get(agentId);
    expect(record?.persistence).toBeNull();
    expect(record?.handoffContext).toMatchObject({
      sourceAgentId,
      sourceCwd: await realpath(cwd),
      pending: true,
    });
    expect(record?.labels["paseo.handoff-mode"]).toBe("context");
    if (!record?.handoffContext) throw new Error("Missing continuation context");
    const contextDirectory = path.join(active.destinationCwd, record.handoffContext.directory);
    expect(await readFile(path.join(contextDirectory, "native", "transcript.jsonl"), "utf8")).toBe(
      transcript,
    );
    expect(await readFile(path.join(contextDirectory, "timeline.json"), "utf8")).toContain(
      "previous-only-token",
    );
    await expect(
      readdir(path.join(root, "destination", "claude", "projects")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await stopHost(destination);
    destination = await startHost("destination", true);
    expect(await destination.daemon.daemon.agentStorage.get(agentId)).toEqual(record);
    expect(await destination.daemon.daemon.handoffDestination.activate(transferId)).toEqual(active);
  },
  30_000,
);

test.skipIf(process.platform === "win32").each([
  { kind: "directory", hasGit: false, subdirEntries: [], prepare: async (_cwd: string) => {} },
  {
    kind: "git",
    hasGit: true,
    subdirEntries: [".keep"],
    prepare: async (cwd: string) => {
      await writeFile(path.join(cwd, "subdir", ".keep"), "");
      await exec("git", ["init", "--initial-branch=main"], { cwd });
      await exec("git", ["add", "work.txt", "subdir"], { cwd });
      await exec(
        "git",
        [
          "-c",
          "user.name=Handoff Test",
          "-c",
          "user.email=handoff@example.test",
          "commit",
          "-m",
          "Initial work",
        ],
        { cwd },
      );
    },
  },
])(
  "transfers native conversation artifacts and activates a $kind workspace across real daemon restarts",
  async ({ prepare, hasGit, subdirEntries }) => {
    let source = await startHost("source", true);
    let destination = await startHost("destination", true);
    let sourceDaemon = source.daemon.daemon;
    const transferId = randomUUID();
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    await mkdir(path.join(cwd, "subdir"));
    await writeFile(path.join(cwd, "work.txt"), "work in progress\n");
    await prepare(cwd);
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error(created.error?.message ?? "Workspace creation failed");
    const request = {
      transferId,
      sourceServerId: sourceDaemon.getServerId(),
      sourceWorkspaceId: created.workspace.id,
      sourceAgentIds: ["00000000-0000-4000-8000-000000000301"],
      destinationParent: root,
    };
    const reserved = await destination.daemon.daemon.handoffDestination.reserve(request);
    const sourceConfigDir = path.join(root, "source", "claude");
    const sessionId = randomUUID();
    const project = claudeProjectDirSync(cwd, { configDir: sourceConfigDir });
    await mkdir(project, { recursive: true });
    const transcript =
      JSON.stringify({
        type: "user",
        sessionId,
        message: { role: "user", content: "Complete the work from our prior conversation" },
      }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "Ready to continue" }] },
      }) +
      "\n";
    await writeFile(path.join(project, `${sessionId}.jsonl`), transcript);
    const timestamp = new Date().toISOString();
    await sourceDaemon.agentStorage.upsert(
      parseStoredAgentRecord({
        id: "00000000-0000-4000-8000-000000000301",
        provider: "claude",
        cwd,
        workspaceId: request.sourceWorkspaceId,
        createdAt: timestamp,
        updatedAt: timestamp,
        title: "Conversation to continue",
        lastStatus: "closed",
        persistence: { provider: "claude", sessionId, metadata: { cwd } },
      }),
    );
    const sourceRequest = {
      transferId,
      workspaceId: request.sourceWorkspaceId,
      agentIds: request.sourceAgentIds,
      destinationServerId: destination.daemon.daemon.getServerId(),
      reservationId: reserved.reservationId,
    };
    const prepared = await sourceDaemon.handoffSource.prepare(sourceRequest);
    const manifest = prepared.manifest;
    expect(prepared.source.state).toBe("ready");
    await stopHost(source);
    source = await startHost("source", true);
    sourceDaemon = source.daemon.daemon;
    expect(await sourceDaemon.handoffSource.prepare(sourceRequest)).toEqual(prepared);
    const binding = { transferId, publicKey: prepared.source.publicKey, manifest };
    const receiving = await destination.daemon.daemon.handoffDestination.bindSource(binding);
    await stopHost(destination);
    destination = await startHost("destination", true);
    expect(await destination.daemon.daemon.handoffDestination.reserve(request)).toEqual(receiving);
    await transferHandoffArchive({
      source: source.client,
      destination: destination.client,
      transferId,
      manifest,
    });
    const staged = await destination.daemon.daemon.handoffDestination.stage(transferId);
    const importedPath = path.join(
      root,
      "destination",
      "claude",
      "projects",
      `paseo-handoff-${reserved.agentMappings[0].destinationAgentId}`,
      `${sessionId}.jsonl`,
    );
    expect(await readFile(importedPath, "utf8")).toBe(transcript);
    expect(staged.preparedConversations).toEqual([
      {
        sourceAgentId: "00000000-0000-4000-8000-000000000301",
        title: "Conversation to continue",
        mode: "native",
        sessionId,
      },
    ]);
    expect(await readFile(path.join(staged.stagingCwd, "work.txt"), "utf8")).toBe(
      "work in progress\n",
    );
    expect(await readdir(path.join(staged.stagingCwd, "subdir"))).toEqual(subdirEntries);
    expect((await readdir(staged.stagingCwd)).includes(".git")).toBe(hasGit);
    await writeFile(path.join(cwd, "work.txt"), "changed after preparation\n");
    await expect(sourceDaemon.handoffSource.release(transferId)).rejects.toMatchObject({
      code: "source_changed",
    });
    await writeFile(path.join(cwd, "work.txt"), "work in progress\n");
    const sourceTranscript = path.join(project, `${sessionId}.jsonl`);
    await writeFile(
      sourceTranscript,
      transcript +
        JSON.stringify({
          type: "user",
          sessionId,
          message: { role: "user", content: "New source turn" },
        }) +
        "\n",
    );
    await expect(sourceDaemon.handoffSource.release(transferId)).rejects.toMatchObject({
      code: "source_changed",
    });
    expect(sourceDaemon.handoffOwnership.status(transferId).state).toBe("ready");
    await expect(
      sourceDaemon.handoffOwnership.withMutation({ cwd }, async () => {}),
    ).rejects.toMatchObject({ code: "fenced" });
    await writeFile(sourceTranscript, transcript);
    const receipt = await sourceDaemon.handoffSource.release(transferId);
    expect(await sourceDaemon.handoffSource.release(transferId)).toEqual(receipt);
    await rm(sourceTranscript);
    const sourceHistory = await source.client.fetchAgentTimeline(
      "00000000-0000-4000-8000-000000000301",
    );
    expect(JSON.stringify(sourceHistory.entries)).toContain(
      "Complete the work from our prior conversation",
    );
    expect(sourceDaemon.agentManager.getAgent("00000000-0000-4000-8000-000000000301")).toBeNull();
    await stopHost(source);
    source = await startHost("source", true);
    sourceDaemon = source.daemon.daemon;
    const restartedHistory = await source.client.fetchAgentTimeline(
      "00000000-0000-4000-8000-000000000301",
    );
    expect(restartedHistory.entries).toEqual(sourceHistory.entries);
    expect(restartedHistory.epoch).toBe(sourceHistory.epoch);
    expect(sourceDaemon.agentManager.getAgent("00000000-0000-4000-8000-000000000301")).toBeNull();
    const lastPage = await source.client.fetchAgentTimeline(request.sourceAgentIds[0], {
      limit: 1,
    });
    expect(lastPage.entries.map((entry) => entry.item.type)).toEqual(["assistant_message"]);
    if (!lastPage.startCursor) throw new Error("Missing history cursor");
    const priorPage = await source.client.fetchAgentTimeline(request.sourceAgentIds[0], {
      direction: "before",
      cursor: lastPage.startCursor,
      limit: 1,
    });
    expect(priorPage.entries.map((entry) => entry.item.type)).toEqual(["user_message"]);
    const historyFile = await sourceDaemon.handoffArchives.withVerifiedArchive(
      transferId,
      async (archive) => {
        const { bundle } = await readHandoffBundle(archive, {
          sourceServerId: request.sourceServerId,
          sourceWorkspaceId: request.sourceWorkspaceId,
          sourceAgentIds: request.sourceAgentIds,
          manifestDigest: manifest.entrypoint.sha256,
        });
        const history = bundle.conversations[0].history;
        if (!history) throw new Error("Missing readable conversation snapshot");
        return path.join(archive.blobsDirectory, history.sha256);
      },
    );
    const historyBytes = await readFile(historyFile);
    await writeFile(historyFile, "damaged history");
    await expect(source.client.fetchAgentTimeline(request.sourceAgentIds[0])).rejects.toThrow();
    expect(sourceDaemon.agentManager.getAgent(request.sourceAgentIds[0])).toBeNull();
    await writeFile(historyFile, historyBytes);
    expect((await source.client.fetchAgentTimeline(request.sourceAgentIds[0])).entries).toEqual(
      sourceHistory.entries,
    );
    const released = await destination.daemon.daemon.handoffDestination.acceptRelease(
      transferId,
      receipt,
    );
    await stopHost(destination);
    destination = await startHost("destination", true);
    expect(
      await destination.daemon.daemon.handoffDestination.acceptRelease(transferId, receipt),
    ).toEqual(released);
    await expect(
      destination.daemon.daemon.handoffDestination.cancel(transferId, null),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      sourceDaemon.handoffOwnership.withMutation({ cwd }, async () => {}),
    ).rejects.toMatchObject({ code: "fenced" });
    // Preparation must remain private until conversation installation and publication are complete.
    await expect(readdir(reserved.destinationCwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await destination.client.fetchAgents()).entries).toEqual([]);
    expect(await readFile(importedPath, "utf8")).toBe(transcript);
    const active = await destination.daemon.daemon.handoffDestination.activate(transferId);
    expect(active.state).toBe("active");
    expect(await destination.daemon.daemon.handoffDestination.activate(transferId)).toEqual(active);
    expect(await readFile(path.join(active.destinationCwd, "work.txt"), "utf8")).toBe(
      "work in progress\n",
    );
    expect((await readdir(active.destinationCwd)).includes(".git")).toBe(hasGit);
    const agentId = active.agentMappings[0].destinationAgentId;
    const record = await destination.daemon.daemon.agentStorage.get(agentId);
    expect(record).toMatchObject({
      id: agentId,
      workspaceId: active.workspaceId,
      cwd: active.destinationCwd,
      lastStatus: "closed",
      persistence: { sessionId },
    });
    expect((await destination.client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual(
      [agentId],
    );
    await stopHost(destination);
    destination = await startHost("destination", true);
    expect((await destination.client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual(
      [agentId],
    );
    expect(await destination.daemon.daemon.handoffDestination.activate(transferId)).toEqual(active);
  },
  30_000,
);

test.each(["missing", "corrupt", "foreign"])(
  "refuses daemon startup with a %s destination journal",
  async (damage) => {
    const destination = await startHost("destination");
    const journal = path.join(
      destination.daemon.paseoHome,
      "handoff-destination",
      "destination.json",
    );
    await stopHost(destination);
    if (damage === "missing") await rm(journal);
    else if (damage === "corrupt") await writeFile(journal, "{");
    else
      await writeFile(
        journal,
        JSON.stringify({ version: 1, serverId: "another-host", records: [] }),
      );
    await expect(startHost("destination")).rejects.toThrow();
  },
);

async function transferCapturedWorkspace(cwd: string) {
  const artifactDirectory = path.join(root, "snapshot");
  const destinationPath = path.join(root, "restored");
  const transferId = randomUUID();
  const snapshot = await captureWorkspace({ cwd, artifactDirectory });
  const sourceStore = new HandoffArchiveStore(
    path.join(root, "source", ".paseo", "handoff", "archives"),
  );
  const manifest = await packWorkspaceArchive({
    artifactDirectory,
    store: sourceStore,
    transferId,
  });
  await rm(artifactDirectory, { recursive: true });
  // Boot from the durable server-side import; the client never seeds source bytes.
  const source = await startHost("source");
  const destination = await startHost("destination");
  const transferred = await transferHandoffArchive({
    source: source.client,
    destination: destination.client,
    transferId,
    manifest,
  });
  expect(transferred.state).toBe("verified");
  expect((await destination.client.fetchAgents()).entries).toEqual([]);
  await stopHost(destination);
  // A reconstructed store restores directly from received blobs after daemon shutdown.
  const destinationStore = new HandoffArchiveStore(
    path.join(destination.daemon.paseoHome, "handoff", "archives"),
  );
  expect(
    await restoreWorkspaceArchive({
      store: destinationStore,
      transferId,
      destination: destinationPath,
    }),
  ).toEqual(snapshot);
  return { destinationPath, manifest };
}

test("transfers a captured Git workspace through two daemons and restores its staged and working bytes", async () => {
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  async function git(...args: string[]) {
    return (
      await exec("git", args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      })
    ).stdout;
  }
  await git("init", "--initial-branch=work");
  await git("config", "core.autocrlf", "false");
  await writeFile(path.join(cwd, "tracked"), "committed\n");
  await writeFile(path.join(cwd, ".gitignore"), ".env\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Handoff Test",
    "-c",
    "user.email=handoff@example.com",
    "commit",
    "-m",
    "local history",
  );
  await writeFile(path.join(cwd, "tracked"), "staged\n");
  await git("add", "tracked");
  await writeFile(path.join(cwd, "tracked"), "working\n");
  await writeFile(path.join(cwd, ".env"), "SOURCE_ONLY=1\n");
  const binary = Buffer.alloc(HANDOFF_CHUNK_BYTES + 17, 173);
  await writeFile(path.join(cwd, "binary"), binary);
  await writeFile(path.join(cwd, "same-binary"), binary);
  const originalStatus = await git("status", "--porcelain=v1", "-z");
  const originalHead = await git("rev-parse", "HEAD");
  const { destinationPath, manifest } = await transferCapturedWorkspace(cwd);
  expect(new Set(manifest.blobs.map((blob) => blob.sha256)).size).toBe(manifest.blobs.length);
  expect(await readFile(path.join(destinationPath, "tracked"), "utf8")).toBe("working\n");
  expect((await exec("git", ["show", ":tracked"], { cwd: destinationPath })).stdout).toBe(
    "staged\n",
  );
  expect(await readFile(path.join(destinationPath, "binary"))).toEqual(binary);
  expect(await readFile(path.join(destinationPath, "same-binary"))).toEqual(binary);
  await expect(readFile(path.join(destinationPath, ".env"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (await exec("git", ["status", "--porcelain=v1", "-z"], { cwd: destinationPath })).stdout,
  ).toBe(originalStatus);
  expect((await exec("git", ["rev-parse", "HEAD"], { cwd: destinationPath })).stdout).toBe(
    originalHead,
  );
  expect(await git("status", "--porcelain=v1", "-z")).toBe(originalStatus);
}, 30_000);

test("transfers an empty non-Git workspace with its manifest as the only archive blob", async () => {
  const cwd = path.join(root, "empty-workspace");
  await mkdir(cwd);
  const { destinationPath, manifest } = await transferCapturedWorkspace(cwd);
  expect(manifest.blobs).toEqual([manifest.entrypoint]);
  expect(await readdir(destinationPath)).toEqual([]);
}, 30_000);

test("streams bounded chunks between two real daemons and resumes after destination restart", async () => {
  const source = await startHost("source");
  let destination = await startHost("destination");
  const data = Buffer.alloc(HANDOFF_CHUNK_BYTES * 2 + 173);
  for (let index = 0; index < data.length; index++) data[index] = index % 251;
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  const manifest = { version: 1 as const, entrypoint: blob, blobs: [blob] };
  const transferId = randomUUID();
  expect((await source.client.handoffArchiveBegin({ transferId, manifest })).error).toBeNull();
  for (let offset = 0; offset < data.length; offset += HANDOFF_CHUNK_BYTES) {
    const chunk = data.subarray(offset, offset + HANDOFF_CHUNK_BYTES);
    expect(
      (
        await source.client.handoffArchiveWriteChunk({
          transferId,
          sha256: blob.sha256,
          offset,
          data: chunk.toString("base64"),
        })
      ).result,
    ).toBe(offset + chunk.length);
  }
  expect((await source.client.handoffArchiveSeal({ transferId })).result?.state).toBe("verified");
  expect((await destination.client.handoffArchiveBegin({ transferId, manifest })).error).toBeNull();
  const first = await source.client.handoffArchiveReadChunk({
    transferId,
    sha256: blob.sha256,
    offset: 0,
    length: HANDOFF_CHUNK_BYTES,
  });
  if (first.result === null) throw new Error("Source returned no chunk");
  expect(
    (
      await destination.client.handoffArchiveWriteChunk({
        transferId,
        sha256: blob.sha256,
        offset: 0,
        data: first.result,
      })
    ).result,
  ).toBe(HANDOFF_CHUNK_BYTES);

  await stopHost(destination);
  destination = await startHost("destination");
  expect((await destination.client.handoffArchiveStatus({ transferId })).result).toEqual({
    id: transferId,
    state: "receiving",
    blobs: [{ ...blob, receivedBytes: HANDOFF_CHUNK_BYTES }],
  });
  // A client that lost the acknowledgement can replay it without duplicating bytes.
  expect(
    (
      await destination.client.handoffArchiveWriteChunk({
        transferId,
        sha256: blob.sha256,
        offset: 0,
        data: first.result,
      })
    ).result,
  ).toBe(HANDOFF_CHUNK_BYTES);
  const progress: HandoffTransferProgress[] = [];
  expect(
    await transferHandoffArchive({
      source: source.client,
      destination: destination.client,
      transferId,
      manifest,
      onProgress: (value) => progress.push(value),
    }),
  ).toEqual({
    id: transferId,
    state: "verified",
    blobs: [{ ...blob, receivedBytes: blob.size }],
  });
  expect(progress).toEqual([
    { phase: "transferring", receivedBytes: HANDOFF_CHUNK_BYTES, totalBytes: blob.size },
    { phase: "transferring", receivedBytes: HANDOFF_CHUNK_BYTES * 2, totalBytes: blob.size },
    { phase: "transferring", receivedBytes: blob.size, totalBytes: blob.size },
    { phase: "verifying", receivedBytes: blob.size, totalBytes: blob.size },
    { phase: "verified", receivedBytes: blob.size, totalBytes: blob.size },
  ]);
  expect(
    await readFile(
      path.join(
        destination.daemon.paseoHome,
        "handoff",
        "archives",
        transferId,
        "blobs",
        blob.sha256,
      ),
    ),
  ).toEqual(data);
  expect((await destination.client.fetchAgents()).entries).toEqual([]);
}, 30_000);

test("returns correlated integrity and encoding failures and repairs an unverified blob", async () => {
  const { client } = await startHost("receiver");
  const transferId = randomUUID();
  const data = Buffer.from("preserve every byte");
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  await client.handoffArchiveBegin({
    transferId,
    manifest: { version: 1, entrypoint: blob, blobs: [blob] },
  });
  expect(
    await client.handoffArchiveWriteChunk({
      transferId,
      sha256: blob.sha256,
      offset: 0,
      data: "%%%",
      requestId: "bad-encoding",
    }),
  ).toEqual({
    requestId: "bad-encoding",
    transferId,
    result: null,
    error: {
      code: "invalid_chunk",
      message: "Chunk must use canonical base64 encoding",
      blob: null,
    },
  });
  await client.handoffArchiveWriteChunk({
    transferId,
    sha256: blob.sha256,
    offset: 0,
    data: Buffer.alloc(data.length).toString("base64"),
  });
  expect((await client.handoffArchiveSeal({ transferId })).error).toMatchObject({
    code: "integrity_mismatch",
    blob: blob.sha256,
  });
  expect(
    (
      await client.handoffArchiveReadChunk({
        transferId,
        sha256: blob.sha256,
        offset: 0,
        length: 10,
      })
    ).error,
  ).toMatchObject({ code: "invalid_state" });
  expect((await client.handoffArchiveResetBlob({ transferId, sha256: blob.sha256 })).result).toBe(
    true,
  );
  await client.handoffArchiveWriteChunk({
    transferId,
    sha256: blob.sha256,
    offset: 0,
    data: data.toString("base64"),
  });
  expect((await client.handoffArchiveSeal({ transferId })).result?.state).toBe("verified");
}, 30_000);

test("a socket lost after a committed write resumes from disk without duplicating the chunk", async () => {
  const source = await startHost("source");
  const destination = await startHost("destination");
  const transferId = randomUUID();
  const data = Buffer.alloc(HANDOFF_CHUNK_BYTES + 83, 137);
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  const manifest = { version: 1 as const, entrypoint: blob, blobs: [blob] };
  await source.client.handoffArchiveBegin({ transferId, manifest });
  for (let offset = 0; offset < data.length; offset += HANDOFF_CHUNK_BYTES) {
    await source.client.handoffArchiveWriteChunk({
      transferId,
      sha256: blob.sha256,
      offset,
      data: data.subarray(offset, offset + HANDOFF_CHUNK_BYTES).toString("base64"),
    });
  }
  await source.client.handoffArchiveSeal({ transferId });
  let droppedReplies = 0;
  const interrupted = new TransportClient({
    clientId: "handoff-lost-reply",
    url: `ws://127.0.0.1:${destination.daemon.port}/ws`,
    reconnect: { enabled: false },
    transportFactory: ({ url, headers, protocols }) => {
      const socket = new WebSocket(url, protocols, { headers });
      return {
        send: (value) => socket.send(value),
        close: (code, reason) => socket.close(code, reason),
        onOpen: (handler) => {
          socket.on("open", handler);
          return () => {
            socket.off("open", handler);
          };
        },
        onClose: (handler) => {
          socket.on("close", handler);
          return () => {
            socket.off("close", handler);
          };
        },
        onError: (handler) => {
          socket.on("error", handler);
          return () => {
            socket.off("error", handler);
          };
        },
        onMessage: (handler) => {
          const receive = (bytes: RawData, binary: boolean) => {
            const message = binary
              ? null
              : WSOutboundMessageSchema.parse(JSON.parse(bytes.toString()));
            if (
              message?.type === "session" &&
              message.message.type === "workspace.handoff.write_archive_chunk.response"
            ) {
              droppedReplies++;
              socket.terminate();
              return;
            }
            handler(bytes, binary);
          };
          socket.on("message", receive);
          return () => {
            socket.off("message", receive);
          };
        },
      };
    },
  });
  try {
    await interrupted.connect();
    await expect(
      transferHandoffArchive({
        source: source.client,
        destination: interrupted,
        transferId,
        manifest,
      }),
    ).rejects.toMatchObject({ name: "DaemonConnectionError" });
    expect(droppedReplies).toBe(1);
    expect((await destination.client.handoffArchiveStatus({ transferId })).result?.blobs).toEqual([
      { ...blob, receivedBytes: HANDOFF_CHUNK_BYTES },
    ]);
    expect(
      (
        await transferHandoffArchive({
          source: source.client,
          destination: destination.client,
          transferId,
          manifest,
        })
      ).state,
    ).toBe("verified");
    expect(
      await readFile(
        path.join(
          destination.daemon.paseoHome,
          "handoff",
          "archives",
          transferId,
          "blobs",
          blob.sha256,
        ),
      ),
    ).toEqual(data);
  } finally {
    await interrupted.close();
  }
}, 30_000);

test("pausing between chunks keeps verified source data and resumes only missing bytes", async () => {
  const source = await startHost("source");
  const destination = await startHost("destination");
  const transferId = randomUUID();
  const data = Buffer.alloc(HANDOFF_CHUNK_BYTES + 57, 42);
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  const manifest = { version: 1 as const, entrypoint: blob, blobs: [blob] };
  await source.client.handoffArchiveBegin({ transferId, manifest });
  for (let offset = 0; offset < data.length; offset += HANDOFF_CHUNK_BYTES) {
    await source.client.handoffArchiveWriteChunk({
      transferId,
      sha256: blob.sha256,
      offset,
      data: data.subarray(offset, offset + HANDOFF_CHUNK_BYTES).toString("base64"),
    });
  }
  await source.client.handoffArchiveSeal({ transferId });
  const pause = new AbortController();
  await expect(
    transferHandoffArchive({
      source: source.client,
      destination: destination.client,
      transferId,
      manifest,
      signal: pause.signal,
      onProgress: (progress) => {
        if (progress.receivedBytes === HANDOFF_CHUNK_BYTES)
          pause.abort(new Error("User paused the transfer"));
      },
    }),
  ).rejects.toThrow("User paused the transfer");
  expect((await destination.client.handoffArchiveStatus({ transferId })).result).toEqual({
    id: transferId,
    state: "receiving",
    blobs: [{ ...blob, receivedBytes: HANDOFF_CHUNK_BYTES }],
  });
  expect((await source.client.handoffArchiveStatus({ transferId })).result?.state).toBe("verified");
  expect(
    (
      await transferHandoffArchive({
        source: source.client,
        destination: destination.client,
        transferId,
        manifest,
      })
    ).state,
  ).toBe("verified");
}, 30_000);
