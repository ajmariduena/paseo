import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HandoffDigestSchema, HandoffTransferIdSchema } from "@getpaseo/protocol/handoff";
import {
  HandoffReleaseBindingSchema as BindingSchema,
  HandoffReleaseReceiptSchema as ReceiptSchema,
  HandoffCancellationBindingSchema,
  HandoffCancellationProofSchema,
  type HandoffCancellationProof,
} from "@getpaseo/protocol/handoff-control";
import { readBoundedFile, syncDirectory, writeJournal } from "./artifacts.js";

const SourceSchema = z.object({
  id: HandoffTransferIdSchema,
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  agentIds: z.array(z.string().min(1)).max(1000),
  destinationServerId: z.string().min(1),
  reservationId: HandoffTransferIdSchema,
  workspaceReviewDigest: HandoffDigestSchema.optional(),
});
const RecordSchema = SourceSchema.extend({
  state: z.enum(["preparing", "ready", "released", "cancelled"]),
  manifestDigest: HandoffDigestSchema.nullable(),
  privateKey: z.string().min(1).max(1024),
  publicKey: z.string().min(1).max(1024),
});
const CancellationRecordSchema = HandoffCancellationBindingSchema.extend({
  privateKey: z.string().min(1).max(1024),
  publicKey: z.string().min(1).max(1024),
});
const JournalSchema = z.object({
  version: z.literal(1),
  sourceServerId: z.string().min(1),
  records: z.array(RecordSchema).max(10_000),
  cancellations: z.array(CancellationRecordSchema).max(10_000).optional(),
});

type SourceInput = z.infer<typeof SourceSchema>;
type SourceRecord = z.infer<typeof RecordSchema>;
type ReleaseBinding = z.infer<typeof BindingSchema>;
type CancellationRecord = z.infer<typeof CancellationRecordSchema>;
export type HandoffCancellationInput = Pick<
  CancellationRecord,
  "transferId" | "destinationServerId" | "reservationId"
>;
export type HandoffReleaseReceipt = z.infer<typeof ReceiptSchema>;
export type SourceHandoffStatus = Omit<SourceRecord, "privateKey">;

export interface HandoffMutationScope {
  cwd: string;
  workspaceId?: string;
  agentId?: string;
}
export interface HandoffMutationGuard {
  acquire(): () => void;
}
interface Mutation {
  scope: HandoffMutationScope;
  done: Promise<void>;
}

export class HandoffOwnershipError extends Error {
  constructor(
    readonly code:
      | "fenced"
      | "conflict"
      | "invalid_state"
      | "not_found"
      | "storage_uncertain"
      | "unsupported_host",
    message: string,
  ) {
    super(message);
    this.name = "HandoffOwnershipError";
  }
}

function reject(code: HandoffOwnershipError["code"], message: string): never {
  throw new HandoffOwnershipError(code, message);
}
export function handoffPathsOverlap(left: string, right: string): boolean {
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  return within(left, right) || within(right, left);
}
function protects(record: SourceRecord, scope: HandoffMutationScope): boolean {
  return (
    record.state !== "cancelled" &&
    (record.workspaceId === scope.workspaceId ||
      record.agentIds.includes(scope.agentId ?? "") ||
      handoffPathsOverlap(record.cwd, scope.cwd))
  );
}
function publicStatus(record: SourceRecord): SourceHandoffStatus {
  const { privateKey: _key, ...status } = record;
  return structuredClone(status);
}

async function mutationPath(cwd: string): Promise<string> {
  let existing = path.resolve(cwd);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...missing.toReversed());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const entry = await lstat(existing).catch((statError: unknown) => {
        if (statError instanceof Error && "code" in statError && statError.code === "ENOENT")
          return null;
        throw statError;
      });
      // A dangling symlink has an unknown destination; do not treat it as a missing directory.
      if (entry !== null || path.dirname(existing) === existing) throw error;
      missing.push(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

/** Load before any runtime, queue, or automation can resume. One instance owns all write leases. */
export class HandoffOwnership {
  private readonly records = new Map<string, SourceRecord>();
  private readonly cancellations = new Map<string, CancellationRecord>();
  private readonly mutations = new Set<Mutation>();
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private uncertain = false;
  private readonly journalPath: string;

  constructor(
    private readonly options: {
      directory: string;
      sourceServerId: string;
      write?: typeof writeJournal;
      assertAdditionalAdmission?: (scope: HandoffMutationScope) => void;
    },
  ) {
    this.journalPath = path.join(options.directory, "ownership.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    let created = false;
    try {
      await mkdir(this.options.directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    if (created) {
      await this.persist();
      await syncDirectory(path.dirname(this.options.directory));
    } else {
      const bytes = await readBoundedFile(this.journalPath, 20 * 1024 * 1024);
      const journal = JournalSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (journal.sourceServerId !== this.options.sourceServerId)
        reject("storage_uncertain", "Ownership journal belongs to another host");
      const loaded = new Map<string, SourceRecord>();
      for (const record of journal.records) {
        if (
          loaded.has(record.id) ||
          !path.isAbsolute(record.cwd) ||
          ((record.state === "released" || record.state === "ready") &&
            record.manifestDigest === null)
        )
          reject("storage_uncertain", "Invalid ownership journal");
        const publicKey = createPublicKey(
          createPrivateKey({
            key: Buffer.from(record.privateKey, "base64"),
            format: "der",
            type: "pkcs8",
          }),
        )
          .export({ type: "spki", format: "der" })
          .toString("base64");
        if (publicKey !== record.publicKey)
          reject("storage_uncertain", "Invalid handoff signing key");
        loaded.set(record.id, record);
      }
      for (const [id, record] of loaded) this.records.set(id, record);
      this.restoreCancellations(journal.cancellations ?? []);
    }
    this.initialized = true;
  }

  private restoreCancellations(cancellations: CancellationRecord[]): void {
    for (const cancellation of cancellations) {
      const source = this.records.get(cancellation.transferId);
      if (
        this.cancellations.has(cancellation.transferId) ||
        cancellation.sourceServerId !== this.options.sourceServerId ||
        (source &&
          (source.state !== "cancelled" ||
            source.destinationServerId !== cancellation.destinationServerId ||
            source.reservationId !== cancellation.reservationId ||
            source.publicKey !== cancellation.publicKey))
      )
        reject("storage_uncertain", "Invalid cancellation journal");
      const proof = cancellationProof(cancellation);
      if (!verifyHandoffCancellation(proof, HandoffCancellationBindingSchema.parse(cancellation)))
        reject("storage_uncertain", "Invalid cancellation signing key");
      this.cancellations.set(cancellation.transferId, cancellation);
    }
  }

  async prepare(input: SourceInput): Promise<SourceHandoffStatus> {
    const parsed = SourceSchema.parse(input);
    const source = {
      ...parsed,
      cwd: await realpath(parsed.cwd),
      agentIds: [...new Set(parsed.agentIds)].sort(),
    };
    return this.serialize(async () => {
      if (this.cancellations.has(source.id))
        reject("invalid_state", "This handoff was cancelled; use a new transfer ID");
      const existing = this.records.get(source.id);
      if (existing) {
        if (JSON.stringify(SourceSchema.parse(existing)) !== JSON.stringify(source))
          reject("conflict", "Transfer ID is already bound to another source or destination");
        return publicStatus(existing);
      }
      if (this.records.size >= 10_000)
        reject("invalid_state", "Ownership journal reached its transfer limit");
      this.assertAllowed({ cwd: source.cwd, workspaceId: source.workspaceId });
      for (const agentId of source.agentIds) this.assertAllowed({ cwd: source.cwd, agentId });
      const record: SourceRecord = {
        ...source,
        state: "preparing",
        manifestDigest: null,
        ...signingKeys(),
      };
      // Fence synchronously before awaiting durability; a failed write stays fenced in memory.
      this.records.set(record.id, record);
      await this.persist();
      return publicStatus(record);
    });
  }

  async withMutation<T>(scope: HandoffMutationScope, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireMutation(scope);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async acquireMutation(scope: HandoffMutationScope): Promise<() => void> {
    return (await this.bindMutation(scope)).acquire();
  }

  /** Bind a long-lived runtime once; input admission must not stat the filesystem per keystroke. */
  async bindMutation(scope: HandoffMutationScope): Promise<HandoffMutationGuard> {
    const canonical = { ...scope, cwd: await mutationPath(scope.cwd) };
    return { acquire: () => this.acquireCanonicalMutation(canonical) };
  }

  private acquireCanonicalMutation(scope: HandoffMutationScope): () => void {
    this.assertAllowed(scope);
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const mutation = { scope, done };
    this.mutations.add(mutation);
    return () => {
      this.mutations.delete(mutation);
      finish();
    };
  }

  async drain(id: string): Promise<void> {
    const record = this.requireRecord(id);
    if (record.state === "cancelled") reject("invalid_state", "Cancelled handoff is not fenced");
    await Promise.all(
      [...this.mutations]
        .filter((mutation) => protects(record, mutation.scope))
        .map((mutation) => mutation.done),
    );
  }

  markReady(id: string, manifestDigest: string): Promise<SourceHandoffStatus> {
    HandoffDigestSchema.parse(manifestDigest);
    return this.serialize(async () => {
      const record = this.requireRecord(id);
      if (record.state === "cancelled" || record.state === "released")
        reject("invalid_state", "Handoff cannot prepare in its current state");
      if (record.manifestDigest !== null && record.manifestDigest !== manifestDigest)
        reject("conflict", "Prepared handoff content cannot change");
      this.assertDrained(record);
      const ready: SourceRecord = { ...record, state: "ready", manifestDigest };
      this.records.set(id, ready);
      await this.persist();
      return publicStatus(ready);
    });
  }

  release(
    id: string,
    expected: ReleaseBinding,
    verifyStoppedSource: () => Promise<void>,
  ): Promise<HandoffReleaseReceipt> {
    const binding = BindingSchema.parse(expected);
    return this.serialize(async () => {
      const record = this.requireRecord(id);
      if (process.platform === "win32")
        reject("unsupported_host", "Durable handoff release is not supported on Windows yet");
      if (record.state !== "ready" && record.state !== "released")
        reject("invalid_state", "Handoff is not ready for release");
      const actual = BindingSchema.parse({
        version: 1,
        transferId: record.id,
        sourceServerId: this.options.sourceServerId,
        destinationServerId: record.destinationServerId,
        reservationId: record.reservationId,
        manifestDigest: record.manifestDigest,
      });
      if (JSON.stringify(actual) !== JSON.stringify(binding))
        reject("conflict", "Release does not match the prepared destination and content");
      this.assertDrained(record);
      if (record.state !== "released") {
        await verifyStoppedSource();
        this.records.set(id, { ...record, state: "released" });
        await this.persist();
      }
      const signature = sign(
        null,
        Buffer.from(JSON.stringify(actual)),
        createPrivateKey({
          key: Buffer.from(record.privateKey, "base64"),
          format: "der",
          type: "pkcs8",
        }),
      ).toString("base64");
      return { ...actual, signature };
    });
  }

  cancel(id: string): Promise<SourceHandoffStatus> {
    return this.serialize(async () => {
      const record = this.requireRecord(id);
      if (record.state === "released")
        reject(
          "invalid_state",
          "Released ownership cannot return through cancellation; start a new handoff",
        );
      const cancelled: SourceRecord = { ...record, state: "cancelled" };
      // Keep the live fence until cancellation is durable.
      await this.persistWith(cancelled);
      this.records.set(id, cancelled);
      return publicStatus(cancelled);
    });
  }

  /** A tombstone also prevents a delayed prepare when cancellation arrives first. */
  cancelReservation(input: HandoffCancellationInput): Promise<HandoffCancellationProof> {
    const binding = HandoffCancellationBindingSchema.parse({
      ...input,
      version: 1,
      outcome: "cancelled",
      sourceServerId: this.options.sourceServerId,
    });
    return this.serialize(async () => {
      if (process.platform === "win32")
        reject("unsupported_host", "Durable handoff cancellation is not supported on Windows yet");
      const source = this.records.get(binding.transferId);
      if (
        source &&
        (source.destinationServerId !== binding.destinationServerId ||
          source.reservationId !== binding.reservationId)
      )
        reject("conflict", "Cancellation belongs to another destination reservation");
      if (source?.state === "released")
        reject("invalid_state", "Source ownership was released; finish destination activation");
      const prior = this.cancellations.get(binding.transferId);
      if (prior) {
        if (
          JSON.stringify(HandoffCancellationBindingSchema.parse(prior)) !== JSON.stringify(binding)
        )
          reject("conflict", "Cancellation belongs to another destination reservation");
        return cancellationProof(prior);
      }
      if (this.cancellations.size >= 10_000)
        reject("invalid_state", "Ownership cancellation journal reached its transfer limit");
      const keys = source ?? signingKeys();
      const cancellation: CancellationRecord = {
        ...binding,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
      };
      const cancelled: SourceRecord | undefined = source
        ? { ...source, state: "cancelled" }
        : undefined;
      // Both the unfence and its proof become visible only after the same durable write.
      await this.persistWith(cancelled, cancellation);
      if (cancelled) this.records.set(cancelled.id, cancelled);
      this.cancellations.set(binding.transferId, cancellation);
      return cancellationProof(cancellation);
    });
  }

  cancellation(id: string): HandoffCancellationProof | null {
    this.assertHealthy();
    const record = this.cancellations.get(id);
    return record ? cancellationProof(record) : null;
  }

  status(id: string): SourceHandoffStatus {
    return publicStatus(this.requireRecord(id));
  }

  forWorkspace(workspaceId: string): SourceHandoffStatus | null {
    this.assertHealthy();
    const record = [...this.records.values()].find(
      (candidate) => candidate.state !== "cancelled" && candidate.workspaceId === workspaceId,
    );
    return record ? publicStatus(record) : null;
  }

  forAgent(agentId: string): SourceHandoffStatus | null {
    this.assertHealthy();
    const record = [...this.records.values()].find(
      (candidate) => candidate.state !== "cancelled" && candidate.agentIds.includes(agentId),
    );
    return record ? publicStatus(record) : null;
  }

  private assertHealthy(): void {
    if (!this.initialized || this.uncertain)
      reject(
        "storage_uncertain",
        "Handoff ownership is unavailable until its journal is recovered",
      );
  }
  private assertAllowed(scope: HandoffMutationScope): void {
    this.assertHealthy();
    this.options.assertAdditionalAdmission?.(scope);
    const fence = [...this.records.values()].find((record) => protects(record, scope));
    if (fence) reject("fenced", `Workspace is held by handoff ${fence.id} (${fence.state})`);
  }
  private requireRecord(id: string): SourceRecord {
    this.assertHealthy();
    const record = this.records.get(id);
    if (!record) reject("not_found", "Handoff ownership record not found");
    return record;
  }
  private assertDrained(record: SourceRecord): void {
    if ([...this.mutations].some((mutation) => protects(record, mutation.scope)))
      reject("invalid_state", "Workspace mutations are still running");
  }
  private async persistWith(
    replacement?: SourceRecord,
    cancellation?: CancellationRecord,
  ): Promise<void> {
    const records = [...this.records.values()].map((record) =>
      record.id === replacement?.id ? replacement : record,
    );
    try {
      const journal = JournalSchema.parse({
        version: 1,
        sourceServerId: this.options.sourceServerId,
        records,
        cancellations: [...this.cancellations.values(), ...(cancellation ? [cancellation] : [])],
      });
      if (Buffer.byteLength(JSON.stringify(journal)) > 20 * 1024 * 1024)
        reject("invalid_state", "Ownership journal exceeds its byte limit");
      await (this.options.write ?? writeJournal)(this.journalPath, journal);
    } catch (error) {
      this.uncertain = true;
      throw error;
    }
  }
  private persist(): Promise<void> {
    return this.persistWith();
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      this.assertHealthy();
      return operation();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

function signingKeys() {
  const keys = generateKeyPairSync("ed25519");
  return {
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}
function cancellationProof(record: CancellationRecord): HandoffCancellationProof {
  const binding = HandoffCancellationBindingSchema.parse(record);
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(binding)),
    createPrivateKey({
      key: Buffer.from(record.privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    }),
  ).toString("base64");
  return { publicKey: record.publicKey, receipt: { ...binding, signature } };
}

/** Before content binding, the key is obtained from the authenticated source cancellation reply. */
export function verifyHandoffCancellation(
  proof: unknown,
  expected: z.infer<typeof HandoffCancellationBindingSchema>,
  pinnedPublicKey?: string,
): boolean {
  const parsed = HandoffCancellationProofSchema.safeParse(proof);
  if (
    !parsed.success ||
    (pinnedPublicKey !== undefined && parsed.data.publicKey !== pinnedPublicKey)
  )
    return false;
  const binding = HandoffCancellationBindingSchema.parse(parsed.data.receipt);
  if (JSON.stringify(binding) !== JSON.stringify(HandoffCancellationBindingSchema.parse(expected)))
    return false;
  return verifySignature(binding, parsed.data.receipt.signature, parsed.data.publicKey);
}

function verifySignature(binding: unknown, encodedSignature: string, publicKey: string): boolean {
  const signature = Buffer.from(encodedSignature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== encodedSignature) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return (
      key.asymmetricKeyType === "ed25519" &&
      verify(null, Buffer.from(JSON.stringify(binding)), key, signature)
    );
  } catch {
    return false;
  }
}

/** The expected key and binding come from the authenticated source preflight, never the receipt. */
export function verifyHandoffRelease(
  receipt: unknown,
  expected: ReleaseBinding,
  publicKey: string,
): boolean {
  const parsed = ReceiptSchema.safeParse(receipt);
  if (!parsed.success) return false;
  const binding = BindingSchema.parse(parsed.data);
  if (JSON.stringify(binding) !== JSON.stringify(BindingSchema.parse(expected))) return false;
  return verifySignature(binding, parsed.data.signature, publicKey);
}
