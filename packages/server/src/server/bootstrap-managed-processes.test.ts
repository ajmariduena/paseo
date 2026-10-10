import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessRegistry,
  ManagedProcessReapResult,
} from "./managed-processes/managed-processes.js";
import { createPaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";

let tempRoot: string | null = null;
let staticDir: string | null = null;

afterEach(async () => {
  await Promise.all([
    tempRoot ? rm(tempRoot, { recursive: true, force: true }) : Promise.resolve(),
    staticDir ? rm(staticDir, { recursive: true, force: true }) : Promise.resolve(),
  ]);
  tempRoot = null;
  staticDir = null;
});

describe("daemon managed process bootstrap", () => {
  test.skipIf(process.platform === "win32").each([
    { closed: true, remaining: 0 },
    { closed: false, remaining: 1 },
  ])(
    "handoff retires saved stop acknowledgements only for durable closed owners ($closed)",
    async ({ closed, remaining }) => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-receipt-bootstrap-"));
      staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
      const paseoHome = path.join(tempRoot, ".paseo");
      const logger = pino({ level: "silent" });
      const agentStoragePath = path.join(paseoHome, "agents");
      const owner = new AgentManager({
        registry: new AgentStorage(agentStoragePath, logger),
        clients: createTestAgentClients(),
        logger,
      });
      const agent = await owner.createAgent({ provider: "codex", cwd: tempRoot }, undefined, {
        workspaceId: undefined,
      });
      if (!agent.runtimeGenerationId) throw new Error("Missing fixture runtime generation");
      const root = { pid: 4101, parentPid: 1, startedAt: "owner", exited: false };
      let entries = [root];
      const managedProcesses = createManagedProcessRegistry({
        paseoHome,
        logger,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        processTree: {
          bootId: async () => "boot",
          list: async () => entries,
          signal: () => {
            entries = [];
          },
        },
      });
      const processRecord = await managedProcesses.record({
        owner: { provider: "claude", kind: "query" },
        runtime: { agentId: agent.id, generationId: agent.runtimeGenerationId },
        pid: root.pid,
        command: "claude",
        args: [],
        processTree: { bootId: "boot", entries: [root] },
      });
      await managedProcesses.stop(processRecord.id);
      if (closed) await owner.closeAgent(agent.id);
      const daemon = await createPaseoDaemon(
        {
          listen: "127.0.0.1:0",
          paseoHome,
          corsAllowedOrigins: [],
          hostnames: true,
          mcpEnabled: false,
          staticDir,
          mcpDebug: false,
          agentClients: createTestAgentClients(),
          agentStoragePath,
          relayEnabled: false,
          appBaseUrl: "https://app.paseo.sh",
          managedProcesses,
        } as PaseoDaemonConfig,
        logger,
      );
      try {
        await daemon.stop();
        expect(await managedProcesses.list({ includeStopped: true })).toHaveLength(remaining);
      } finally {
        await owner.flushForShutdown();
      }
    },
  );

  test("handoff recovery runs during bootstrap and drains before daemon shutdown finishes", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-bootstrap-"));
    staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const paseoHome = path.join(tempRoot, ".paseo");
    const finishRecovery = Promise.withResolvers<void>();
    const managedProcesses = new FakeManagedProcesses(finishRecovery.promise);
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: false,
        appBaseUrl: "https://app.paseo.sh",
        managedProcesses,
      } as PaseoDaemonConfig,
      pino({ level: "silent" }),
    );

    const resourcesStopped = Promise.withResolvers<void>();
    const stopProxy = daemon.serviceProxy.stopStandalone.bind(daemon.serviceProxy);
    const proxyStop = vi
      .spyOn(daemon.serviceProxy, "stopStandalone")
      .mockImplementation(async () => {
        await stopProxy();
        resourcesStopped.resolve();
      });
    let stopped = false;
    const stopping = daemon.stop().then(() => {
      stopped = true;
      return undefined;
    });
    try {
      expect(managedProcesses.reapCount).toBe(1);
      expect(managedProcesses.reapFinished).toBe(false);
      await resourcesStopped.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      finishRecovery.resolve();
      await stopping;
      expect(managedProcesses.reapFinished).toBe(true);
      expect(stopped).toBe(true);
    } finally {
      finishRecovery.resolve();
      await stopping;
      proxyStop.mockRestore();
    }
  });
});

class FakeManagedProcesses implements ManagedProcessRegistry {
  async retireStoppedRuntime(): Promise<void> {}

  reapCount = 0;
  reapFinished = false;

  constructor(private readonly finishRecovery: Promise<void>) {}

  async stop(): Promise<void> {
    throw new Error("No tracked process tree in this fixture");
  }

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    return {
      id: "unused",
      ...input,
      metadata: input.metadata ?? {},
      identity: { commandLine: null, startedAt: null },
      createdAt: "unused",
    };
  }

  async remove(): Promise<void> {}

  async list(): Promise<ManagedProcessRecord[]> {
    return [];
  }

  async reapStale(): Promise<ManagedProcessReapResult> {
    this.reapCount += 1;
    await this.finishRecovery;
    this.reapFinished = true;
    return {
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 1,
      terminated: 1,
      errors: [],
    };
  }
}
