import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const MAX_HTML_CHARS = 512_000;
export const MAX_RENDER_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
const IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico))\s*\)`,
  "gid",
);

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function after(text: string, token: string, from: number): number {
  const position = text.indexOf(token, from);
  return position === -1 ? -1 : position + token.length;
}

function afterDoctype(text: string, from: number): number {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
}

function hasSvgRoot(text: string): boolean {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at));
  }
  return false;
}

function validImage(bytes: Buffer, extension: string): boolean {
  switch (extension) {
    case "png":
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "jpg":
    case "jpeg":
      return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    case "gif":
      return bytes.subarray(0, 4).toString() === "GIF8";
    case "webp":
      return (
        bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
      );
    case "avif":
      return (
        bytes
          .subarray(4, 12)
          .toString()
          .match(/^ftyp(?:avif|avis|mif1)$/) !== null
      );
    case "bmp":
      return (
        bytes.subarray(0, 2).toString() === "BM" && bytes.subarray(6, 10).equals(Buffer.alloc(4))
      );
    case "ico":
      return bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
    case "svg": {
      const head = bytes
        .subarray(0, 4096)
        .toString("utf8")
        .replace(/^\uFEFF/, "");
      return hasSvgRoot(head);
    }
    default:
      return false;
  }
}

async function imageDataUri(reference: string, cwd: string): Promise<string> {
  const imagePath = /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;
  if (!(await lstat(imagePath)).isFile())
    throw new Error(`Local image is not a regular file: ${reference}`);
  const canonical = await realpath(imagePath);
  const cwdRoot = await realpath(cwd);
  const tempRoot = await realpath(tmpdir());
  if (!inside(cwdRoot, canonical) && !inside(tempRoot, canonical)) {
    throw new Error(`Local image is outside the agent cwd and OS temp directory: ${reference}`);
  }
  const info = await stat(canonical);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) {
    throw new Error(`Local image is not a regular file of at most 10 MiB: ${reference}`);
  }
  const handle = await open(canonical, constants.O_RDONLY);
  let bytes: Buffer;
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ start: 0, end: MAX_IMAGE_BYTES })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_IMAGE_BYTES) throw new Error(`Local image exceeds 10 MiB: ${reference}`);
      chunks.push(buffer);
    }
    bytes = Buffer.concat(chunks, total);
  } finally {
    await handle.close().catch(() => undefined);
  }
  const extension = path.extname(canonical).slice(1).toLowerCase();
  if (!validImage(bytes, extension)) {
    throw new Error(`Local image signature does not match its extension: ${reference}`);
  }
  return `data:${MIME_TYPES[extension]};base64,${bytes.toString("base64")}`;
}

export async function inlineLocalImages(html: string, cwd: string): Promise<string> {
  const references = [...html.matchAll(IMAGE_PATTERN)].flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span ? [{ path: html.slice(span[0], span[1]), start: span[0], end: span[1] }] : [];
  });
  const uniquePaths = [...new Set(references.map((reference) => reference.path))];
  const uris = new Map<string, string>();
  for (const imagePath of uniquePaths) {
    try {
      uris.set(imagePath, await imageDataUri(imagePath, cwd));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot inline local image ${imagePath}: ${reason}`, { cause: error });
    }
  }
  const parts: string[] = [];
  let cursor = 0;
  let estimatedBytes = Buffer.byteLength(html);
  for (const reference of references) {
    const uri = uris.get(reference.path)!;
    estimatedBytes += uri.length - Buffer.byteLength(reference.path);
    if (estimatedBytes > MAX_RENDER_BYTES) throw new Error("Prepared HTML exceeds 6 MiB");
    parts.push(html.slice(cursor, reference.start), uri);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  return parts.join("");
}

export class HtmlRenderStore {
  constructor(private readonly paseoHome: string) {}

  private agentDirectory(agentId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error("Invalid agent ID");
    return path.join(this.paseoHome, "html-renders", agentId);
  }

  async publish(input: {
    agentId: string;
    cwd: string;
    html: string;
    title: string;
    height: number;
  }) {
    if (input.html.length > MAX_HTML_CHARS) throw new Error("HTML exceeds 512,000 characters");
    const html = await inlineLocalImages(input.html, input.cwd);
    if (Buffer.byteLength(html) + 8192 > MAX_RENDER_BYTES) {
      throw new Error("Prepared HTML exceeds 6 MiB");
    }
    const renderId = randomUUID();
    const directory = this.agentDirectory(input.agentId);
    await mkdir(directory, { recursive: true });
    const destination = path.join(directory, `${renderId}.html`);
    const temporary = path.join(directory, `.${renderId}.${randomUUID()}.tmp`);
    const metadata = path.join(directory, `${renderId}.json`);
    const title = input.title.trim().slice(0, 200);
    try {
      await writeFile(temporary, html, { flag: "wx", mode: 0o600 });
      await writeFile(metadata, JSON.stringify({ title }), { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(metadata, { force: true });
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      renderId,
      title,
      height: Math.max(80, Math.min(2000, Math.round(input.height))),
    };
  }

  async get(agentId: string, renderId: string): Promise<{ html: string; title: string }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(renderId)) {
      throw new Error("Invalid render ID");
    }
    const filename = path.join(this.agentDirectory(agentId), `${renderId}.html`);
    const info = await lstat(filename);
    if (!info.isFile() || info.size > MAX_RENDER_BYTES) throw new Error("Render is unavailable");
    const metadataPath = path.join(this.agentDirectory(agentId), `${renderId}.json`);
    const metadataInfo = await lstat(metadataPath);
    if (!metadataInfo.isFile() || metadataInfo.size > 1024)
      throw new Error("Render is unavailable");
    const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("title" in metadata) ||
      typeof metadata.title !== "string"
    ) {
      throw new Error("Render metadata is invalid");
    }
    return { html: await readFile(filename, "utf8"), title: metadata.title };
  }

  async deleteAgent(agentId: string): Promise<void> {
    await rm(this.agentDirectory(agentId), { recursive: true, force: true });
  }
}
