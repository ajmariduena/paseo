import { z } from "zod";
import { isGitRefName } from "./workspace-references.js";
import type { WorkspaceRemotes } from "./workspace-remotes.js";

export const WorkspaceTrackingSchema = z
  .array(
    z.object({
      key: z.string().min(1).max(1200),
      values: z.array(z.string().max(4096)).min(1).max(64),
    }),
  )
  .max(8192);
export type WorkspaceTracking = z.infer<typeof WorkspaceTrackingSchema>;
type RunGit = (args: string[], acceptExitCodes?: number[]) => Promise<string>;
type Refuse = (message: string) => never;

const TRACKING_KEYS =
  "^(branch\\..*\\.(remote|merge|pushremote|rebase|mergeoptions)|remote\\..*\\.(fetch|push|tagopt|prune|prunetags|mirror)|remote\\.pushdefault|push\\.(default|followtags|autosetupremote)|pull\\.(ff|rebase)|fetch\\.(prune|prunetags))$";
const BOOLEAN = /^(true|false|yes|no|on|off|1|0)$/i;
const REBASE = /^(true|false|yes|no|on|off|1|0|merges|m|interactive|i)$/i;

function refPattern(value: string): boolean {
  const parts = value.split("*");
  return parts.length <= 2 && isGitRefName(parts.join("handoff-wildcard"));
}

function refspec(value: string, kind: "fetch" | "push"): boolean {
  if (kind === "fetch" && value.startsWith("^")) return refPattern(value.slice(1));
  const spec = value.startsWith("+") ? value.slice(1) : value;
  if (kind === "push" && spec === ":") return true;
  const [source, destination, extra] = spec.split(":");
  if (extra !== undefined) return false;
  const sourceValid =
    source === "HEAD" || refPattern(source) || /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(source);
  if (!sourceValid && !(kind === "push" && source === "" && destination)) return false;
  if (destination !== undefined && destination !== "" && !refPattern(destination)) return false;
  const sourceStars = source.split("*").length - 1;
  const destinationStars = (destination ?? "").split("*").length - 1;
  return sourceStars === destinationStars;
}

interface ValidateInput {
  tracking: WorkspaceTracking;
  remotes: Pick<WorkspaceRemotes[number], "name">[];
  refuse: Refuse;
}

function validValue(key: string, value: string, names: ReadonlySet<string>): boolean {
  const branch = /^branch\.(.+)\.(remote|merge|pushremote|rebase)$/.exec(key);
  if (branch) {
    if (!isGitRefName(`refs/heads/${branch[1]}`)) return false;
    if (branch[2] === "merge") return isGitRefName(value);
    if (branch[2] === "rebase") return REBASE.test(value);
    return value === "." || names.has(value);
  }
  const remote = /^remote\.(.+)\.(fetch|push|tagopt|prune|prunetags|mirror)$/.exec(key);
  if (remote) {
    if (!names.has(remote[1])) return false;
    const kind = remote[2];
    if (kind === "fetch" || kind === "push") return refspec(value, kind);
    if (kind === "tagopt") return value === "--tags" || value === "--no-tags";
    if (kind === "mirror") return /^(false|no|off|0)$/i.test(value);
    return BOOLEAN.test(value);
  }
  if (key === "remote.pushdefault") return names.has(value);
  if (key === "push.default")
    return /^(nothing|current|upstream|tracking|simple|matching)$/.test(value);
  if (key === "pull.rebase") return REBASE.test(value);
  if (key === "pull.ff") return value === "only" || BOOLEAN.test(value);
  return (
    /^(push\.(followtags|autosetupremote)|fetch\.(prune|prunetags))$/.test(key) &&
    BOOLEAN.test(value)
  );
}

export function validateWorkspaceTracking({ tracking, remotes, refuse }: ValidateInput): void {
  if (!WorkspaceTrackingSchema.safeParse(tracking).success)
    refuse("Git tracking configuration exceeds handoff limits");
  const names = new Set(remotes.map((remote) => remote.name));
  const keys = new Set<string>();
  for (const entry of tracking) {
    if (keys.has(entry.key)) refuse("Git tracking configuration contains duplicate keys");
    keys.add(entry.key);
    for (const value of entry.values) {
      if (!validValue(entry.key, value, names))
        refuse(
          "Git tracking requires named remotes and portable refspecs; resolve custom merge options or mirror policies before handoff",
        );
    }
  }
}

interface CaptureInput {
  run: RunGit;
  refuse: Refuse;
}

export async function captureWorkspaceTracking({
  run,
  refuse,
}: CaptureInput): Promise<WorkspaceTracking> {
  const keys = await run(
    ["config", "--null", "--name-only", "--get-regexp", "^remote\\..*\\.url$"],
    [0, 1],
  );
  const remotes = keys
    .split("\0")
    .filter(Boolean)
    .map((key) => ({ name: key.slice(7, -4) }));
  const config = await run(["config", "--null", "--get-regexp", TRACKING_KEYS], [0, 1]);
  const grouped = new Map<string, string[]>();
  for (const entry of config.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n");
    if (separator === -1) return refuse("Git tracking configuration requires explicit values");
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    const values = grouped.get(key) ?? [];
    values.push(value);
    grouped.set(key, values);
  }
  const tracking = [...grouped.entries()]
    .sort(([a], [b]) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    })
    .map(([key, values]) => ({ key, values }));
  validateWorkspaceTracking({ tracking, remotes, refuse });
  return tracking;
}

interface RestoreInput {
  run: RunGit;
  tracking: WorkspaceTracking;
  remotes: WorkspaceRemotes;
}

export async function restoreWorkspaceTracking({
  run,
  tracking,
  remotes,
}: RestoreInput): Promise<void> {
  // remote add synthesizes a default fetch mapping, including when the source has none.
  for (const remote of remotes)
    await run(["config", "--unset-all", `remote.${remote.name}.fetch`], [0, 5]);
  for (const entry of tracking) {
    for (const value of entry.values) await run(["config", "--add", entry.key, value]);
  }
}
