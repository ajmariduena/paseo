import { z } from "zod";

export const GitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const WorkspaceReferencesSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(1024),
      oid: GitObjectIdSchema,
      target: z.string().min(1).max(1024).nullable(),
    }),
  )
  .max(4096);
export type WorkspaceReferences = z.infer<typeof WorkspaceReferencesSchema>;
type RunGit = (args: string[], input?: string) => Promise<string>;
type Refuse = (message: string) => never;

export function isGitRefName(name: string): boolean {
  return (
    name.startsWith("refs/") &&
    !/[\s\p{Cc}~^:?*[\\]/u.test(name) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    !name.endsWith(".") &&
    name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

interface ValidateInput {
  references: WorkspaceReferences;
  head: string | null;
  branch: string | null;
  objectFormat: "sha1" | "sha256";
  refuse: Refuse;
}

export function validateWorkspaceReferences(input: ValidateInput): void {
  const { references, head, branch, objectFormat, refuse } = input;
  const parsed = WorkspaceReferencesSchema.safeParse(references);
  if (!parsed.success) refuse("Git reference inventory exceeds the supported format or limits");
  const refs = new Map(references.map((ref) => [ref.name, ref]));
  if (refs.size !== references.length) refuse("Git references must be unique");
  for (const ref of references) {
    if (!isGitRefName(ref.name) || !/^refs\/(heads|tags|remotes|notes)\//.test(ref.name))
      refuse(
        "Move or remove stashes, replacement refs and unsupported Git namespaces before handoff",
      );
    if (ref.oid.length !== (objectFormat === "sha1" ? 40 : 64))
      refuse("Git reference object format does not match the repository");
    validateSymbolicReference({ ref, refs, refuse });
  }
  if (branch !== null) {
    const name = `refs/heads/${branch}`;
    if (!isGitRefName(name)) refuse("Git HEAD must name a valid local branch");
    const selected = refs.get(name);
    if ((selected?.oid ?? null) !== head || selected?.target)
      refuse("Git HEAD must match its direct branch reference");
  } else if (head === null) {
    refuse("Git HEAD must name a branch or a commit");
  }
}

interface SymbolicInput {
  ref: WorkspaceReferences[number];
  refs: ReadonlyMap<string, WorkspaceReferences[number]>;
  refuse: Refuse;
}

function validateSymbolicReference({ ref, refs, refuse }: SymbolicInput): void {
  const visited = new Set([ref.name]);
  let current = ref;
  while (current.target !== null) {
    const target = refs.get(current.target);
    if (!target || visited.has(target.name) || target.oid !== ref.oid)
      return refuse("Git symbolic references require matching, acyclic targets inside the archive");
    visited.add(target.name);
    current = target;
  }
}

interface CaptureInput {
  run: RunGit;
  refuse: Refuse;
}

export async function captureWorkspaceReferences({
  run,
  refuse,
}: CaptureInput): Promise<WorkspaceReferences> {
  const output = await run([
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(objectname)%00%(symref)",
  ]);
  const references = output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, oid, target, extra] = line.split("\0");
      if (extra !== undefined || target === undefined) refuse("Git reference output is ambiguous");
      return { name, oid, target: target || null };
    });
  const parsed = WorkspaceReferencesSchema.safeParse(references);
  if (!parsed.success)
    return refuse("Git reference inventory exceeds the supported format or limits");
  return parsed.data;
}

interface BundleInput {
  run: RunGit;
  bundlePath: string;
  references: WorkspaceReferences;
  head: string | null;
  refuse: Refuse;
}

export async function verifyWorkspaceBundle({
  run,
  bundlePath,
  references,
  head,
  refuse,
}: BundleInput): Promise<void> {
  const expected = references.map((ref) => `${ref.oid} ${ref.name}`);
  if (head) expected.push(`${head} HEAD`);
  const output = await run(["bundle", "list-heads", bundlePath]);
  const actual = output.split("\n").filter(Boolean);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected.sort()))
    refuse("Git bundle references differ from the captured inventory");
}

interface RestoreInput extends BundleInput {
  branch: string | null;
}

export async function restoreWorkspaceReferences(input: RestoreInput): Promise<void> {
  await verifyWorkspaceBundle(input);
  const { run, bundlePath, references, head, branch } = input;
  await run(["bundle", "verify", bundlePath]);
  await run(["bundle", "unbundle", bundlePath]);
  const direct = references
    .filter((ref) => ref.target === null)
    .map((ref) => `create ${ref.name} ${ref.oid}`);
  await run(["update-ref", "--stdin"], ["start", ...direct, "prepare", "commit", ""].join("\n"));
  for (const ref of references) {
    if (ref.target !== null) await run(["symbolic-ref", ref.name, ref.target]);
  }
  if (head) {
    if (branch === null) await run(["update-ref", "--no-deref", "HEAD", head]);
    await run(["read-tree", "HEAD"]);
  }
}
