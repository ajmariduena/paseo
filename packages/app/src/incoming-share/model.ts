import { z } from "zod";
import { resolveRasterImageMimeType } from "@/attachments/file-types";
import { getFileNameFromPath } from "@/attachments/utils";

export const MAX_INCOMING_SHARE_FILES = 8;

const GENERIC_FILE_MIME_TYPE = "application/octet-stream";
const SHARE_EXTENSION_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/dataUrl=/i;

export interface IncomingShareFile {
  kind: "image" | "file";
  uri: string;
  fileName: string;
  mimeType: string;
}

export interface IncomingShare {
  text: string;
  files: IncomingShareFile[];
  droppedFileCount: number;
}

const NativeShareFileSchema = z.object({
  path: z.string().nullish(),
  contentUri: z.string().nullish(),
  filePath: z.string().nullish(),
  fileName: z.string().nullish(),
  mimeType: z.string().nullish(),
});

const NativeShareSchema = z.object({
  text: z.string().nullish(),
  meta: z.object({ title: z.string().nullish() }).nullish(),
  weburls: z.array(z.object({ url: z.string(), meta: z.string().nullish() })).nullish(),
  files: z.array(z.unknown()).nullish(),
});

type NativeShareFile = z.infer<typeof NativeShareFileSchema>;

export class InvalidIncomingShareError extends Error {
  constructor(readonly payload: unknown) {
    super("Unrecognized share payload");
    this.name = "InvalidIncomingShareError";
  }
}

/** The iOS share extension reopens the app through `<scheme>://dataUrl=<key>#<type>`. */
export function isShareExtensionUrl(url: string): boolean {
  return SHARE_EXTENSION_URL_PATTERN.test(url);
}

function parseJsonPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidIncomingShareError(raw);
  }
}

function readWebPageTitle(meta: string | null | undefined): string | null {
  if (!meta) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(meta);
    const result = z.object({ title: z.string() }).safeParse(parsed);
    return result.success ? result.data.title.trim() || null : null;
  } catch {
    return null;
  }
}

function isBareUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text);
}

function withTitle(text: string, title: string | null): string {
  if (!title || !isBareUrl(text) || text === title) {
    return text;
  }
  return `${title}\n${text}`;
}

function buildSharedText(share: z.infer<typeof NativeShareSchema>): string {
  const parts: string[] = [];
  const text = share.text?.trim();
  if (text) {
    parts.push(withTitle(text, share.meta?.title?.trim() || null));
  }
  for (const webUrl of share.weburls ?? []) {
    const url = webUrl.url.trim();
    if (url && !parts.some((part) => part.includes(url))) {
      parts.push(withTitle(url, readWebPageTitle(webUrl.meta)));
    }
  }
  return parts.join("\n\n");
}

// Android hands over both a content:// URI and a resolved filesystem path. The
// path can point into shared storage the app has no permission to read, while
// the content URI carries the sender's read grant.
function resolveFileUri(file: NativeShareFile): string | null {
  return file.contentUri?.trim() || file.path?.trim() || file.filePath?.trim() || null;
}

function resolveFileName(input: { file: NativeShareFile; uri: string; index: number }): string {
  const named = input.file.fileName?.trim() || getFileNameFromPath(input.file.filePath);
  if (named) {
    return named;
  }
  if (!input.uri.startsWith("content:")) {
    const fromUri = getFileNameFromPath(input.uri.split(/[?#]/, 1)[0]);
    if (fromUri) {
      return fromUri;
    }
  }
  return `shared-file-${input.index + 1}`;
}

function toIncomingShareFile(file: NativeShareFile, index: number): IncomingShareFile | null {
  const uri = resolveFileUri(file);
  if (!uri) {
    return null;
  }
  const fileName = resolveFileName({ file, uri, index });
  const imageMimeType = resolveRasterImageMimeType({ mimeType: file.mimeType, path: fileName });
  if (imageMimeType) {
    return { kind: "image", uri, fileName, mimeType: imageMimeType };
  }
  const mimeType = file.mimeType?.trim().toLowerCase() || GENERIC_FILE_MIME_TYPE;
  return { kind: "file", uri, fileName, mimeType };
}

function collectFiles(rawFiles: readonly unknown[]): IncomingShareFile[] {
  const files: IncomingShareFile[] = [];
  const seenUris = new Set<string>();
  for (const rawFile of rawFiles) {
    const parsed = NativeShareFileSchema.safeParse(rawFile);
    if (!parsed.success) {
      continue;
    }
    const file = toIncomingShareFile(parsed.data, files.length);
    if (!file || seenUris.has(file.uri)) {
      continue;
    }
    seenUris.add(file.uri);
    files.push(file);
  }
  return files;
}

/**
 * Normalizes the expo-share-intent native event value — a JSON string on iOS,
 * an object on Android — into composer text plus the files to attach.
 * Returns null when the share carries nothing usable.
 */
export function parseIncomingShare(raw: unknown): IncomingShare | null {
  const payload = typeof raw === "string" ? parseJsonPayload(raw) : raw;
  const parsed = NativeShareSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidIncomingShareError(raw);
  }
  const text = buildSharedText(parsed.data);
  const files = collectFiles(parsed.data.files ?? []);
  if (!text && files.length === 0) {
    return null;
  }
  return {
    text,
    files: files.slice(0, MAX_INCOMING_SHARE_FILES),
    droppedFileCount: Math.max(0, files.length - MAX_INCOMING_SHARE_FILES),
  };
}
