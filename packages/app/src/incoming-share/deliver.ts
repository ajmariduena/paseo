import { File } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import { persistAttachmentFromFileUri } from "@/attachments/service";
import type { SelectedFile } from "@/attachments/selected-file";
import type { UserComposerAttachment } from "@/attachments/types";
import { generateAttachmentId, pathToFileUri } from "@/attachments/utils";
import { uploadFileAttachments, type ComposerSendClient } from "@/composer/actions";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { IncomingShare, IncomingShareFile } from "./model";

export type IncomingShareTarget = { kind: "agent"; agentId: string } | { kind: "new_agent" };

export interface IncomingShareDestination {
  serverId: string;
  workspaceId: string;
  target: IncomingShareTarget;
}

// Android shares arrive as content:// URIs; copying through the legacy API is
// what reads them with the sender's grant before the bytes are uploaded.
async function readSharedFileBytes(file: IncomingShareFile): Promise<Uint8Array> {
  if (!FileSystem.cacheDirectory) {
    throw new Error("Cache directory is unavailable.");
  }
  const copyUri = `${FileSystem.cacheDirectory}incoming-share-${generateAttachmentId()}`;
  await FileSystem.copyAsync({ from: pathToFileUri(file.uri), to: copyUri });
  try {
    return await new File(copyUri).bytes();
  } finally {
    await FileSystem.deleteAsync(copyUri, { idempotent: true });
  }
}

export class IncomingShareHostDisconnectedError extends Error {
  constructor(readonly serverId: string) {
    super(`Host ${serverId} has no client to upload shared files to`);
    this.name = "IncomingShareHostDisconnectedError";
  }
}

async function buildShareAttachments(input: {
  share: IncomingShare;
  serverId: string;
  client: ComposerSendClient | null;
}): Promise<UserComposerAttachment[]> {
  const images = input.share.files.filter((file) => file.kind === "image");
  const selectedFiles: SelectedFile[] = input.share.files
    .filter((file) => file.kind === "file")
    .map((file) => ({
      fileName: file.fileName,
      mimeType: file.mimeType,
      readBytes: () => readSharedFileBytes(file),
    }));
  const client = input.client;
  if (selectedFiles.length > 0 && !client) {
    throw new IncomingShareHostDisconnectedError(input.serverId);
  }

  const imageAttachments = await Promise.all(
    images.map(async (image): Promise<UserComposerAttachment> => {
      const metadata = await persistAttachmentFromFileUri({
        uri: image.uri,
        mimeType: image.mimeType,
        fileName: image.fileName,
      });
      return { kind: "image", metadata };
    }),
  );
  const readyAttachments = input.share.attachments ?? [];
  if (!client) {
    return [...readyAttachments, ...imageAttachments];
  }
  const fileAttachments = await uploadFileAttachments({ client, files: selectedFiles });
  return [...readyAttachments, ...imageAttachments, ...fileAttachments];
}

interface ComposerDestination {
  draftKey: string;
  tab: WorkspaceTabTarget;
}

function resolveComposerDestination(input: {
  serverId: string;
  target: IncomingShareTarget;
}): ComposerDestination {
  if (input.target.kind === "agent") {
    const agentId = input.target.agentId;
    return {
      draftKey: buildDraftStoreKey({ serverId: input.serverId, agentId }),
      tab: { kind: "agent", agentId },
    };
  }
  const draftId = generateDraftId();
  return {
    draftKey: buildDraftStoreKey({ serverId: input.serverId, agentId: draftId, draftId }),
    tab: { kind: "draft", draftId },
  };
}

/** Puts the shared content in the destination composer's draft and opens it. */
export async function deliverIncomingShare(input: {
  share: IncomingShare;
  destination: IncomingShareDestination;
  client: ComposerSendClient | null;
}): Promise<void> {
  const { serverId, workspaceId, target } = input.destination;
  const attachments = await buildShareAttachments({
    share: input.share,
    serverId,
    client: input.client,
  });
  const composer = resolveComposerDestination({ serverId, target });
  await useDraftStore.getState().appendDraftContent({
    draftKey: composer.draftKey,
    addition: { text: input.share.text, attachments },
  });
  navigateToWorkspace({ serverId, workspaceId, target: composer.tab });
}
