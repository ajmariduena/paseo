import { i18n } from "@/i18n/i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import {
  activateWorkspaceHandoff,
  cancelWorkspaceHandoff,
  prepareWorkspaceHandoff,
} from "@getpaseo/client/internal/workspace-handoff";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import type { HandoffFormPorts } from "./form-model";
import {
  createHandoffPersistence,
  restoreHandoffRecord,
  restoreReservedHandoffRecord,
  type HandoffRecord,
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

const persistence = createHandoffPersistence(AsyncStorage);
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
    const source = connectedClient(origin.sourceServerId);
    const response = await connectedClient(destination.serverId).handoffGetDestinationStatus({
      transferId,
    });
    if (response.error) throw new Error(response.error.message);
    if (!response.result) throw new Error("Destination handoff record is missing");
    const snapshot = response.result;
    const held = await source.handoffFindSource({ workspaceId: origin.workspaceId });
    if (held.error) throw new Error(held.error.message);
    if (held.result)
      return restoreHandoffRecord({ origin, destination, snapshot, source: held.result });
    const previous = await source.handoffGetSourceStatus({ transferId });
    if (previous.error && previous.error.code !== "not_found")
      throw new Error(previous.error.message);
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
    await persistence.save(record);
    return record;
  },
  newTransferId: randomUUID,
  async validate(record) {
    const { source, destination } = connections(record);
    const inspection = await source.handoffPreviewSource({ workspaceId: record.workspaceId });
    if (inspection.error) throw new Error(inspection.error.message);
    if (!inspection.result) throw new Error("Source preview is missing");
    await destination.listDirectory(record.destinationParent, ".");
    const preview = await destination.handoffPreviewDestination({
      conversations: inspection.result.conversations,
    });
    if (preview.error) throw new Error(preview.error.message);
    if (!preview.result) throw new Error("Destination preview is missing");
    return preview.result;
  },
  prepare: (record, options) =>
    prepareWorkspaceHandoff({
      ...connections(record),
      ...options,
      workspaceId: record.workspaceId,
      destinationParent: record.destinationParent,
      continuationMode: record.continuationMode,
      expectedAgentIds: record.reviewedAgentIds,
    }),
  activate: (record, options) =>
    activateWorkspaceHandoff({
      ...options,
      sourceServerId: record.sourceServerId,
      getSource: () => connectedClient(record.sourceServerId),
      destination: connectedClient(record.destinationServerId),
      transferId: record.transferId,
    }),
  cancel: (record, options) => cancelWorkspaceHandoff({ ...connections(record), ...options }),
};
