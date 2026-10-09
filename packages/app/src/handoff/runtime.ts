import { fileEditorDraftStorage } from "@/file-pane/editor/drafts";
import { FileEditorSaveError } from "@/file-pane/editor/model";
import { workspaceFileEditors } from "@/file-pane/editor/registry";
import { i18n } from "@/i18n/i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import {
  activateWorkspaceHandoff,
  cancelWorkspaceHandoff,
  prepareWorkspaceHandoff,
} from "@getpaseo/client/internal/workspace-handoff";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { HandoffFilesNotSavedError, type HandoffFormPorts } from "./form-model";
import {
  createHandoffPersistence,
  restoreHandoffRecord,
  restoreReservedHandoffRecord,
  restoreCancelledHandoffRecord,
  type HandoffRecord,
  type HandoffOrigin,
} from "./persistence";

function connectedClient(serverId: string) {
  const runtime = getHostRuntimeStore();
  const host = runtime.getSnapshot(serverId);
  const client = runtime.getClient(serverId);
  if (!isHostRuntimeConnected(host) || !client) throw new Error(i18n.t("handoff.connectHosts"));
  // The complete feature stays unadvertised until its delivery gates have passed.
  if (client.getLastServerInfoMessage()?.features?.workspaceHandoff !== true) {
    throw new Error(i18n.t("handoff.updateHosts"));
  }
  return client;
}

function connections(record: HandoffRecord) {
  return {
    source: connectedClient(record.sourceServerId),
    destination: connectedClient(record.destinationServerId),
    transferId: record.transferId,
  };
}

/** Resolve both hosts afresh before a source banner links to the destination. */
export async function readSourceHandoffRecord(
  origin: HandoffOrigin,
): Promise<HandoffRecord | null> {
  const found = await connectedClient(origin.sourceServerId).handoffFindSource({
    workspaceId: origin.workspaceId,
  });
  if (found.error) throw new Error(found.error.message);
  if (!found.result) return null;
  const source = found.result;
  const host = getHostRuntimeStore()
    .getHosts()
    .find((candidate) => candidate.serverId === source.destinationServerId);
  if (!host) throw new Error("Reconnect the destination host to recover this handoff");
  const response = await connectedClient(host.serverId).handoffGetDestinationStatus({
    transferId: source.id,
  });
  if (response.error) throw new Error(response.error.message);
  if (!response.result) throw new Error("Destination handoff record is missing");
  const record = restoreHandoffRecord({
    origin,
    source,
    destination: host,
    snapshot: response.result,
  });
  return record;
}

const persistence = createHandoffPersistence(AsyncStorage);
export const loadSavedHandoff = persistence.load;
export const handoffFormPorts: HandoffFormPorts = {
  ...persistence,
  async listDestination(origin, host, cursor) {
    const response = await connectedClient(host.serverId).handoffListDestination({
      sourceServerId: origin.sourceServerId,
      sourceWorkspaceId: origin.workspaceId,
      ...(cursor ? { cursor } : {}),
    });
    if (response.error) throw new Error(response.error.message);
    if (!response.result) throw new Error("Destination transfer list is missing");
    return response.result;
  },
  async recoverDestination(origin, destination, transferId) {
    const response = await connectedClient(destination.serverId).handoffGetDestinationStatus({
      transferId,
    });
    if (response.error) throw new Error(response.error.message);
    if (!response.result) throw new Error("Destination handoff record is missing");
    const snapshot = response.result;
    if (snapshot.state === "cancelled")
      return restoreCancelledHandoffRecord({ origin, destination, snapshot });
    const previous = await connectedClient(origin.sourceServerId).handoffGetSourceStatus({
      transferId,
    });
    if (previous.error && previous.error.code !== "not_found")
      throw new Error(previous.error.message);
    if (previous.cancellation)
      return restoreCancelledHandoffRecord({
        origin,
        destination,
        snapshot,
        proof: previous.cancellation,
      });
    if (previous.result)
      return restoreHandoffRecord({
        origin,
        destination,
        snapshot,
        source: previous.result.source,
      });
    return restoreReservedHandoffRecord({ origin, destination, snapshot });
  },
  async load(origin) {
    const saved = await persistence.load(origin);
    if (saved) return saved;
    const record = await readSourceHandoffRecord(origin);
    if (!record) return null;
    await persistence.save(record);
    return record;
  },
  newTransferId: randomUUID,
  async validate(record) {
    const { source, destination } = connections(record);
    const inspection = await source.handoffPreviewSource({ workspaceId: record.workspaceId });
    if (inspection.error) throw new Error(inspection.error.message);
    if (!inspection.result) throw new Error("Source preview is missing");
    const { workspace, stoppedWork, conversations } = inspection.result;
    if (!workspace || !stoppedWork) throw new Error(i18n.t("handoff.updateHosts"));
    let conversationBytes = 0;
    for (const conversation of conversations) {
      if (conversation.state !== "available") continue;
      if (conversation.artifactBytes === undefined) throw new Error(i18n.t("handoff.updateHosts"));
      conversationBytes += conversation.artifactBytes;
    }
    await destination.listDirectory(record.destinationParent, ".");
    const preview = await destination.handoffPreviewDestination({
      conversations: inspection.result.conversations,
    });
    if (preview.error) throw new Error(preview.error.message);
    if (!preview.result) throw new Error("Destination preview is missing");
    return {
      ...preview.result,
      workspace,
      stoppedWork,
      conversationBytes,
      unsavedFiles: [
        ...new Set([
          ...workspaceFileEditors.unsavedPaths({
            serverId: record.sourceServerId,
            workspaceId: record.workspaceId,
          }),
          ...(
            await fileEditorDraftStorage.listWorkspace({
              serverId: record.sourceServerId,
              workspaceId: record.workspaceId,
            })
          ).map(({ identity }) => identity.path),
        ]),
      ].sort(),
    };
  },
  async prepare(record, options) {
    let handoffStarted = false;
    try {
      return await workspaceFileEditors.withSavedEditors(
        { serverId: record.sourceServerId, workspaceId: record.workspaceId },
        options.signal,
        () => {
          handoffStarted = true;
          return prepareWorkspaceHandoff({
            ...connections(record),
            ...options,
            workspaceId: record.workspaceId,
            destinationParent: record.destinationParent,
            continuationMode: record.continuationMode,
            expectedAgentIds: record.reviewedAgentIds,
          });
        },
      );
    } catch (error) {
      if (error instanceof FileEditorSaveError) {
        throw new HandoffFilesNotSavedError(
          i18n.t("handoff.unsavedFileError", { path: error.path }) +
            (error.detail ? ` ${error.detail}` : ""),
          { cause: error },
        );
      }
      if (!handoffStarted && options.signal.aborted) {
        throw new HandoffFilesNotSavedError(i18n.t("handoff.paused"), { cause: error });
      }
      if (!handoffStarted) {
        throw new HandoffFilesNotSavedError(i18n.t("panels.file.editor.recoveryLoadError"), {
          cause: error,
        });
      }
      throw error;
    }
  },
  activate: (record, options) =>
    activateWorkspaceHandoff({
      ...options,
      sourceServerId: record.sourceServerId,
      getSource: () => connectedClient(record.sourceServerId),
      destination: connectedClient(record.destinationServerId),
      transferId: record.transferId,
    }),
  cancel: (record, options) =>
    cancelWorkspaceHandoff({
      ...options,
      sourceServerId: record.sourceServerId,
      getSource: () => connectedClient(record.sourceServerId),
      destination: connectedClient(record.destinationServerId),
      transferId: record.transferId,
    }),
};
