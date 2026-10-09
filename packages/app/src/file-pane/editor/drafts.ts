import AsyncStorage from "@react-native-async-storage/async-storage";
import { FileVersionSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";

const IdentitySchema = z.object({
  serverId: z.string().min(1),
  workspaceId: z.string().min(1),
  tabId: z.string().min(1),
  cwd: z.string().min(1),
  path: z.string().min(1),
});
export type FileEditorDraftIdentity = z.infer<typeof IdentitySchema>;
export const FileEditorDraftSchema = z.object({
  content: z.string(),
  conflict: z.boolean(),
  base: z.object({
    content: z.string(),
    hasBom: z.boolean(),
    version: FileVersionSchema.options[0],
  }),
});
export type FileEditorDraft = z.infer<typeof FileEditorDraftSchema>;
const RecordSchema = z.object({
  version: z.literal(1),
  identity: IdentitySchema,
  draft: FileEditorDraftSchema,
});

interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

function workspacePrefix(identity: Pick<FileEditorDraftIdentity, "serverId" | "workspaceId">) {
  return `paseo:file-editor-draft:${JSON.stringify([identity.serverId, identity.workspaceId])}:`;
}

function storageKey(identity: FileEditorDraftIdentity) {
  return workspacePrefix(identity) + JSON.stringify([identity.tabId, identity.cwd, identity.path]);
}

export function createFileEditorDraftStorage(storage: Storage) {
  async function read(key: string) {
    const raw = await storage.getItem(key);
    if (raw === null) return null;
    // A damaged recovery copy is user data, not a disposable preference.
    const record = RecordSchema.parse(JSON.parse(raw));
    if (
      storageKey(record.identity) !== key ||
      record.draft.base.version.cwd !== record.identity.cwd ||
      record.draft.base.version.path !== record.identity.path
    )
      throw new Error("Saved file changes belong to a different file");
    return record;
  }

  return {
    async load(identity: FileEditorDraftIdentity): Promise<FileEditorDraft | null> {
      return (await read(storageKey(identity)))?.draft ?? null;
    },
    async save(identity: FileEditorDraftIdentity, draft: FileEditorDraft | null): Promise<void> {
      const key = storageKey(identity);
      if (draft === null) await storage.removeItem(key);
      else await storage.setItem(key, JSON.stringify({ version: 1, identity, draft }));
    },
    async listWorkspace(identity: Pick<FileEditorDraftIdentity, "serverId" | "workspaceId">) {
      const prefix = workspacePrefix(identity);
      const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(prefix));
      const records = await Promise.all(keys.map(read));
      return records.filter((record) => record !== null);
    },
  };
}

export const fileEditorDraftStorage = createFileEditorDraftStorage(AsyncStorage);
