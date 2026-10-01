import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const builtinPlugins = [
  "claude-usage-source",
  "codex-usage-source",
  "copilot-usage-source",
  "cursor-usage-source",
  "grok-usage-source",
  "kimi-usage-source",
  "minimax-usage-source",
  "opencode-go-usage-source",
  "zai-usage-source",
] as const;

// Plugins compile with esbuild's native binary, which cannot read inside app.asar. The
// desktop build unpacks built-ins next to it, so prefer that real directory.
function asarUnpackedPath(candidate: string): string | null {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  return candidate.includes(asarSegment)
    ? candidate.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
    : null;
}

export function resolveBuiltinPluginsRoot(
  moduleUrl: string | URL = import.meta.url,
  exists: (candidate: string) => boolean = existsSync,
): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const packaged = path.resolve(moduleDir, "..", "..", "..", "builtin-plugins");
  const unpacked = asarUnpackedPath(packaged);
  const candidates = [
    ...(unpacked ? [unpacked] : []),
    packaged,
    path.resolve(moduleDir, "..", "..", "..", "..", "..", "..", "plugins"),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? packaged;
}

export interface BuiltinPlugin {
  id: string;
  directory: string;
}

export class BuiltinPluginLoader {
  readonly ids: ReadonlySet<string>;

  constructor(
    private readonly root = resolveBuiltinPluginsRoot(),
    private readonly list: readonly string[] = builtinPlugins,
  ) {
    this.ids = new Set(list);
  }

  async load(start: (plugin: BuiltinPlugin) => Promise<void>): Promise<void> {
    for (const id of this.list) {
      await start({ id, directory: path.join(this.root, id) });
    }
  }
}
