import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { MAX_AGENT_WAIT_MS } from "./mcp-shared.js";
import { PASEO_MCP_TOOL_TIMEOUT_MS, withRuntimePaseoMcpServer } from "./runtime-mcp-config.js";
import { PASEO_READ_ONLY_TOOL_NAMES } from "./tools/read-only-tools.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
  test("injects the paseo MCP server with a bearer header when a token is provided", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      toolTimeoutMs: PASEO_MCP_TOOL_TIMEOUT_MS,
      preapprovedTools: PASEO_READ_ONLY_TOOL_NAMES,
      headers: { Authorization: "Bearer cap-token" },
    });
  });

  test("omits the header when no token is available", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: null,
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      toolTimeoutMs: PASEO_MCP_TOOL_TIMEOUT_MS,
      preapprovedTools: PASEO_READ_ONLY_TOOL_NAMES,
    });
  });

  test("lets a client outlast the longest blocking Paseo tool call", () => {
    expect(PASEO_MCP_TOOL_TIMEOUT_MS).toBeGreaterThan(MAX_AGENT_WAIT_MS);
  });

  test("does not inject when no MCP base URL is configured", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: null,
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers).toBeUndefined();
  });
});
