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
import { createHandoffPersistence, type HandoffRecord } from "./persistence";

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

export const handoffFormPorts: HandoffFormPorts = {
  ...createHandoffPersistence(AsyncStorage),
  newTransferId: randomUUID,
  async validate(record) {
    const { source, destination } = connections(record);
    const inspection = await source.handoffInspectSource({ workspaceId: record.workspaceId });
    if (inspection.error) throw new Error(inspection.error.message);
    await destination.listDirectory(record.destinationParent, ".");
  },
  prepare: (record, options) =>
    prepareWorkspaceHandoff({
      ...connections(record),
      ...options,
      workspaceId: record.workspaceId,
      destinationParent: record.destinationParent,
      continuationMode: record.continuationMode,
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
