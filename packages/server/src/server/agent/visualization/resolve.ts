import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { writeJsonFileAtomic } from "../../atomic-file.js";

export const MAX_VISUALIZATION_BYTES = 1_000_000;
export const MAX_VISUALIZATION_STATE_BYTES = 16 * 1024;
const BASENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID = /^[a-zA-Z0-9_-]+$/;

export interface VisualizationAgent {
  id: string;
  provider: string;
  cwd: string;
  workspaceCwd?: string | null;
  persistence?: {
    sessionId: string;
    metadata?: Record<string, unknown>;
  } | null;
  internal?: boolean;
}

export interface VisualizationRead {
  canonicalPath: string;
  revision: string;
  html: string;
  state: VisualizationState | null;
}

export interface VisualizationState {
  modelContent: unknown;
  privateContent: unknown;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function validatePath(requested: string): void {
  if (
    !path.isAbsolute(requested) ||
    requested.length > 4096 ||
    [...requested].some(
      (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '"' || char === "'",
    ) ||
    requested.split(/[\\/]/).some((part) => part === ".." || part === ".") ||
    path.normalize(requested) !== requested ||
    !BASENAME.test(path.basename(requested))
  ) {
    throw new Error("Visualization unavailable");
  }
}

function assertAgent(agent: VisualizationAgent): void {
  if (agent.provider !== "codex" || agent.internal || !AGENT_ID.test(agent.id)) {
    throw new Error("Visualization unavailable");
  }
}

async function threadRoot(
  agent: VisualizationAgent,
  fallbackCodexHome: string,
  requested: string,
): Promise<{ root: string; codexHome: string } | null> {
  const threadId = agent.persistence?.sessionId;
  if (!threadId || !THREAD_ID.test(threadId)) return null;
  const metadataHome = agent.persistence?.metadata?.codexHome;
  const codexHome =
    typeof metadataHome === "string" && path.isAbsolute(metadataHome)
      ? metadataHome
      : fallbackCodexHome;
  const homes = [codexHome];
  try {
    const canonicalHome = await realpath(codexHome);
    if (canonicalHome !== codexHome) homes.push(canonicalHome);
  } catch {
    return null;
  }
  for (const home of homes) {
    const base = path.join(home, "visualizations");
    if (!inside(base, requested)) continue;
    const parts = path.relative(base, requested).split(path.sep);
    if (
      parts.length === 5 &&
      /^\d{4}$/.test(parts[0]) &&
      /^(0[1-9]|1[0-2])$/.test(parts[1]) &&
      /^(0[1-9]|[12]\d|3[01])$/.test(parts[2]) &&
      parts[3] === threadId
    ) {
      return { codexHome: home, root: path.join(base, ...parts.slice(0, 4)) };
    }
  }
  return null;
}

async function assertNoSymlinksBelow(root: string, requested: string): Promise<void> {
  const relative = path.relative(root, requested);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Visualization unavailable");
  }
  let current = root;
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
      throw new Error("Visualization unavailable");
    }
  }
}

function isJsonValue(value: unknown, seen: Set<object>, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false;
  if (Array.isArray(value)) {
    seen.add(value);
    const valid = value.every((item) => isJsonValue(item, seen, depth + 1));
    seen.delete(value);
    return valid;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return false;
  seen.add(value);
  const valid = Object.entries(value).every(
    ([key, item]) => key !== "__proto__" && isJsonValue(item, seen, depth + 1),
  );
  seen.delete(value);
  return valid;
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of handle.createReadStream({ start: 0, end: limit, autoClose: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) throw new Error("Visualization unavailable");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

export function normalizeVisualizationState(value: unknown): VisualizationState {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.keys(value).every((key) => key === "modelContent" || key === "privateContent")
  ) {
    throw new Error("Visualization state is invalid");
  }
  const input = value as Record<string, unknown>;
  const normalized = {
    modelContent: input.modelContent ?? null,
    privateContent: input.privateContent ?? null,
  };
  if (!isJsonValue(normalized, new Set(), 0)) {
    throw new Error("Visualization state is invalid");
  }
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_VISUALIZATION_STATE_BYTES) {
    throw new Error("Visualization state is too large");
  }
  return normalized;
}

export class CodexVisualizationStore {
  private readonly codexHome: string;
  private readonly afterResolve?: () => Promise<void>;

  constructor(
    private readonly paseoHome: string,
    options: { codexHome?: string; afterResolve?: () => Promise<void> } = {},
  ) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
    this.afterResolve = options.afterResolve;
  }

  private async resolve(
    agent: VisualizationAgent,
    requested: string,
  ): Promise<{
    canonicalPath: string;
    info: Awaited<ReturnType<typeof stat>>;
    root: string;
    pathBelowRoot: string;
  }> {
    assertAgent(agent);
    validatePath(requested);
    const thread = await threadRoot(agent, this.codexHome, requested);
    const roots = [agent.cwd, agent.workspaceCwd, thread?.root].filter(
      (root): root is string => typeof root === "string" && path.isAbsolute(root),
    );
    for (const rootPath of roots) {
      let canonicalRoot: string;
      try {
        if (thread?.root === rootPath) await assertNoSymlinksBelow(thread.codexHome, rootPath);
        else if ((await lstat(rootPath)).isSymbolicLink()) continue;
        canonicalRoot = await realpath(rootPath);
        if (!(await stat(canonicalRoot)).isDirectory()) continue;
      } catch {
        continue;
      }
      let pathBelowRoot: string | null = null;
      if (inside(rootPath, requested)) pathBelowRoot = rootPath;
      else if (inside(canonicalRoot, requested)) pathBelowRoot = canonicalRoot;
      if (!pathBelowRoot) continue;
      await assertNoSymlinksBelow(pathBelowRoot, requested);
      const canonicalPath = await realpath(requested);
      if (!inside(canonicalRoot, canonicalPath)) break;
      const info = await stat(canonicalPath);
      if (!info.isFile() || info.size > MAX_VISUALIZATION_BYTES) break;
      return { canonicalPath, info, root: canonicalRoot, pathBelowRoot };
    }
    throw new Error("Visualization unavailable");
  }

  private async openVerified(agent: VisualizationAgent, requested: string) {
    const resolved = await this.resolve(agent, requested);
    await this.afterResolve?.();
    const handle = await open(
      resolved.canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size > MAX_VISUALIZATION_BYTES ||
        opened.dev !== resolved.info.dev ||
        opened.ino !== resolved.info.ino
      ) {
        throw new Error("Visualization unavailable");
      }
      const bytes = await readBounded(handle, MAX_VISUALIZATION_BYTES);
      await assertNoSymlinksBelow(resolved.pathBelowRoot, requested);
      if ((await realpath(requested)) !== resolved.canonicalPath) {
        throw new Error("Visualization unavailable");
      }
      if (!inside(resolved.root, resolved.canonicalPath)) {
        throw new Error("Visualization unavailable");
      }
      return {
        canonicalPath: resolved.canonicalPath,
        revision: createHash("sha256").update(bytes).digest("hex"),
        html: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } finally {
      await handle.close();
    }
  }

  private statePath(agentId: string, canonicalPath: string): string {
    if (!AGENT_ID.test(agentId)) throw new Error("Visualization unavailable");
    const digest = createHash("sha256").update(canonicalPath).digest("hex");
    return path.join(this.paseoHome, "visualization-state", agentId, `${digest}.json`);
  }

  private async stateDirectory(agentId: string, create: boolean): Promise<void> {
    const root = path.join(this.paseoHome, "visualization-state");
    const directory = path.join(root, agentId);
    if (create) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    if (!(await lstat(root)).isDirectory() || !(await lstat(directory)).isDirectory()) {
      throw new Error("Visualization unavailable");
    }
    const canonicalRoot = await realpath(root);
    const canonicalDirectory = await realpath(directory);
    if (!inside(canonicalRoot, canonicalDirectory) || canonicalDirectory === canonicalRoot) {
      throw new Error("Visualization unavailable");
    }
  }

  private async readState(
    agentId: string,
    canonicalPath: string,
  ): Promise<VisualizationState | null> {
    const filename = this.statePath(agentId, canonicalPath);
    try {
      await this.stateDirectory(agentId, false);
      const info = await lstat(filename);
      if (!info.isFile() || info.size > MAX_VISUALIZATION_STATE_BYTES + 1024) {
        throw new Error("Visualization unavailable");
      }
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.size > MAX_VISUALIZATION_STATE_BYTES + 1024 ||
          opened.dev !== info.dev ||
          opened.ino !== info.ino
        ) {
          throw new Error("Visualization unavailable");
        }
        const stored: unknown = JSON.parse(
          (await readBounded(handle, MAX_VISUALIZATION_STATE_BYTES + 1024)).toString("utf8"),
        );
        if (
          typeof stored !== "object" ||
          stored === null ||
          !("path" in stored) ||
          stored.path !== canonicalPath ||
          !("state" in stored)
        ) {
          throw new Error("Visualization unavailable");
        }
        return normalizeVisualizationState(stored.state);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async get(agent: VisualizationAgent, requested: string): Promise<VisualizationRead> {
    const file = await this.openVerified(agent, requested);
    return { ...file, state: await this.readState(agent.id, file.canonicalPath) };
  }

  async setState(agent: VisualizationAgent, requested: string, value: unknown) {
    const state = normalizeVisualizationState(value);
    const file = await this.openVerified(agent, requested);
    await this.stateDirectory(agent.id, true);
    await writeJsonFileAtomic(this.statePath(agent.id, file.canonicalPath), {
      path: file.canonicalPath,
      state,
    });
    return state;
  }

  async deleteAgent(agentId: string): Promise<void> {
    if (!AGENT_ID.test(agentId)) throw new Error("Invalid agent ID");
    await rm(path.join(this.paseoHome, "visualization-state", agentId), {
      recursive: true,
      force: true,
    });
  }
}
