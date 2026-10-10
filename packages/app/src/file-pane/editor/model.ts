import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";
import type { FileEditorDraft } from "./drafts";

export type FileEditorStatus = "clean" | "dirty" | "saving" | "conflict" | "error";
export type FileLineSeparator = "\n" | "\r\n" | "\r";

export interface FileEditorSnapshot {
  readOnly: boolean;
  status: FileEditorStatus;
  content: string;
  lineSeparator: FileLineSeparator;
  modified: boolean;
  version: FileEditorFile["version"];
  observedVersion: FileVersion;
  error: string | null;
  checkpointError: string | null;
}

export type FileConflictCallout =
  | { kind: "changed"; canOverwrite: boolean }
  | { kind: "deleted" }
  | { kind: "checkFailed" };

export interface FileEditorFile {
  content: string;
  hasBom: boolean;
  version: Extract<FileVersion, { status: "ready" }>;
}

export interface FileEditorSession {
  write(input: {
    content: string;
    expectedModifiedAt: string;
    expectedRevision?: string;
  }): Promise<FileWriteResult>;
}

export type FileEditorObservation =
  | { status: "ready"; file: FileEditorFile }
  | Extract<FileVersion, { status: "missing" | "error" }>;

export interface FileObservationSource {
  subscribe(listener: () => void): () => void;
  getObservation(): FileEditorObservation | null;
  refresh(): void;
}

type ObservedDiskState = FileEditorObservation | { status: "unsettled"; version: FileVersion };

export interface FileEditorClock {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemClock: FileEditorClock = {
  setTimeout(callback, delay) {
    return globalThis.setTimeout(callback, delay);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle);
  },
};

export class FileEditorSaveError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string | null,
  ) {
    super(`Unsaved changes in ${path}${detail ? `: ${detail}` : ""}`);
  }
}

export class FileEditorModel {
  private readonly session: FileEditorSession;
  private readonly clock: FileEditorClock;
  private readonly listeners = new Set<() => void>();
  private snapshot: FileEditorSnapshot;
  private autosave: ReturnType<typeof setTimeout> | null = null;
  private saveSequence = 0;
  private disposed = false;
  private observedWhileSaving: FileEditorObservation | null = null;
  private observed: ObservedDiskState;
  private lastReceivedObservation: FileEditorObservation | null = null;
  private refreshObservation: (() => void) | null = null;
  private reloadRequested = false;
  private persistedContent: string;
  private hasBom: boolean;
  private unsubscribeObservationSource: (() => void) | null = null;
  private ownerReadOnly: boolean;
  private readonly saveBarriers = new Set<object>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly persistDraft: ((draft: FileEditorDraft | null) => Promise<void>) | null;
  private lastDraft: FileEditorDraft | null = null;
  private pendingCheckpoint: { draft: FileEditorDraft | null } | null = null;
  private checkpoint: Promise<void> | null = null;
  private draftDiscarded = false;
  private recoveryUnverified: boolean;
  private recoveredConflict = false;

  constructor(input: {
    file: FileEditorFile;
    session: FileEditorSession;
    clock?: FileEditorClock;
    readOnly?: boolean;
    draft?: FileEditorDraft | null;
    persistDraft?: (draft: FileEditorDraft | null) => Promise<void>;
  }) {
    this.session = input.session;
    this.clock = input.clock ?? systemClock;
    this.ownerReadOnly = input.readOnly ?? false;
    this.persistDraft = input.persistDraft ?? null;
    this.lastDraft = input.draft ?? null;
    this.recoveryUnverified = input.draft != null;
    this.persistedContent = input.file.content;
    this.hasBom = input.file.hasBom;
    this.observed = { status: "ready", file: input.file };
    this.snapshot = {
      readOnly: input.readOnly ?? false,
      status: "clean",
      content: input.file.content,
      lineSeparator: detectLineSeparator(input.file.content),
      modified: false,
      version: input.file.version,
      observedVersion: input.file.version,
      error: null,
      checkpointError: null,
    };
    const draft = input.draft;
    if (draft && draft.content !== input.file.content) {
      const changed =
        draft.base.content !== input.file.content || draft.base.hasBom !== input.file.hasBom;
      this.recoveredConflict = draft.conflict || changed;
      this.snapshot = {
        ...this.snapshot,
        content: draft.content,
        lineSeparator: detectLineSeparator(draft.content),
        modified: true,
        status: this.recoveredConflict ? "conflict" : "dirty",
      };
    }
  }

  getRecoveryDraft(): FileEditorDraft | null {
    const needsRecovery =
      this.recoveryUnverified ||
      this.snapshot.modified ||
      this.snapshot.status === "saving" ||
      this.pendingWrites.size > 0;
    if (!needsRecovery || this.draftDiscarded) return null;
    return {
      content: this.snapshot.content,
      conflict: this.snapshot.status === "conflict",
      base: { content: this.persistedContent, hasBom: this.hasBom, version: this.snapshot.version },
    };
  }

  async flushRecoveryDraft(): Promise<void> {
    this.queueRecoveryDraft();
    while (this.checkpoint) await this.checkpoint;
    if (this.snapshot.checkpointError)
      throw new FileEditorSaveError(this.snapshot.version.path, this.snapshot.checkpointError);
  }

  async retryRecoveryDraft(): Promise<void> {
    this.lastDraft = null;
    this.pendingCheckpoint = { draft: this.getRecoveryDraft() };
    this.startCheckpoint();
    await this.flushRecoveryDraft();
  }

  async discardRecoveryDraft(): Promise<() => void> {
    this.draftDiscarded = true;
    this.pendingCheckpoint = { draft: null };
    this.startCheckpoint();
    try {
      await this.flushRecoveryDraft();
    } catch (error) {
      this.draftDiscarded = false;
      this.queueRecoveryDraft();
      throw error;
    }
    return () => {
      this.draftDiscarded = false;
      this.queueRecoveryDraft();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FileEditorSnapshot => this.snapshot;

  connectFileObservations(source: FileObservationSource): void {
    this.disconnectFileObservations();
    this.refreshObservation = source.refresh;
    const receiveObservation = () => {
      const observation = source.getObservation();
      if (observation) this.receiveFileObservation(observation);
    };
    this.unsubscribeObservationSource = source.subscribe(receiveObservation);
    receiveObservation();
    this.queueRecoveryDraft();
  }

  disconnectFileObservations(): void {
    this.unsubscribeObservationSource?.();
    this.unsubscribeObservationSource = null;
    this.refreshObservation = null;
  }

  setReadOnly(readOnly: boolean): void {
    this.ownerReadOnly = readOnly;
    this.updateReadOnly();
  }

  private updateReadOnly(): void {
    const readOnly = this.ownerReadOnly || this.saveBarriers.size > 0;
    if (this.disposed || this.snapshot.readOnly === readOnly) return;
    this.clearAutosave();
    this.setSnapshot({ ...this.snapshot, readOnly });
    if (!readOnly && this.snapshot.status === "dirty") this.scheduleAutosave();
  }

  /** Hold edits until the caller has captured the saved files or abandoned preparation. */
  acquireSaveBarrier() {
    const token = {};
    this.saveBarriers.add(token);
    this.updateReadOnly();
    return {
      flush: async (signal?: AbortSignal): Promise<void> => {
        signal?.throwIfAborted();
        await Promise.all(this.pendingWrites);
        signal?.throwIfAborted();
        if (!this.saveBarriers.has(token) || this.disposed) {
          throw new FileEditorSaveError(this.snapshot.version.path, null);
        }
        if (!this.snapshot.modified) {
          await this.flushRecoveryDraft();
          return;
        }
        if (
          this.ownerReadOnly ||
          this.snapshot.status === "conflict" ||
          this.snapshot.observedVersion.status !== "ready"
        ) {
          throw new FileEditorSaveError(this.snapshot.version.path, this.snapshot.error);
        }
        await this.performWrite(this.snapshot.observedVersion);
        signal?.throwIfAborted();
        if (this.disposed || this.snapshot.modified || this.snapshot.status === "error") {
          throw new FileEditorSaveError(this.snapshot.version.path, this.snapshot.error);
        }
        await this.flushRecoveryDraft();
      },
      release: () => {
        if (!this.saveBarriers.delete(token)) return;
        this.updateReadOnly();
      },
    };
  }

  edit(content: string): void {
    if (this.disposed || this.snapshot.readOnly || content === this.snapshot.content) return;
    this.reloadRequested = false;
    this.draftDiscarded = false;
    const modified = this.isModified(content, this.snapshot.status === "conflict");
    let status: FileEditorStatus = modified ? "dirty" : "clean";
    if (this.snapshot.status === "conflict") {
      status = "conflict";
    }
    this.setSnapshot({ ...this.snapshot, status, content, modified, error: null });
    if (status === "dirty") this.scheduleAutosave();
    else this.clearAutosave();
  }

  async save(): Promise<void> {
    if (
      this.disposed ||
      this.snapshot.readOnly ||
      (this.snapshot.status !== "dirty" && this.snapshot.status !== "error")
    ) {
      return;
    }
    if (this.snapshot.observedVersion.status !== "ready") {
      this.enterConflict(this.snapshot.observedVersion);
      return;
    }
    await this.performWrite(this.snapshot.observedVersion);
  }

  receiveFileObservation(observation: FileEditorObservation): void {
    if (this.disposed || observation === this.lastReceivedObservation) return;
    this.lastReceivedObservation = observation;
    if (observation.status === "ready") this.recoveryUnverified = false;
    const version = observationVersion(observation);
    this.observed = observation;
    this.setSnapshot({ ...this.snapshot, observedVersion: version });
    if (this.snapshot.status === "saving") {
      this.observedWhileSaving = observation;
      return;
    }
    if (observation.status !== "ready") {
      this.reloadRequested = false;
      this.enterConflict(version);
      return;
    }
    if (this.reloadRequested) {
      this.reloadRequested = false;
      this.applyFile(observation.file);
      return;
    }
    if (observation.file.content === this.persistedContent) {
      this.adoptUnchangedFile(observation.file);
      return;
    }
    if (this.snapshot.status === "clean") {
      this.applyFile(observation.file);
      return;
    }
    this.enterConflict(version);
  }

  async overwrite(): Promise<void> {
    if (this.disposed || this.snapshot.readOnly || this.snapshot.status !== "conflict") return;
    if (this.snapshot.observedVersion.status !== "ready") return;
    await this.performWrite(this.snapshot.observedVersion);
  }

  async reload(): Promise<void> {
    if (this.disposed) return;
    if (this.observed.status !== "ready") {
      this.reloadRequested = true;
      this.refreshObservation?.();
      return;
    }
    this.applyFile(this.observed.file);
  }

  dispose(): void {
    this.disposed = true;
    this.reloadRequested = false;
    this.saveSequence += 1;
    this.clearAutosave();
    this.disconnectFileObservations();
    this.listeners.clear();
  }

  suspendAutosave(): () => void {
    const wasScheduled = this.autosave !== null;
    this.clearAutosave();
    let resumed = false;
    return () => {
      if (resumed || this.disposed) return;
      resumed = true;
      if (wasScheduled && this.snapshot.status === "dirty") this.scheduleAutosave();
    };
  }

  private performWrite(expectedVersion: Extract<FileVersion, { status: "ready" }>): Promise<void> {
    const pending = this.writeFile(expectedVersion);
    this.pendingWrites.add(pending);
    return pending.finally(() => {
      this.pendingWrites.delete(pending);
      this.queueRecoveryDraft();
    });
  }

  private async writeFile(
    expectedVersion: Extract<FileVersion, { status: "ready" }>,
  ): Promise<void> {
    this.clearAutosave();
    const sequence = ++this.saveSequence;
    const content = this.snapshot.content;
    const hasBom = this.hasBom;
    this.observedWhileSaving = null;
    this.setSnapshot({ ...this.snapshot, status: "saving", error: null });
    const serializedContent = hasBom ? `\uFEFF${content}` : content;
    let result: FileWriteResult;
    try {
      result = await this.session.write({
        content: serializedContent,
        expectedModifiedAt: expectedVersion.modifiedAt,
        expectedRevision: expectedVersion.revision,
      });
    } catch (error) {
      if (this.disposed || sequence !== this.saveSequence) return;
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.disposed || sequence !== this.saveSequence) return;
    if (result.status === "error") {
      this.setSnapshot({ ...this.snapshot, status: "error", error: result.error });
      return;
    }
    if (result.status === "conflict") {
      this.observed = { status: "unsettled", version: result.version };
      this.enterConflict(result.version);
      return;
    }

    const writtenVersion: Extract<FileVersion, { status: "ready" }> = {
      status: "ready",
      cwd: this.snapshot.version.cwd,
      path: this.snapshot.version.path,
      size: result.size,
      modifiedAt: result.modifiedAt,
      revision: result.revision,
    };
    this.recoveredConflict = false;
    const pending = this.takeObservedWhileSaving();
    this.persistedContent = content;
    if (pending && !observationMatchesWrite(pending, content, hasBom)) {
      const pendingVersion = observationVersion(pending);
      this.observed = pending;
      this.setSnapshot({
        ...this.snapshot,
        status: "conflict",
        modified: this.isModified(this.snapshot.content, true),
        version: writtenVersion,
        observedVersion: pendingVersion,
        error: null,
      });
      return;
    }
    const settledVersion = pending?.status === "ready" ? pending.file.version : writtenVersion;
    this.observed = pending ?? { status: "unsettled", version: writtenVersion };
    const modified = this.snapshot.content !== this.persistedContent;
    this.setSnapshot({
      ...this.snapshot,
      status: modified ? "dirty" : "clean",
      modified,
      version: settledVersion,
      observedVersion: settledVersion,
      error: null,
    });
    if (modified) this.scheduleAutosave();
  }

  private applyFile(file: FileEditorFile): void {
    this.recoveredConflict = false;
    this.clearAutosave();
    this.saveSequence += 1;
    this.persistedContent = file.content;
    this.hasBom = file.hasBom;
    this.observed = { status: "ready", file };
    this.setSnapshot({
      readOnly: this.snapshot.readOnly,
      status: "clean",
      content: file.content,
      lineSeparator: detectLineSeparator(file.content),
      modified: false,
      version: file.version,
      observedVersion: file.version,
      error: null,
      checkpointError: this.snapshot.checkpointError,
    });
  }

  private takeObservedWhileSaving(): FileEditorObservation | null {
    const observation = this.observedWhileSaving;
    this.observedWhileSaving = null;
    return observation;
  }

  private isModified(content: string, conflicting: boolean): boolean {
    if (content !== this.persistedContent) return true;
    if (!conflicting) return false;
    // Reverting to the original bytes does not resolve a newer disk version.
    if (this.observed.status === "ready") return content !== this.observed.file.content;
    return this.observed.status === "unsettled" || this.snapshot.modified;
  }

  private enterConflict(version: FileVersion): void {
    this.clearAutosave();
    this.setSnapshot({
      ...this.snapshot,
      status: "conflict",
      observedVersion: version,
      error: version.status === "error" ? version.error : null,
    });
  }

  private adoptUnchangedFile(file: FileEditorFile): void {
    if (this.recoveredConflict) {
      this.enterConflict(file.version);
      return;
    }
    this.hasBom = file.hasBom;
    this.observed = { status: "ready", file };
    const modified = this.snapshot.content !== this.persistedContent;
    const recovering = this.snapshot.status === "conflict";
    let status = this.snapshot.status;
    if (recovering) status = modified ? "dirty" : "clean";
    this.setSnapshot({
      ...this.snapshot,
      status,
      modified,
      version: file.version,
      observedVersion: file.version,
      error: recovering ? null : this.snapshot.error,
    });
    if (status === "dirty") this.scheduleAutosave();
    else this.clearAutosave();
  }

  private scheduleAutosave(): void {
    this.clearAutosave();
    if (this.snapshot.readOnly) return;
    this.autosave = this.clock.setTimeout(() => {
      this.autosave = null;
      void this.save();
    }, 800);
  }

  private clearAutosave(): void {
    if (!this.autosave) return;
    this.clock.clearTimeout(this.autosave);
    this.autosave = null;
  }

  private setSnapshot(snapshot: FileEditorSnapshot): void {
    this.snapshot = snapshot;
    this.queueRecoveryDraft();
    for (const listener of this.listeners) listener();
  }

  private queueRecoveryDraft(): void {
    if (!this.persistDraft || this.disposed) return;
    const draft = this.getRecoveryDraft();
    if (sameDraft(this.lastDraft, draft)) return;
    this.lastDraft = draft;
    this.pendingCheckpoint = { draft };
    this.startCheckpoint();
  }

  private startCheckpoint(): void {
    if (!this.persistDraft || this.checkpoint || !this.pendingCheckpoint) return;
    const persist = this.persistDraft;
    this.checkpoint = Promise.resolve()
      .then(async () => {
        while (this.pendingCheckpoint) {
          const { draft } = this.pendingCheckpoint;
          this.pendingCheckpoint = null;
          try {
            await persist(draft);
            this.setSnapshot({ ...this.snapshot, checkpointError: null });
          } catch (error) {
            this.setSnapshot({
              ...this.snapshot,
              checkpointError: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return;
      })
      .finally(() => {
        this.checkpoint = null;
        this.startCheckpoint();
      });
  }
}

function sameDraft(previous: FileEditorDraft | null, next: FileEditorDraft | null): boolean {
  if (!previous || !next) return previous === next;
  return (
    previous.content === next.content &&
    previous.conflict === next.conflict &&
    previous.base.content === next.base.content &&
    previous.base.hasBom === next.base.hasBom &&
    previous.base.version.modifiedAt === next.base.version.modifiedAt &&
    previous.base.version.revision === next.base.version.revision &&
    previous.base.version.size === next.base.version.size
  );
}

export function getFileConflictCallout(snapshot: FileEditorSnapshot): FileConflictCallout | null {
  if (snapshot.status !== "conflict") return null;
  switch (snapshot.observedVersion.status) {
    case "ready":
      return { kind: "changed", canOverwrite: snapshot.modified && !snapshot.readOnly };
    case "missing":
      return { kind: "deleted" };
    case "error":
      return { kind: "checkFailed" };
    default:
      return assertNever(snapshot.observedVersion);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected file version: ${JSON.stringify(value)}`);
}

function detectLineSeparator(content: string): FileLineSeparator {
  for (let index = 0; index < content.length; index += 1) {
    const character = content.charCodeAt(index);
    if (character === 10) return "\n";
    if (character === 13) return content.charCodeAt(index + 1) === 10 ? "\r\n" : "\r";
  }
  return "\n";
}

function observationVersion(observation: FileEditorObservation): FileVersion {
  return observation.status === "ready" ? observation.file.version : observation;
}

function observationMatchesWrite(
  observation: FileEditorObservation,
  content: string,
  hasBom: boolean,
): boolean {
  return (
    observation.status === "ready" &&
    observation.file.content === content &&
    observation.file.hasBom === hasBom
  );
}
