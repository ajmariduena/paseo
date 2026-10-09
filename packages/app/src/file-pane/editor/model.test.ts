import { describe, expect, test } from "vitest";
import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";
import { createFileEditorRegistry } from "./registry";
import {
  FileEditorModel,
  getFileConflictCallout,
  type FileEditorClock,
  type FileEditorFile,
  type FileEditorObservation,
  type FileEditorSession,
  type FileObservationSource,
} from "./model";

class TestClock implements FileEditorClock {
  private callback: (() => void) | null = null;

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    this.callback = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(): void {
    this.callback = null;
  }

  fire(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

class FileSession implements FileEditorSession {
  file: FileEditorFile;
  writes: Array<{ content: string; expectedModifiedAt: string; expectedRevision?: string }> = [];
  nextWrite: FileWriteResult | Error | null = null;
  private pendingWrite: Promise<FileWriteResult> | null = null;
  private resolvePendingWrite: ((result: FileWriteResult) => void) | null = null;

  constructor(file: FileEditorFile) {
    this.file = file;
  }

  async write(input: {
    content: string;
    expectedModifiedAt: string;
    expectedRevision?: string;
  }): Promise<FileWriteResult> {
    this.writes.push(input);
    if (this.pendingWrite) return this.pendingWrite;
    if (this.nextWrite instanceof Error) throw this.nextWrite;
    if (this.nextWrite) return this.nextWrite;
    return {
      status: "written",
      modifiedAt: "2026-07-18T00:00:01.000Z",
      size: input.content.length,
    };
  }

  holdNextWrite(): void {
    this.pendingWrite = new Promise((resolve) => {
      this.resolvePendingWrite = resolve;
    });
  }

  finishHeldWrite(result: FileWriteResult): void {
    this.resolvePendingWrite?.(result);
    this.pendingWrite = null;
    this.resolvePendingWrite = null;
  }
}

class ObservationSource implements FileObservationSource {
  observation: FileEditorObservation | null;
  refreshes = 0;
  private readonly listeners = new Set<() => void>();

  constructor(observation: FileEditorObservation | null) {
    this.observation = observation;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getObservation(): FileEditorObservation | null {
    return this.observation;
  }

  refresh = (): void => {
    this.refreshes += 1;
  };

  emit(observation: FileEditorObservation): void {
    this.observation = observation;
    for (const listener of this.listeners) listener();
  }
}

function ready(
  modifiedAt = "2026-07-18T00:00:00.000Z",
  size = 3,
): Extract<FileVersion, { status: "ready" }> {
  return { status: "ready", cwd: "/workspace", path: "file.ts", size, modifiedAt };
}

interface MakeModelInput {
  content?: string;
  hasBom?: boolean;
}

function makeModel(input: MakeModelInput = {}) {
  const file = {
    content: input.content ?? "one",
    hasBom: input.hasBom ?? false,
    version: ready() as Extract<FileVersion, { status: "ready" }>,
  };
  const session = new FileSession(file);
  const clock = new TestClock();
  return { model: new FileEditorModel({ file, session, clock }), session, clock };
}

function observeFile(model: FileEditorModel, file: FileEditorFile): void {
  model.receiveFileObservation({ status: "ready", file });
}

function observeVersion(model: FileEditorModel, version: FileEditorObservation): void {
  model.receiveFileObservation(version);
}

describe("FileEditorModel", () => {
  test("leaves conflicting or failed saves recoverable and never prepares the workspace", async () => {
    const registry = createFileEditorRegistry();
    const workspace = { serverId: "source", workspaceId: "workspace" };
    const { model, session } = makeModel();
    const other = makeModel();
    const unregister = registry.register(workspace, model);
    const unregisterOther = registry.register({ ...workspace, serverId: "another" }, other.model);
    model.edit("local work");
    other.model.edit("another host");
    observeFile(model, { content: "external work", hasBom: false, version: ready("newer", 13) });
    expect(registry.unsavedPaths(workspace)).toEqual(["file.ts"]);
    let preparations = 0;
    const prepare = async () => ++preparations;
    await expect(
      registry.withSavedEditors(workspace, new AbortController().signal, prepare),
    ).rejects.toThrow("Unsaved changes in file.ts");
    expect(preparations).toBe(0);
    expect(session.writes).toEqual([]);
    expect(model.getSnapshot()).toMatchObject({
      readOnly: false,
      status: "conflict",
      content: "local work",
    });
    expect(other.model.getSnapshot()).toMatchObject({ readOnly: false, content: "another host" });
    await model.reload();
    model.edit("resolved work");
    session.nextWrite = new Error("disk full");
    await expect(
      registry.withSavedEditors(workspace, new AbortController().signal, prepare),
    ).rejects.toThrow("disk full");
    expect(preparations).toBe(0);
    expect(model.getSnapshot()).toMatchObject({
      readOnly: false,
      modified: true,
      content: "resolved work",
    });
    session.nextWrite = null;
    expect(await registry.withSavedEditors(workspace, new AbortController().signal, prepare)).toBe(
      1,
    );
    expect(registry.unsavedPaths(workspace)).toEqual([]);
    expect(other.session.writes).toEqual([]);
    unregister();
    unregisterOther();
  });

  test("includes a newly mounted editor while saving and restores controls when preparation fails", async () => {
    const registry = createFileEditorRegistry();
    const workspace = { serverId: "source", workspaceId: "workspace" };
    const first = makeModel();
    first.model.edit("first");
    first.session.holdNextWrite();
    const unregisterFirst = registry.register(workspace, first.model);
    const preparing = registry.withSavedEditors(
      workspace,
      new AbortController().signal,
      async () => {
        expect(first.model.getSnapshot().readOnly).toBe(true);
        expect(second.model.getSnapshot()).toMatchObject({
          readOnly: true,
          status: "clean",
          content: "second",
        });
        throw new Error("Destination disconnected");
      },
    );
    const failed = expect(preparing).rejects.toThrow("Destination disconnected");
    await Promise.resolve();
    const second = makeModel();
    second.model.edit("second");
    const unregisterSecond = registry.register(workspace, second.model);
    second.model.edit("too late");
    first.session.finishHeldWrite({ status: "written", modifiedAt: "newer", size: 5 });
    await failed;
    expect(second.session.writes.map((write) => write.content)).toEqual(["second"]);
    expect(first.model.getSnapshot().readOnly).toBe(false);
    expect(second.model.getSnapshot().readOnly).toBe(false);
    unregisterFirst();
    unregisterSecond();
  });

  test("does not prepare after closing the form during an in-flight save", async () => {
    const registry = createFileEditorRegistry();
    const workspace = { serverId: "source", workspaceId: "workspace" };
    const { model, session } = makeModel();
    const unregister = registry.register(workspace, model);
    session.holdNextWrite();
    model.edit("local work");
    const abort = new AbortController();
    let prepared = false;
    const preparing = registry.withSavedEditors(workspace, abort.signal, async () => {
      prepared = true;
    });
    const aborted = expect(preparing).rejects.toThrow("closed");
    await Promise.resolve();
    abort.abort(new Error("closed"));
    session.finishHeldWrite({ status: "written", modifiedAt: "newer", size: 10 });
    await aborted;
    expect(prepared).toBe(false);
    expect(model.getSnapshot()).toMatchObject({
      readOnly: false,
      modified: false,
      content: "local work",
    });
    unregister();
  });

  test("saves the latest buffer before handoff while blocking further edits", async () => {
    const { model, session } = makeModel();
    session.holdNextWrite();
    model.edit("first save");
    const saving = model.save();
    model.edit("latest local work");
    const barrier = model.acquireSaveBarrier();
    const flushed = barrier.flush();
    model.edit("too late");
    expect(model.getSnapshot()).toMatchObject({ readOnly: true, content: "latest local work" });
    expect(session.writes.map((write) => write.content)).toEqual(["first save"]);
    session.finishHeldWrite({ status: "written", modifiedAt: "newer", size: 10 });
    await saving;
    await flushed;
    expect(session.writes.map((write) => write.content)).toEqual([
      "first save",
      "latest local work",
    ]);
    expect(model.getSnapshot()).toMatchObject({ readOnly: true, status: "clean", modified: false });
    model.setReadOnly(true);
    barrier.release();
    expect(model.getSnapshot().readOnly).toBe(true);
    model.setReadOnly(false);
    expect(model.getSnapshot().readOnly).toBe(false);
  });

  test("holds a dirty buffer without writing until ownership is restored", async () => {
    const { model, session, clock } = makeModel();
    model.edit("unsaved before handoff");
    const resumeAutosave = model.suspendAutosave();
    model.setReadOnly(true);
    resumeAutosave();
    clock.fire();
    await model.save();
    observeFile(model, { content: "one", hasBom: false, version: ready() });
    clock.fire();
    model.edit("blocked edit");
    expect(session.writes).toEqual([]);
    expect(model.getSnapshot()).toMatchObject({
      readOnly: true,
      status: "dirty",
      modified: true,
      content: "unsaved before handoff",
    });
    model.setReadOnly(false);
    clock.fire();
    await Promise.resolve();
    expect(session.writes.map((write) => write.content)).toEqual(["unsaved before handoff"]);
    expect(model.getSnapshot()).toMatchObject({
      readOnly: false,
      status: "clean",
      modified: false,
    });
  });

  test("blocks conflict overwrite while held and keeps read-only after reloading disk content", async () => {
    const { model, session, clock } = makeModel();
    model.edit("local");
    observeFile(model, { content: "external", hasBom: false, version: ready("newer", 8) });
    model.setReadOnly(true);
    expect(getFileConflictCallout(model.getSnapshot())).toEqual({
      kind: "changed",
      canOverwrite: false,
    });
    await model.overwrite();
    expect(session.writes).toEqual([]);
    expect(model.getSnapshot()).toMatchObject({ status: "conflict", content: "local" });
    await model.reload();
    model.edit("blocked");
    clock.fire();
    expect(model.getSnapshot()).toMatchObject({
      readOnly: true,
      status: "clean",
      content: "external",
    });
    expect(session.writes).toEqual([]);
  });

  test("settles an admitted save without rescheduling a dirty buffer while held", async () => {
    const { model, session, clock } = makeModel();
    session.holdNextWrite();
    model.edit("admitted");
    const saving = model.save();
    model.edit("still local");
    model.setReadOnly(true);
    session.finishHeldWrite({ status: "written", modifiedAt: "newer", size: 8 });
    await saving;
    clock.fire();
    expect(session.writes.map((write) => write.content)).toEqual(["admitted"]);
    expect(model.getSnapshot()).toMatchObject({
      readOnly: true,
      status: "dirty",
      content: "still local",
    });
    model.setReadOnly(false);
    clock.fire();
    await Promise.resolve();
    expect(session.writes.map((write) => write.content)).toEqual(["admitted", "still local"]);
  });

  test("tracks whether the current buffer differs from persisted content", async () => {
    const { model } = makeModel();

    expect(model.getSnapshot().modified).toBe(false);
    model.edit("two");
    expect(model.getSnapshot().modified).toBe(true);
    model.edit("one");
    expect(model.getSnapshot()).toMatchObject({ status: "clean", modified: false });

    model.edit("saved");
    await model.save();
    expect(model.getSnapshot()).toMatchObject({ status: "clean", modified: false });
  });

  test("adopts a precise revision for otherwise unchanged initial metadata", () => {
    const { model } = makeModel();

    observeFile(model, {
      content: "one",
      hasBom: false,
      version: { ...ready(), revision: "precise-revision" },
    });

    expect(model.getSnapshot().observedVersion).toMatchObject({ revision: "precise-revision" });
  });

  test("adopts an unchanged disk revision without disturbing a dirty buffer", async () => {
    const { model, session } = makeModel();
    model.edit("local");
    observeFile(model, {
      content: "one",
      hasBom: false,
      version: { ...ready(), revision: "replacement-revision" },
    });

    expect(model.getSnapshot()).toMatchObject({ status: "dirty", content: "local" });
    await model.save();

    expect(session.writes).toEqual([
      {
        content: "local",
        expectedModifiedAt: "2026-07-18T00:00:00.000Z",
        expectedRevision: "replacement-revision",
      },
    ]);
  });

  test("adopts an external BOM change before saving a dirty buffer", async () => {
    const { model, session } = makeModel();
    model.edit("local");
    observeFile(model, {
      content: "one",
      hasBom: true,
      version: { ...ready(), revision: "replacement-revision" },
    });

    await model.save();

    expect(session.writes).toEqual([
      {
        content: "\uFEFFlocal",
        expectedModifiedAt: "2026-07-18T00:00:00.000Z",
        expectedRevision: "replacement-revision",
      },
    ]);
  });

  test("conflicts when a same-content observation changes the BOM during a save", async () => {
    const { model, session } = makeModel();
    session.holdNextWrite();
    model.edit("saved");
    const save = model.save();
    observeFile(model, {
      content: "saved",
      hasBom: true,
      version: ready("2026-07-18T00:00:02.000Z", 6),
    });
    session.finishHeldWrite({
      status: "written",
      modifiedAt: "2026-07-18T00:00:01.000Z",
      size: 5,
    });

    await save;

    expect(model.getSnapshot()).toMatchObject({
      status: "conflict",
      observedVersion: { modifiedAt: "2026-07-18T00:00:02.000Z" },
    });
  });

  test("ignores a settled observation that was already consumed", () => {
    const { model } = makeModel();
    const observation: FileEditorObservation = {
      status: "ready",
      file: { content: "one", hasBom: false, version: ready() },
    };
    let emissions = 0;
    model.subscribe(() => {
      emissions += 1;
    });
    model.receiveFileObservation(observation);
    const emissionsAfterFirstDelivery = emissions;

    model.receiveFileObservation(observation);

    expect(emissions).toBe(emissionsAfterFirstDelivery);
  });

  test("does not replay the pre-save observation while its refresh is pending", async () => {
    const { model } = makeModel();
    const observation: FileEditorObservation = {
      status: "ready",
      file: { content: "one", hasBom: false, version: ready() },
    };
    model.receiveFileObservation(observation);
    model.edit("saved");
    await model.save();

    model.receiveFileObservation(observation);

    expect(model.getSnapshot()).toMatchObject({ status: "clean", content: "saved" });
  });

  test("does not reload stale bytes after a write conflict", async () => {
    const { model, session } = makeModel();
    session.nextWrite = {
      status: "conflict",
      version: ready("2026-07-18T00:00:02.000Z", 8),
    };
    model.edit("important local work");
    await model.save();

    await model.reload();

    expect(model.getSnapshot()).toMatchObject({
      status: "conflict",
      content: "important local work",
      observedVersion: { modifiedAt: "2026-07-18T00:00:02.000Z" },
    });
  });

  test("reloads a write conflict only after refreshed bytes arrive", async () => {
    const { model, session } = makeModel();
    const source = new ObservationSource({
      status: "ready",
      file: { content: "one", hasBom: false, version: ready() },
    });
    model.connectFileObservations(source);
    session.nextWrite = {
      status: "conflict",
      version: ready("2026-07-18T00:00:02.000Z", 4),
    };
    model.edit("local");
    await model.save();

    await model.reload();
    expect(source.refreshes).toBe(1);
    expect(model.getSnapshot().content).toBe("local");
    source.emit({
      status: "ready",
      file: {
        content: "disk",
        hasBom: false,
        version: ready("2026-07-18T00:00:02.000Z", 4),
      },
    });

    expect(model.getSnapshot()).toMatchObject({ status: "clean", content: "disk" });
  });

  test("abandons a deferred reload when its refresh fails", async () => {
    const { model, session } = makeModel();
    const source = new ObservationSource({
      status: "ready",
      file: { content: "one", hasBom: false, version: ready() },
    });
    model.connectFileObservations(source);
    session.nextWrite = {
      status: "conflict",
      version: ready("2026-07-18T00:00:02.000Z", 4),
    };
    model.edit("local");
    await model.save();
    await model.reload();
    source.emit({
      status: "error",
      cwd: "/workspace",
      path: "file.ts",
      error: "File unavailable.",
    });
    model.edit("new local work");

    source.emit({
      status: "ready",
      file: {
        content: "disk",
        hasBom: false,
        version: ready("2026-07-18T00:00:03.000Z", 4),
      },
    });

    expect(model.getSnapshot()).toMatchObject({ status: "conflict", content: "new local work" });
  });

  test("keeps a newer edit modified when an older save finishes", async () => {
    const { model, session } = makeModel();
    session.holdNextWrite();
    model.edit("saving");

    const save = model.save();
    model.edit("newer edit");
    session.finishHeldWrite({
      status: "written",
      modifiedAt: "2026-07-18T00:00:01.000Z",
      size: 6,
    });
    await save;

    expect(model.getSnapshot()).toMatchObject({
      status: "dirty",
      content: "newer edit",
      modified: true,
    });
  });

  test("autosaves the latest edit after inactivity", async () => {
    const { model, session, clock } = makeModel();

    model.edit("two");
    model.edit("three");
    clock.fire();
    await Promise.resolve();

    expect(session.writes).toEqual([
      { content: "three", expectedModifiedAt: "2026-07-18T00:00:00.000Z" },
    ]);
    expect(model.getSnapshot().status).toBe("clean");
  });

  test("keeps CRLF content in file form", async () => {
    const { model, session } = makeModel({ content: "one\r\ntwo\r\n" });

    expect(model.getSnapshot()).toMatchObject({
      content: "one\r\ntwo\r\n",
      lineSeparator: "\r\n",
    });
    model.edit("one\r\ntwo\r\nthree\r\n");
    await model.save();

    expect(session.writes).toEqual([
      {
        content: "one\r\ntwo\r\nthree\r\n",
        expectedModifiedAt: "2026-07-18T00:00:00.000Z",
      },
    ]);
  });

  test("restores a UTF-8 BOM before writing a CRLF file", async () => {
    const { model, session } = makeModel({ content: "one\r\n", hasBom: true });

    model.edit("saved\r\n");
    await model.save();
    model.edit("saved again\r\n");
    await model.save();

    expect(session.writes).toEqual([
      {
        content: "\uFEFFsaved\r\n",
        expectedModifiedAt: "2026-07-18T00:00:00.000Z",
      },
      {
        content: "\uFEFFsaved again\r\n",
        expectedModifiedAt: "2026-07-18T00:00:01.000Z",
      },
    ]);
  });

  test("uses the first line separator when a file mixes styles", () => {
    const { model } = makeModel({ content: "one\r\ntwo\nthree\r" });

    expect(model.getSnapshot().lineSeparator).toBe("\r\n");
  });

  test("reloads a clean editor when the disk version changes", async () => {
    const { model, session } = makeModel();
    session.file = {
      content: "external",
      hasBom: false,
      version: ready("2026-07-18T00:00:02.000Z", 8) as Extract<FileVersion, { status: "ready" }>,
    };

    observeFile(model, session.file);

    expect(model.getSnapshot()).toMatchObject({ status: "clean", content: "external" });
  });

  test("adopts the format from a clean remote refresh", async () => {
    const { model, session } = makeModel({ content: "local\r\n", hasBom: true });
    session.file = {
      content: "remote\n",
      hasBom: false,
      version: ready("2026-07-18T00:00:02.000Z", 7) as Extract<FileVersion, { status: "ready" }>,
    };

    observeFile(model, session.file);
    expect(model.getSnapshot().lineSeparator).toBe("\n");
    model.edit("saved\n");
    await model.save();

    expect(session.writes.at(-1)).toEqual({
      content: "saved\n",
      expectedModifiedAt: "2026-07-18T00:00:02.000Z",
    });
  });

  test("applies consecutive clean disk observations", () => {
    const { model } = makeModel();
    const firstVersion = ready("2026-07-18T00:00:02.000Z", 5);
    const latestVersion = ready("2026-07-18T00:00:03.000Z", 6);

    observeFile(model, { content: "first", hasBom: false, version: firstVersion });
    observeFile(model, { content: "latest", hasBom: false, version: latestVersion });

    expect(model.getSnapshot()).toMatchObject({ status: "clean", content: "latest" });
  });

  test("preserves a dirty buffer and overwrites against the newest disk revision", async () => {
    const { model, session } = makeModel();
    model.edit("local");
    observeFile(model, {
      content: "disk",
      hasBom: false,
      version: ready("2026-07-18T00:00:02.000Z", 4),
    });

    expect(model.getSnapshot()).toMatchObject({ status: "conflict", content: "local" });
    await model.overwrite();

    expect(session.writes).toEqual([
      { content: "local", expectedModifiedAt: "2026-07-18T00:00:02.000Z" },
    ]);
    expect(model.getSnapshot().status).toBe("clean");
  });

  test("keeps the local CRLF and BOM when overwriting a conflict", async () => {
    const { model, session } = makeModel({ content: "one\r\n", hasBom: true });
    model.edit("local\r\n");
    observeFile(model, {
      content: "disk",
      hasBom: false,
      version: ready("2026-07-18T00:00:02.000Z", 4),
    });

    await model.overwrite();

    expect(session.writes).toEqual([
      {
        content: "\uFEFFlocal\r\n",
        expectedModifiedAt: "2026-07-18T00:00:02.000Z",
      },
    ]);
  });

  test("reload discards a conflicted local buffer for the disk contents", async () => {
    const { model, session } = makeModel();
    model.edit("local");
    const diskVersion = ready("2026-07-18T00:00:02.000Z", 4) as Extract<
      FileVersion,
      { status: "ready" }
    >;
    session.file = { content: "disk", hasBom: false, version: diskVersion };
    observeFile(model, session.file);

    await model.reload();

    expect(model.getSnapshot()).toMatchObject({ status: "clean", content: "disk" });
  });

  test("adopts the remote format when reloading a conflict", async () => {
    const { model, session } = makeModel({ content: "one\r\n", hasBom: true });
    model.edit("local\r\n");
    const diskVersion = ready("2026-07-18T00:00:02.000Z", 5) as Extract<
      FileVersion,
      { status: "ready" }
    >;
    session.file = { content: "disk\n", hasBom: false, version: diskVersion };
    observeFile(model, session.file);

    await model.reload();
    model.edit("saved\n");
    await model.save();

    expect(session.writes.at(-1)).toEqual({
      content: "saved\n",
      expectedModifiedAt: "2026-07-18T00:00:02.000Z",
    });
  });

  test("reports failed saves without losing the local buffer", async () => {
    const { model, session } = makeModel();
    session.nextWrite = new Error("disk full");
    model.edit("important local work");

    await model.save();

    expect(model.getSnapshot()).toMatchObject({
      status: "error",
      content: "important local work",
      error: "disk full",
    });
  });

  test("a deletion conflicts with local changes and stops autosave", () => {
    const { model, session, clock } = makeModel();
    model.edit("local");
    observeVersion(model, { status: "missing", cwd: "/workspace", path: "file.ts" });

    clock.fire();

    expect(model.getSnapshot().status).toBe("conflict");
    expect(session.writes).toEqual([]);
  });

  test("clears a transient check error when the recovered file is unchanged", () => {
    const { model } = makeModel();
    observeVersion(model, {
      status: "error",
      cwd: "/workspace",
      path: "file.ts",
      error: "Requested path is not a file",
    });

    observeFile(model, { content: "one", hasBom: false, version: ready() });

    expect(model.getSnapshot()).toMatchObject({
      status: "clean",
      modified: false,
      observedVersion: { status: "ready" },
      error: null,
    });
  });

  test("resumes autosave when a dirty file recovers unchanged from a check error", async () => {
    const { model, session, clock } = makeModel();
    model.edit("local");
    observeVersion(model, {
      status: "error",
      cwd: "/workspace",
      path: "file.ts",
      error: "Requested path is not a file",
    });

    observeFile(model, { content: "one", hasBom: false, version: ready() });
    clock.fire();
    await Promise.resolve();

    expect(model.getSnapshot()).toMatchObject({ status: "clean", modified: false });
    expect(session.writes).toEqual([
      { content: "local", expectedModifiedAt: "2026-07-18T00:00:00.000Z" },
    ]);
  });

  test("dispose cancels pending autosave", () => {
    const { model, session, clock } = makeModel();
    model.edit("local");

    model.dispose();
    clock.fire();

    expect(session.writes).toEqual([]);
  });

  test("suspends a pending autosave while close confirmation is active", async () => {
    const { model, session, clock } = makeModel();
    model.edit("local");

    const resume = model.suspendAutosave();
    clock.fire();
    expect(session.writes).toEqual([]);

    resume();
    clock.fire();
    await Promise.resolve();
    expect(session.writes).toHaveLength(1);
  });

  test("maps conflict versions to one exhaustive callout state", () => {
    const { model } = makeModel();
    const snapshot = model.getSnapshot();

    expect(getFileConflictCallout(snapshot)).toBeNull();
    expect(
      getFileConflictCallout({
        ...snapshot,
        status: "conflict",
        modified: true,
        observedVersion: ready("2026-07-18T00:00:01.000Z"),
      }),
    ).toEqual({ kind: "changed", canOverwrite: true });
    expect(
      getFileConflictCallout({
        ...snapshot,
        status: "conflict",
        observedVersion: { status: "missing", cwd: "/workspace", path: "file.ts" },
      }),
    ).toEqual({ kind: "deleted" });
    expect(
      getFileConflictCallout({
        ...snapshot,
        status: "conflict",
        observedVersion: {
          status: "error",
          cwd: "/workspace",
          path: "file.ts",
          error: "unreadable",
        },
      }),
    ).toEqual({ kind: "checkFailed" });
  });
});
