import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../../agent/agent-manager.js";
import { AgentStorage } from "../../agent/agent-storage.js";
import type { PaseoToolCatalog, PaseoToolResult } from "../../agent/tools/types.js";
import type { SelectableModel } from "./agent-selection.js";
import { VoiceToolbox, type VoiceAgentDefaults } from "./voice-toolbox.js";

const logger = pino({ level: "silent" });
const models: Record<string, SelectableModel[]> = {
  codex: [
    {
      provider: "codex",
      id: "gpt-6-astra",
      label: "GPT-6-Astra",
      isDefault: true,
      thinkingOptions: [
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra high" },
      ],
    },
  ],
  claude: [
    {
      provider: "claude",
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      isDefault: true,
      thinkingOptions: [
        { id: "high", label: "High" },
        { id: "ultracode", label: "Ultra Code" },
      ],
    },
  ],
};

class MemoryCatalog implements PaseoToolCatalog {
  readonly tools = new Map();
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly createdWorkspaces: Record<string, unknown>[] = [];
  readonly createdAgents: Record<string, unknown>[] = [];
  readonly notes: Record<string, unknown>[] = [];
  agentResult: Record<string, unknown> = { agentId: "created-agent", status: "running" };
  modelFailure = false;
  workspaceFailure = false;
  agentFailure = false;
  providersAvailable = true;
  workspaces: Array<{
    workspaceId: string;
    projectId: string;
    cwd: string;
    kind: string;
    title: string;
  }> = [];

  getTool(): undefined {
    return undefined;
  }

  async executeTool(name: string, input: unknown): Promise<PaseoToolResult> {
    const args = input as Record<string, unknown>;
    this.calls.push({ name, args: structuredClone(args) });
    let result: unknown;
    switch (name) {
      case "list_providers":
        result = {
          providers: this.providersAvailable
            ? Object.keys(models).map((id) => ({ id, enabled: true, status: "available" }))
            : [],
        };
        break;
      case "list_models":
        if (this.modelFailure) throw new Error("Catalog unavailable");
        result = { models: models[String(args.provider)] ?? [] };
        break;
      case "list_workspaces":
        result = { workspaces: this.workspaces };
        break;
      case "create_workspace":
        if (this.workspaceFailure)
          return { isError: true, content: [{ type: "text", text: "Workspace creation failed" }] };
        this.createdWorkspaces.push(structuredClone(args));
        result = { workspaceId: "created-workspace", title: args.title };
        break;
      case "create_agent":
        if (this.agentFailure)
          return { isError: true, content: [{ type: "text", text: "Agent launch failed" }] };
        this.createdAgents.push(structuredClone(args));
        result = this.agentResult;
        break;
      case "create_note":
        this.notes.push(structuredClone(args));
        result = { id: `note-${this.notes.length}` };
        break;
      default:
        throw new Error(`Unexpected catalog operation: ${name}`);
    }
    return { content: [], structuredContent: structuredClone(result) };
  }
}

const owned: Array<{ root: string; manager: AgentManager }> = [];
afterEach(async () => {
  for (const entry of owned.splice(0)) {
    entry.manager.messageQueue.close();
    await rm(entry.root, { recursive: true, force: true });
  }
});

async function setup(
  defaults: VoiceAgentDefaults = {
    provider: "claude",
    models: { claude: "claude-opus-5-5" },
    thinking: { claude: "high" },
  },
) {
  const root = await mkdtemp(join(tmpdir(), "paseo-voice-toolbox-"));
  const manager = new AgentManager({ logger });
  owned.push({ root, manager });
  const catalog = new MemoryCatalog();
  const toolbox = new VoiceToolbox({
    catalog: async () => catalog,
    agentManager: manager,
    agentStorage: new AgentStorage(join(root, "agents"), logger),
    hostMetrics: null,
    hostLabel: () => "Mini",
    defaults: () => defaults,
    logger,
  });
  return { toolbox, catalog, defaults };
}

function startArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: "Revisa el login, sin modificar código ni publicar.",
    title: "Revisar acceso",
    rootPath: "/work/paseo",
    projectId: "project-paseo",
    ...extra,
  };
}

describe("VoiceToolbox agent creation", () => {
  it.each([
    { model: "Astra", effort: "high", providerModel: "codex/gpt-6-astra", thinking: "high" },
    { model: "Astra", effort: "extra high", providerModel: "codex/gpt-6-astra", thinking: "xhigh" },
    {
      model: "Opus 5.5",
      effort: "high",
      providerModel: "claude/claude-opus-5-5",
      thinking: "high",
    },
    {
      model: "Opus 5.5",
      effort: "ultra code",
      providerModel: "claude/claude-opus-5-5",
      thinking: "ultracode",
    },
  ])(
    "creates one workspace and starts $model at $effort with the complete task",
    async ({ model, effort, providerModel, thinking }) => {
      const { toolbox, catalog, defaults } = await setup();
      const savedDefaults = structuredClone(defaults);
      const result = await toolbox.execute({
        operationId: "request-1",
        tool: "start_agent",
        args: startArgs({ model, effort }),
      });
      expect(result.ok).toBe(true);
      expect(catalog.createdWorkspaces).toEqual([
        {
          isolation: "worktree",
          path: "/work/paseo",
          projectId: "project-paseo",
          title: "Revisar acceso",
        },
      ]);
      expect(catalog.createdAgents).toEqual([
        {
          title: "Revisar acceso",
          provider: providerModel,
          initialPrompt: "Revisa el login, sin modificar código ni publicar.",
          workspaceId: "created-workspace",
          background: true,
          notifyOnFinish: false,
          clientRequestId: "request-1",
          settings: { thinkingOptionId: thinking },
        },
      ]);
      const names = catalog.calls.map((call) => call.name);
      expect(names.indexOf("create_workspace")).toBeGreaterThan(names.lastIndexOf("list_models"));
      expect(defaults).toEqual(savedDefaults);
      expect(result.detail).toBe("agentId created-agent");
    },
  );

  it.each([
    { model: "Missing model", effort: "high" },
    { model: "Astra", effort: "impossible level" },
  ])(
    "creates nothing when an explicit selection is unavailable: $model / $effort",
    async (selection) => {
      const { toolbox, catalog } = await setup();
      const result = await toolbox.execute({
        operationId: "request-1",
        tool: "start_agent",
        args: startArgs(selection),
      });
      expect(result.ok).toBe(false);
      expect(result.text).toContain("Nothing was created");
      expect(catalog.createdWorkspaces).toEqual([]);
      expect(catalog.createdAgents).toEqual([]);
    },
  );

  it("uses the app defaults when no selection was spoken", async () => {
    const { toolbox, catalog } = await setup();
    expect(
      (await toolbox.execute({ operationId: "request-1", tool: "start_agent", args: startArgs() }))
        .ok,
    ).toBe(true);
    expect(catalog.createdAgents[0]).toMatchObject({
      provider: "claude/claude-opus-5-5",
      settings: { thinkingOptionId: "high" },
    });
  });

  it("uses the courier's defaults on a remote host instead of that host's local call defaults", async () => {
    const { toolbox, catalog } = await setup();
    const defaults = {
      provider: "codex",
      models: { codex: "gpt-6-astra" },
      thinking: { codex: "xhigh" },
    };
    const result = await toolbox.execute({
      operationId: "request-1",
      tool: "start_agent",
      args: startArgs({ defaults }),
    });
    expect(result.ok).toBe(true);
    expect(catalog.createdAgents[0]).toMatchObject({
      provider: "codex/gpt-6-astra",
      settings: { thinkingOptionId: "xhigh" },
    });
  });

  it("creates nothing when the model catalog cannot be read", async () => {
    const { toolbox, catalog } = await setup();
    catalog.modelFailure = true;
    expect(
      (
        await toolbox.execute({
          operationId: "request-1",
          tool: "start_agent",
          args: startArgs({ model: "Astra" }),
        })
      ).ok,
    ).toBe(false);
    expect(catalog.createdWorkspaces).toEqual([]);
    expect(catalog.createdAgents).toEqual([]);
  });

  it("creates only a workspace when that is explicitly requested, even without a provider", async () => {
    const { toolbox, catalog } = await setup();
    catalog.providersAvailable = false;
    const result = await toolbox.execute({
      operationId: "request-1",
      tool: "create_workspace",
      args: { title: "Preparar acceso", rootPath: "/work/paseo", projectId: "project-paseo" },
    });
    expect(result.ok).toBe(true);
    expect(catalog.calls.map(({ name }) => name)).toEqual(["create_workspace"]);
    expect(catalog.createdAgents).toEqual([]);
    expect(result.text).toContain("no agent yet");
  });

  it("starts directly in an explicitly selected existing workspace", async () => {
    const { toolbox, catalog } = await setup();
    const result = await toolbox.execute({
      operationId: "request-1",
      tool: "start_agent",
      args: startArgs({ workspaceId: "existing-workspace" }),
    });
    expect(result.ok).toBe(true);
    expect(catalog.createdWorkspaces).toEqual([]);
    expect(catalog.createdAgents[0]?.workspaceId).toBe("existing-workspace");
  });

  it("does not start an agent if workspace creation fails", async () => {
    const { toolbox, catalog } = await setup();
    catalog.workspaceFailure = true;
    expect(
      (await toolbox.execute({ operationId: "request-1", tool: "start_agent", args: startArgs() }))
        .ok,
    ).toBe(false);
    expect(catalog.createdAgents).toEqual([]);
  });

  it("does not announce a running agent without its confirmed id", async () => {
    const { toolbox, catalog } = await setup();
    catalog.agentResult = { status: "initializing" };
    const result = await toolbox.execute({
      operationId: "request-1",
      tool: "start_agent",
      args: startArgs(),
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("was created but the agent did not start");
  });

  it("deduplicates concurrent and later deliveries of the same operation", async () => {
    const { toolbox, catalog } = await setup();
    const request = { operationId: "request-1", tool: "start_agent", args: startArgs() };
    const [first, second] = await Promise.all([toolbox.execute(request), toolbox.execute(request)]);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(await toolbox.execute(request)).toEqual(first);
    expect(catalog.createdWorkspaces).toHaveLength(1);
    expect(catalog.createdAgents).toHaveLength(1);
  });

  it("does not report a failed agent as working merely because creation returned an id", async () => {
    const { toolbox, catalog } = await setup();
    catalog.agentResult = { agentId: "failed-agent", status: "error" };
    const result = await toolbox.execute({
      operationId: "request-1",
      tool: "start_agent",
      args: startArgs(),
    });
    expect(result.ok).toBe(false);
    expect(result.text).not.toContain("It is working");
  });

  it("rejects reusing an operation id for different arguments instead of acknowledging the wrong effect", async () => {
    const { toolbox, catalog } = await setup();
    await toolbox.execute({
      operationId: "request-1",
      tool: "create_note",
      args: { title: "Primera nota" },
    });
    const result = await toolbox.execute({
      operationId: "request-1",
      tool: "create_note",
      args: { title: "Segunda nota" },
    });
    expect(result.ok).toBe(false);
    expect(catalog.notes).toEqual([{ title: "Primera nota" }]);
  });
});
