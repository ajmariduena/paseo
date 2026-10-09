import { readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { createTestPaseoDaemon } from "./paseo-daemon.js";

async function main(): Promise<void> {
  const metroPort = process.env.E2E_METRO_PORT;
  if (!metroPort) {
    throw new Error("E2E_METRO_PORT is not set");
  }

  const claudeConfigDir = process.env.E2E_REAL_CLAUDE_CONFIG_DIR;
  const runtimeSettings = claudeConfigDir
    ? { env: { CLAUDE_CONFIG_DIR: claudeConfigDir } }
    : undefined;
  const daemon = await createTestPaseoDaemon({
    agentProviderSettings: runtimeSettings ? { claude: runtimeSettings } : undefined,
    agentClients: runtimeSettings
      ? { claude: new ClaudeAgentClient({ logger: pino({ level: "warn" }), runtimeSettings }) }
      : undefined,
    corsAllowedOrigins: [`http://localhost:${metroPort}`],
    daemonVersion: process.env.E2E_DAEMON_VERSION ?? "0.0.0",
    workspaceHandoffCapability: process.env.E2E_WORKSPACE_HANDOFF_CAPABILITY === "1",
    desktopManaged: process.env.E2E_DESKTOP_MANAGED === "1",
    daemonStatusRpcCapability: process.env.E2E_DAEMON_STATUS_RPC_CAPABILITY !== "0",
    relayConfigCapability: process.env.E2E_RELAY_CONFIG_CAPABILITY !== "0",
  });
  const serverId = (await readFile(path.join(daemon.paseoHome, "server-id"), "utf8")).trim();

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
