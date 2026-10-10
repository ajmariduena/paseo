import { readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { AgentProviderRuntimeSettingsMapSchema } from "@getpaseo/protocol/provider-config";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { createTestAgentClients } from "./fake-agent-client.js";
import { createTestPaseoDaemon } from "./paseo-daemon.js";

async function main(): Promise<void> {
  const metroPort = process.env.E2E_METRO_PORT;
  if (!metroPort) {
    throw new Error("E2E_METRO_PORT is not set");
  }

  const claudeConfigDir = process.env.E2E_REAL_CLAUDE_CONFIG_DIR;
  const providerSettings = process.env.E2E_PROVIDER_SETTINGS
    ? AgentProviderRuntimeSettingsMapSchema.parse(JSON.parse(process.env.E2E_PROVIDER_SETTINGS))
    : undefined;
  if (claudeConfigDir && providerSettings)
    throw new Error("Choose either a real Claude home or fake-provider runtime settings");
  const runtimeSettings = claudeConfigDir
    ? { env: { CLAUDE_CONFIG_DIR: claudeConfigDir } }
    : undefined;
  const daemon = await createTestPaseoDaemon({
    agentProviderSettings: runtimeSettings ? { claude: runtimeSettings } : providerSettings,
    agentClients: runtimeSettings
      ? { claude: new ClaudeAgentClient({ logger: pino({ level: "warn" }), runtimeSettings }) }
      : createTestAgentClients({
          supportsMcpServers: process.env.E2E_MCP_SERVERS_SUPPORTED === "1",
          claudeRuntime: providerSettings?.claude?.env?.CLAUDE_CONFIG_DIR
            ? { configDir: providerSettings.claude.env.CLAUDE_CONFIG_DIR, cliVersion: "2.1.295" }
            : undefined,
        }),
    corsAllowedOrigins: [`http://localhost:${metroPort}`],
    daemonVersion: process.env.E2E_DAEMON_VERSION ?? "0.0.0",
    workspaceHandoffCapability: process.env.E2E_WORKSPACE_HANDOFF_CAPABILITY === "1",
    desktopManaged: process.env.E2E_DESKTOP_MANAGED === "1",
    daemonStatusRpcCapability: process.env.E2E_DAEMON_STATUS_RPC_CAPABILITY !== "0",
    relayConfigCapability: process.env.E2E_RELAY_CONFIG_CAPABILITY !== "0",
  });
  const serverId = (await readFile(path.join(daemon.paseoHome, "server-id"), "utf8")).trim();

  // Browser fixtures seed pending work without sending a synthetic provider turn.
  process.on(
    "message",
    (message: { type?: string; requestId: string; agentId: string; prompt: string }) => {
      if (message.type !== "seed-held-queue") return;
      void (async () => {
        const queue = daemon.daemon.agentManager.messageQueue;
        await queue.hold(message.agentId, "user_stop");
        const pending = await queue.enqueue(
          message.agentId,
          {
            id: message.requestId,
            origin: "user",
            senderAgentId: null,
            textPreview: "",
            prompt: message.prompt,
            wake: null,
          },
          async () => {
            throw new Error("Fixture queue must remain held");
          },
        );
        void pending.settled.catch(() => {});
      })().then(
        () => process.send?.({ type: "queue-seeded", requestId: message.requestId }),
        (error: unknown) =>
          process.send?.({
            type: "queue-seeded",
            requestId: message.requestId,
            error: String(error),
          }),
      );
    },
  );

  process.send?.({
    type: "ready",
    paseoHome: daemon.paseoHome,
    endpoint: `127.0.0.1:${daemon.port}`,
    serverId,
  });

  const shutdown = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  process.send?.({
    type: "error",
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exit(1);
});
