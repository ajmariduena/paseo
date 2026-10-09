import { z } from "zod";

const UrlsSchema = z.array(z.string().min(1).max(4096)).min(1).max(16);
export const WorkspaceRemotesSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(128),
      fetchUrls: UrlsSchema,
      pushUrls: UrlsSchema.nullable(),
    }),
  )
  .max(64);
export type WorkspaceRemotes = z.infer<typeof WorkspaceRemotesSchema>;
type RunGit = (args: string[], acceptExitCodes?: number[]) => Promise<string>;
type Refuse = (message: string) => never;
interface ValidateRemotesInput {
  remotes: WorkspaceRemotes;
  refuse: Refuse;
}
interface CaptureRemotesInput {
  run: RunGit;
  refuse: Refuse;
}
interface RestoreRemotesInput {
  run: RunGit;
  remotes: WorkspaceRemotes;
}
interface ConfiguredUrlsInput {
  config: string;
  name: string;
  kind: "url" | "pushurl";
}
interface SanitizeUrlsInput {
  output: string;
  count: number;
  refuse: Refuse;
}

function portableRemoteName(name: string): boolean {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) &&
    !name.includes("..") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock")
  );
}

function sanitizedRemoteUrl(value: string): string | null {
  if (!value || value.length > 4096 || /[\s\\\p{Cc}]/u.test(value)) return null;
  if (!value.includes("://")) {
    // SCP paths may be relative to the remote login. Local paths and helpers are host-owned.
    if (/^[a-zA-Z]:/.test(value)) return null;
    return /^(?:[a-zA-Z0-9._-]+@)?(?:\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]*):[^:?#@][^?#@]*$/.test(
      value,
    )
      ? value
      : null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !["https:", "http:", "ssh:", "git:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === "/" ||
    value.includes("?") ||
    value.includes("#")
  )
    return null;
  const parts = /^(https?|ssh|git):\/\/([^/]+)(\/.*)$/i.exec(value);
  if (!parts) return null;
  // SSH login names select the destination account; passwords never migrate.
  const username = url.protocol === "ssh:" ? url.username : "";
  if (username && !/^[a-zA-Z0-9._-]+$/.test(username)) return null;
  const authority = parts[2].slice(parts[2].lastIndexOf("@") + 1);
  // URL serialization normalizes dot segments, which can change an SSH path through a symlink.
  return `${parts[1]}://${username ? `${username}@` : ""}${authority}${parts[3]}`;
}

export function validateWorkspaceRemotes({ remotes, refuse }: ValidateRemotesInput): void {
  const names = new Set<string>();
  for (const remote of remotes) {
    const key = remote.name.toLowerCase();
    if (!portableRemoteName(remote.name) || names.has(key))
      refuse("Git remote names must be unique and portable between hosts");
    names.add(key);
    for (const url of [...remote.fetchUrls, ...(remote.pushUrls ?? [])]) {
      if (sanitizedRemoteUrl(url) !== url)
        refuse("Git remote URLs must be sanitized network URLs without queries or fragments");
    }
  }
}

function configuredUrls({ config, name, kind }: ConfiguredUrlsInput): string[] {
  const prefix = `remote.${name}.${kind}\n`;
  return config
    .split("\0")
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
}

function sanitizeUrls({ output, count, refuse }: SanitizeUrlsInput): string[] {
  const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : [];
  if (lines.length !== count) refuse("Git remote URL output is ambiguous");
  return lines.map((line) => {
    const url = sanitizedRemoteUrl(line);
    if (!url)
      return refuse(
        "Use network Git remote URLs without queries or fragments before moving the workspace",
      );
    return url;
  });
}

export async function captureWorkspaceRemotes({
  run,
  refuse,
}: CaptureRemotesInput): Promise<WorkspaceRemotes> {
  const names = (await run(["remote"])).trimEnd().split("\n").filter(Boolean).sort();
  if (names.length > 64) refuse("Too many Git remotes to transfer");
  const config = await run(
    ["config", "--null", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
    [0, 1],
  );
  const remotes: WorkspaceRemotes = [];
  for (const name of names) {
    if (!portableRemoteName(name))
      refuse("Rename nonportable Git remotes before moving the workspace");
    const fetch = configuredUrls({ config, name, kind: "url" });
    const push = configuredUrls({ config, name, kind: "pushurl" });
    if (fetch.length === 0 || fetch.length > 16 || push.length > 16)
      refuse("Git remotes require one to sixteen configured URLs");
    if ([...fetch, ...push].some((url) => !url || /\p{Cc}/u.test(url)))
      refuse("Git remote URLs contain unsupported control characters");
    // Git resolves insteadOf/pushInsteadOf here without connecting to the remote.
    const fetchUrls = sanitizeUrls({
      output: await run(["remote", "get-url", "--all", name]),
      count: fetch.length,
      refuse,
    });
    const pushUrls = sanitizeUrls({
      output: await run(["remote", "get-url", "--push", "--all", name]),
      count: push.length || fetch.length,
      refuse,
    });
    remotes.push({
      name,
      fetchUrls,
      // Preserve implicit push behavior unless a host rewrite gave it another destination.
      pushUrls:
        push.length || JSON.stringify(fetchUrls) !== JSON.stringify(pushUrls) ? pushUrls : null,
    });
  }
  validateWorkspaceRemotes({ remotes, refuse });
  return remotes;
}

export async function restoreWorkspaceRemotes({
  run,
  remotes,
}: RestoreRemotesInput): Promise<void> {
  for (const remote of remotes) {
    await run(["remote", "add", "--", remote.name, remote.fetchUrls[0]]);
    for (const url of remote.fetchUrls.slice(1))
      await run(["config", "--add", `remote.${remote.name}.url`, url]);
    for (const url of remote.pushUrls ?? [])
      await run(["config", "--add", `remote.${remote.name}.pushurl`, url]);
  }
}
