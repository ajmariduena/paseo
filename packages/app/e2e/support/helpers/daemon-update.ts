import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentProviderRuntimeSettingsMap } from "@getpaseo/protocol/provider-config";
import { killProcessTree } from "./spawn-node";
import type { AgentPromptInput } from "../../../../server/src/server/agent/agent-sdk-types";

export interface OutdatedDaemon {
  paseoHome: string;
  endpoint: string;
  label: string;
  serverId: string;
  seedHeldQueue(agentId: string, prompt: AgentPromptInput): Promise<void>;
  holdNextClaudeTurn(agentId: string): Promise<void>;
  close(): Promise<void>;
}

interface OutdatedDaemonReadyMessage {
  paseoHome: string;
  type: "ready";
  endpoint: string;
  serverId: string;
}

interface OutdatedDaemonErrorMessage {
  type: "error";
  error: string;
}

type OutdatedDaemonMessage = OutdatedDaemonReadyMessage | OutdatedDaemonErrorMessage;

interface TestDaemonOptions {
  version?: string;
  realClaudeConfigDir?: string;
  workspaceHandoffCapability?: boolean;
  mcpServersSupported?: boolean;
  providerSettings?: AgentProviderRuntimeSettingsMap;
  desktopManaged?: boolean;
  daemonStatusRpcCapability?: boolean;
  relayConfigCapability?: boolean;
}

export function startOutdatedDaemon(options?: TestDaemonOptions): Promise<OutdatedDaemon> {
  return startTestDaemon({ ...options, version: "0.0.0" });
}

export async function startTestDaemon(options?: TestDaemonOptions): Promise<OutdatedDaemon> {
  const metroPort = process.env.E2E_METRO_PORT;
  if (!metroPort) {
    throw new Error("E2E_METRO_PORT is not set - globalSetup must run first");
  }

  const child = fork(
    path.resolve(__dirname, "../../../../server/src/server/test-utils/outdated-daemon-process.ts"),
    {
      env: {
        ...process.env,
        E2E_METRO_PORT: metroPort,
        E2E_DAEMON_VERSION: options?.version,
        E2E_REAL_CLAUDE_CONFIG_DIR: options?.realClaudeConfigDir,
        E2E_PROVIDER_SETTINGS: options?.providerSettings
          ? JSON.stringify(options.providerSettings)
          : undefined,
        E2E_MCP_SERVERS_SUPPORTED: options?.mcpServersSupported === true ? "1" : "0",
        E2E_WORKSPACE_HANDOFF_CAPABILITY: options?.workspaceHandoffCapability === true ? "1" : "0",
        E2E_DESKTOP_MANAGED: options?.desktopManaged === true ? "1" : "0",
        E2E_DAEMON_STATUS_RPC_CAPABILITY: options?.daemonStatusRpcCapability === false ? "0" : "1",
        E2E_RELAY_CONFIG_CAPABILITY: options?.relayConfigCapability === false ? "0" : "1",
      },
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const stderr: string[] = [];
  child.stderr?.on("data", (data: Buffer) => stderr.push(data.toString("utf8")));

  try {
    const ready = await waitForDaemon(child, stderr);
    return {
      paseoHome: ready.paseoHome,
      endpoint: ready.endpoint,
      label: options?.desktopManaged === true ? "outdated Desktop host" : "outdated host",
      serverId: ready.serverId,
      seedHeldQueue: (agentId, prompt) => seedHeldQueue(child, agentId, prompt),
      holdNextClaudeTurn: (agentId) => holdNextClaudeTurn(child, agentId),
      close: () => killProcessTree(child),
    };
  } catch (error) {
    await killProcessTree(child);
    throw error;
  }
}

function holdNextClaudeTurn(child: ChildProcess, agentId: string): Promise<void> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: { type?: string; requestId?: string; error?: string }) => {
      if (message.type !== "claude-turn-held" || message.requestId !== requestId) return;
      finish(message.error ? new Error(message.error) : undefined);
    };
    const onExit = () => finish(new Error("Test daemon exited while holding a Claude turn"));
    const timeout = setTimeout(() => finish(new Error("Timed out holding a Claude turn")), 10_000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.send({ type: "hold-next-claude-turn", requestId, agentId }, (error) => {
      if (error) finish(error);
    });
  });
}

function seedHeldQueue(
  child: ChildProcess,
  agentId: string,
  prompt: AgentPromptInput,
): Promise<void> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: { type?: string; requestId?: string; error?: string }) => {
      if (message.type !== "queue-seeded" || message.requestId !== requestId) return;
      finish(message.error ? new Error(message.error) : undefined);
    };
    const onExit = () => finish(new Error("Test daemon exited while seeding a held queue"));
    const timeout = setTimeout(() => finish(new Error("Timed out seeding a held queue")), 10_000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.send({ type: "seed-held-queue", requestId, agentId, prompt }, (error) => {
      if (error) finish(error);
    });
  });
}

async function waitForDaemon(
  child: ChildProcess,
  stderr: string[],
): Promise<OutdatedDaemonReadyMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out starting outdated daemon. ${stderr.join("")}`));
    }, 20_000);

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Outdated daemon exited before startup (code ${String(code)}, signal ${String(signal)}). ${stderr.join("")}`,
        ),
      );
    });
    child.once("message", (message: OutdatedDaemonMessage) => {
      if (message.type === "error") {
        clearTimeout(timeout);
        reject(new Error(message.error));
        return;
      }
      clearTimeout(timeout);
      resolve(message);
    });
  });
}
