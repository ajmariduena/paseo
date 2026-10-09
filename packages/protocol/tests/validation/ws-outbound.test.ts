import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";
import { WSOutboundMessageSchema as GeneratedWSOutboundMessageSchema } from "../../src/generated/validation/ws-outbound.aot.js";

interface GeneratedSchema {
  safeParse(input: unknown): { success: boolean; data?: unknown };
}

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedWSOutboundPath = resolve(
  protocolRoot,
  "src/generated/validation/ws-outbound.aot.ts",
);
const require = createRequire(import.meta.url);

async function compileInlineSchema(sourceSchema: string): Promise<GeneratedSchema> {
  const scratchRoot = resolve(protocolRoot, "../../.tmp");
  await mkdir(scratchRoot, { recursive: true });
  const tempDir = await mkdtemp(join(scratchRoot, "paseo-zod-aot-"));

  try {
    const sourcePath = join(tempDir, "schema.source.js");
    const outputPath = join(tempDir, "schema.generated.ts");
    await writeFile(join(tempDir, "package.json"), '{"type":"module"}\n');
    await writeFile(
      sourcePath,
      [
        'import { z } from "zod";',
        'import { compile } from "zod-aot";',
        sourceSchema,
        "export const Schema = compile(SourceSchema);",
        "",
      ].join("\n"),
    );

    const zodAotEntry = require.resolve("zod-aot");
    const zodAotRoot = resolve(dirname(zodAotEntry), "..");
    const [{ discoverSchemas }, { compileSchemas }, { generateCompiledFileContent }] =
      await Promise.all([
        import(pathToFileURL(resolve(zodAotRoot, "dist/discovery.js")).href),
        import(pathToFileURL(resolve(zodAotRoot, "dist/core/pipeline.js")).href),
        import(pathToFileURL(resolve(zodAotRoot, "dist/cli/emitter.js")).href),
      ]);

    const schemas = await discoverSchemas(sourcePath, { cacheBust: true });
    const compiled = compileSchemas(schemas, { mode: "inline" });
    const content = generateCompiledFileContent(compiled, "./schema.source.js", {
      zodCompat: false,
    });
    await writeFile(outputPath, content);

    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const generated = await jiti.import(outputPath);
    return generated.Schema as GeneratedSchema;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("WS outbound zod-aot validation", () => {
  it("validates handoff activation snapshots without losing continuation mode or correlation", () => {
    const result = {
      transferId: "00000000-0000-4000-8000-000000000001",
      reservationId: "00000000-0000-4000-8000-000000000002",
      sourceServerId: "source",
      sourceWorkspaceId: "original-workspace",
      sourceAgentIds: ["original-agent"],
      destinationParent: "/workspaces",
      destinationCwd: "/workspaces/imported",
      workspaceId: "new-workspace",
      projectId: "new-project",
      agentMappings: [
        {
          sourceAgentId: "original-agent",
          destinationAgentId: "00000000-0000-4000-8000-000000000003",
        },
      ],
      continuationMode: "context",
      state: "active",
      manifestDigest: "a".repeat(64),
    };
    const envelope = (value: unknown) => ({
      type: "session",
      message: {
        type: "workspace.handoff.activate_destination.response",
        payload: { requestId: "activate", result: value, error: null },
      },
    });
    for (const continuationMode of ["native", "context"]) {
      const message = envelope({ ...result, continuationMode });
      expect(GeneratedWSOutboundMessageSchema.safeParse(message)).toEqual({
        success: true,
        data: message,
      });
    }
    for (const invalid of [
      { ...result, continuationMode: "unknown" },
      { ...result, manifestDigest: "corrupt" },
      { ...result, state: "unknown" },
    ]) {
      expect(GeneratedWSOutboundMessageSchema.safeParse(envelope(invalid)).success).toBe(false);
    }
  });

  it.each([
    "cancel_source",
    "cancel_destination",
    "inspect_source",
    "prepare_source",
    "get_source_status",
    "release_source",
    "reserve_destination",
    "bind_destination",
    "stage_destination",
    "get_destination_status",
    "activate_destination",
  ])("accepts correlated handoff errors for %s", (operation) => {
    const envelope = {
      type: "session",
      message: {
        type: `workspace.handoff.${operation}.response`,
        payload: {
          requestId: "failed",
          result: null,
          error: { code: "invalid_state", message: "Cannot continue", blob: null },
        },
      },
    };
    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it("applies defaults inside discriminated-union branches", async () => {
    const schema = await compileInlineSchema(`
const SourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("with_default"),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("without_default"),
    label: z.string(),
  }),
]);
`);

    expect(schema.safeParse({ type: "with_default" })).toMatchObject({
      success: true,
      data: { type: "with_default", enabled: true },
    });
  });

  it("routes tool-call-like status unions through the current sequential item union", async () => {
    const schema = await compileInlineSchema(`
const ToolCallItemSchema = z.discriminatedUnion("status", [
  z.object({ type: z.literal("tool_call"), status: z.literal("running"), callId: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("completed"), callId: z.string(), output: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("failed"), callId: z.string(), error: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("canceled"), callId: z.string() }),
]);

const TimelineItemSchema = z.union([
  z.object({ type: z.literal("assistant_message"), text: z.string() }),
  ToolCallItemSchema,
]);

const SourceSchema = z.object({
  item: TimelineItemSchema,
});
`);

    expect(
      schema.safeParse({ item: { type: "tool_call", status: "running", callId: "run" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "running", callId: "run" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "completed", callId: "done", output: "ok" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "completed", callId: "done", output: "ok" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" } },
    });
    expect(
      schema.safeParse({ item: { type: "tool_call", status: "canceled", callId: "stop" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "canceled", callId: "stop" } },
    });
  });

  it("accepts a minimal valid envelope and rejects a corrupted envelope", () => {
    expect(GeneratedWSOutboundMessageSchema.safeParse({ type: "pong" }).success).toBe(true);
    expect(GeneratedWSOutboundMessageSchema.safeParse({ type: "not_a_message" }).success).toBe(
      false,
    );
  });

  it("accepts worktree storage replies and an older server without the feature flag", () => {
    const list = {
      type: "session",
      message: {
        type: "workspace.storage.list.response",
        payload: {
          requestId: "storage-list",
          entries: [
            {
              entryId: "entry-1",
              name: "branch",
              project: "repo",
              sizeBytes: 1024,
              freeable: true,
              reason: "archived",
            },
          ],
          totalBytes: 1024,
          freeableBytes: 1024,
          sizesComplete: true,
          error: null,
        },
      },
    };
    const cleanup = {
      type: "session",
      message: {
        type: "workspace.storage.cleanup.response",
        payload: {
          requestId: "storage-cleanup",
          results: [{ entryId: "entry-1", removed: true, error: null }],
          error: null,
        },
      },
    };
    expect(GeneratedWSOutboundMessageSchema.safeParse(list).success).toBe(true);
    expect(GeneratedWSOutboundMessageSchema.safeParse(cleanup).success).toBe(true);
    expect(
      GeneratedWSOutboundMessageSchema.safeParse({
        type: "session",
        message: { type: "status", payload: { status: "server_info", serverId: "old-host" } },
      }).success,
    ).toBe(true);
  });

  it("accepts project config responses with and without setup commit status", () => {
    const payload = {
      requestId: "project-config-read",
      repoRoot: "/repo",
      ok: true,
      config: null,
      revision: null,
    };
    const envelope = (
      responsePayload: typeof payload & {
        hasUncommittedWorktreeSetupChanges?: boolean;
      },
    ) => ({
      type: "session",
      message: {
        type: "read_project_config_response",
        payload: responsePayload,
      },
    });

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope(payload)).success).toBe(true);
    expect(
      GeneratedWSOutboundMessageSchema.safeParse(
        envelope({ ...payload, hasUncommittedWorktreeSetupChanges: true }),
      ).success,
    ).toBe(true);
  });

  it("accepts a compact provider snapshot envelope", () => {
    const envelope = {
      type: "session",
      message: {
        type: "get_providers_snapshot_response",
        payload: {
          entries: [],
          compactSnapshot: {
            entries: [
              {
                provider: "pi",
                status: "ready",
                enabled: true,
                models: [{ id: "model-a", label: "Model A", thinkingSet: 0 }],
              },
            ],
            thinkingSets: [
              {
                options: [{ id: "high", label: "High", isDefault: true }],
                defaultOptionId: "high",
              },
            ],
          },
          snapshotHash: "snapshot-hash",
          generatedAt: "2026-08-04T00:00:00.000Z",
          requestId: "provider-snapshot",
        },
      },
    };

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it.each([
    {
      name: "dedicated attention message",
      message: {
        type: "agent_attention_required",
        payload: {
          agentId: "agent-1",
          reason: "finished",
          timestamp: "2026-07-22T18:00:00.000Z",
          shouldNotify: true,
          notification: {
            title: "Agent finished",
            body: "Done",
            data: {
              serverId: "server-1",
              workspaceId: "workspace-1",
              agentId: "agent-1",
              reason: "finished",
            },
          },
        },
      },
    },
    {
      name: "agent stream attention event",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          timestamp: "2026-07-22T18:00:00.000Z",
          event: {
            type: "attention_required",
            provider: "codex",
            reason: "finished",
            timestamp: "2026-07-22T18:00:00.000Z",
            shouldNotify: true,
            notification: {
              title: "Agent finished",
              body: "Done",
              data: {
                serverId: "server-1",
                workspaceId: "workspace-1",
                agentId: "agent-1",
                reason: "finished",
              },
            },
          },
        },
      },
    },
  ])("preserves workspaceId in a $name", ({ message }) => {
    const envelope = { type: "session", message };

    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it("accepts remote browser replies, including failures", () => {
    const envelope = (payload: unknown) => ({
      type: "session",
      message: { type: "browser.remote.execute.response", payload },
    });
    expect(
      GeneratedWSOutboundMessageSchema.safeParse(
        envelope({
          requestId: "req-1",
          ok: false,
          error: { code: "browser_no_host", message: "No host", retryable: true },
        }),
      ).success,
    ).toBe(true);
    expect(
      GeneratedWSOutboundMessageSchema.safeParse(
        envelope({
          requestId: "req-1",
          ok: true,
          result: {
            command: "new_tab",
            browserId: "11111111-1111-4111-8111-111111111111",
            workspaceId: "workspace-1",
            url: "https://example.com",
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("emits runtime imports with .js extensions", async () => {
    const generated = await readFile(generatedWSOutboundPath, "utf8");
    expect(generated).toContain('from "../../validation/ws-outbound-schema-metadata.js"');
  });

  it("accepts a forge.search.response envelope", () => {
    const result = GeneratedWSOutboundMessageSchema.safeParse({
      type: "session",
      message: {
        type: "forge.search.response",
        payload: {
          items: [
            {
              kind: "change_request",
              number: 17,
              title: "Fix search",
              url: "https://gitlab.com/acme/repo/-/merge_requests/17",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          authState: "authenticated",
          error: null,
          requestId: "search-forge",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a legacy github_search_response envelope", () => {
    const result = GeneratedWSOutboundMessageSchema.safeParse({
      type: "session",
      message: {
        type: "github_search_response",
        payload: {
          items: [
            {
              kind: "pr",
              number: 42,
              title: "Legacy PR",
              url: "https://github.com/acme/repo/pull/42",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          featuresEnabled: true,
          githubFeaturesEnabled: true,
          authState: "authenticated",
          error: null,
          requestId: "search-github",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
