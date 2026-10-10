import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";

export const HEADLESS_SHELL_VERSION = "155.0.8059.39";
const ARCHIVES = {
  linux64: {
    bytes: 124_203_329,
    sha256: "39dcb8c46550632a3d911850ab3b8af840b4e3f6d8622faa2018eb8756278786",
  },
  "linux-arm64": {
    bytes: 124_553_121,
    sha256: "9fb86f7c0b2734c5febc0bbb4e85f37da43553f3f8a7970949828c5713e87e94",
  },
  "mac-arm64": {
    bytes: 102_429_510,
    sha256: "b3e093c06001c41e68decbc8dd4a62f9efe4bf4e4dd247a686ea531863448d75",
  },
  "mac-x64": {
    bytes: 107_758_350,
    sha256: "6338a784c691f42dd1ed6aeeef650171c7d72cf74bdb8450d0079864e72a8074",
  },
  win64: {
    bytes: 124_737_213,
    sha256: "20798f7c51a22def0b3d02e526a8f52e7ee2c7eddcde9d81a4c23f618e8b5436",
  },
} as const;
type ChromePlatform = keyof typeof ARCHIVES;
const execFileAsync = promisify(execFile);

export function headlessShellPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): ChromePlatform | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "mac-arm64";
    if (arch === "x64") return "mac-x64";
  }
  if (platform === "linux") {
    if (arch === "arm64") return "linux-arm64";
    if (arch === "x64") return "linux64";
  }
  if (platform === "win32") return arch === "x64" ? "win64" : null;
  return null;
}

export interface BrowserInstallStatus {
  state: "unsupported" | "missing" | "installing" | "installed" | "failed";
  version: string;
  platform: ChromePlatform | null;
  executable?: string;
  message?: string;
}

function executableName(platform: ChromePlatform): string {
  return platform === "win64" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
}

function releaseDirectory(home: string, platform: ChromePlatform): string {
  return path.join(home, "tools", "chrome-headless-shell", platform);
}

const verifiedExecutables = new Map<string, { signature: string; sha256: string }>();

async function cachedExecutableSha256(
  candidate: string,
  info: Awaited<ReturnType<typeof lstat>>,
): Promise<string> {
  const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const cached = verifiedExecutables.get(candidate);
  if (cached?.signature === signature) return cached.sha256;
  const sha256 = await fileSha256(candidate);
  verifiedExecutables.set(candidate, { signature, sha256 });
  return sha256;
}

async function installationFiles(
  directory: string,
): Promise<Record<string, { bytes: number; sha256: string }>> {
  const files: Record<string, { bytes: number; sha256: string }> = {};
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (!relative && entry.name === "install.json") continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        const filename = path.join(directory, child);
        const info = await lstat(filename);
        if (!info.isFile()) throw new Error("Preview browser installation contains an unsafe file");
        files[child] = { bytes: info.size, sha256: await cachedExecutableSha256(filename, info) };
      } else throw new Error("Preview browser installation contains an unsafe file");
    }
  }
  await visit("");
  return files;
}

async function installedPath(home: string, platform: ChromePlatform): Promise<string | null> {
  const directory = path.join(releaseDirectory(home, platform), HEADLESS_SHELL_VERSION);
  const candidate = path.join(directory, executableName(platform));
  try {
    if (!(await lstat(directory)).isDirectory()) return null;
    const info = await lstat(candidate);
    if (!info.isFile() || (platform !== "win64" && (info.mode & 0o111) === 0)) return null;
    const manifest = JSON.parse(await readFile(path.join(directory, "install.json"), "utf8")) as {
      version?: unknown;
      platform?: unknown;
      executableBytes?: unknown;
      executableSha256?: unknown;
      files?: unknown;
    };
    const files = await installationFiles(directory);
    const expectedFiles =
      manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files)
        ? (manifest.files as Record<string, { bytes?: unknown; sha256?: unknown }>)
        : null;
    if (
      manifest.version !== HEADLESS_SHELL_VERSION ||
      manifest.platform !== platform ||
      manifest.executableBytes !== info.size ||
      typeof manifest.executableSha256 !== "string" ||
      manifest.executableSha256 !== (await cachedExecutableSha256(candidate, info)) ||
      !expectedFiles ||
      Object.keys(expectedFiles).length !== Object.keys(files).length ||
      Object.entries(files).some(
        ([name, file]) =>
          expectedFiles[name]?.bytes !== file.bytes || expectedFiles[name]?.sha256 !== file.sha256,
      )
    )
      return null;
    return candidate;
  } catch {
    return null;
  }
}

async function fileSha256(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function smokeTest(candidate: string): Promise<void> {
  const { stdout } = await execFileAsync(candidate, ["--version"], { timeout: 10_000 });
  if (!stdout.includes(HEADLESS_SHELL_VERSION))
    throw new Error("Preview browser executable has the wrong version");
}

const installs = new Map<string, Promise<string>>();
const failures = new Map<string, string>();

interface LockOwner {
  pid: number;
  token: string;
}

async function readLockOwner(lock: string): Promise<LockOwner | null> {
  try {
    if (!(await lstat(lock)).isDirectory()) return null;
    const value = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as LockOwner;
    return Number.isInteger(value.pid) && value.pid > 0 && typeof value.token === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function assertLockOwner(lock: string, owner: LockOwner): Promise<void> {
  const current = await readLockOwner(lock);
  if (current?.pid !== owner.pid || current.token !== owner.token)
    throw new Error("Preview browser install lock ownership changed");
}

export async function headlessShellStatus(home: string): Promise<BrowserInstallStatus> {
  const platform = headlessShellPlatform();
  if (!platform) return { state: "unsupported", platform, version: HEADLESS_SHELL_VERSION };
  const executable = await installedPath(home, platform);
  if (executable)
    return { state: "installed", platform, version: HEADLESS_SHELL_VERSION, executable };
  const directory = releaseDirectory(home, platform);
  if (installs.has(directory))
    return { state: "installing", platform, version: HEADLESS_SHELL_VERSION };
  const lock = path.join(directory, ".install-lock");
  if (await lstat(lock).catch(() => null)) {
    const owner = await readLockOwner(lock);
    if (owner && ownerAlive(owner.pid))
      return { state: "installing", platform, version: HEADLESS_SHELL_VERSION };
    return {
      state: "failed",
      platform,
      version: HEADLESS_SHELL_VERSION,
      message: owner
        ? "An abandoned preview browser install can be repaired by setup"
        : "Preview browser install lock has no valid owner",
    };
  }
  if (failures.has(directory))
    return {
      state: "failed",
      platform,
      version: HEADLESS_SHELL_VERSION,
      message: failures.get(directory),
    };
  return { state: "missing", platform, version: HEADLESS_SHELL_VERSION };
}

async function downloadArchive(platform: ChromePlatform, filename: string): Promise<void> {
  const release = ARCHIVES[platform];
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${HEADLESS_SHELL_VERSION}/${platform}/chrome-headless-shell-${platform}.zip`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (
    !response.ok ||
    !response.body ||
    new URL(response.url).origin !== "https://storage.googleapis.com"
  ) {
    throw new Error("Could not download the pinned preview browser");
  }
  if (
    response.headers.get("content-length") &&
    Number(response.headers.get("content-length")) !== release.bytes
  ) {
    throw new Error("Preview browser archive length differs from its pin");
  }
  const handle = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const hash = createHash("sha256");
  let count = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      count += chunk.byteLength;
      if (count > release.bytes)
        throw new Error("Preview browser archive exceeds its pinned length");
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
  } finally {
    reader.releaseLock();
    await handle.close();
  }
  if (count !== release.bytes || hash.digest("hex") !== release.sha256) {
    throw new Error("Preview browser archive failed length or SHA-256 verification");
  }
}

interface ZipEntry {
  relative: string;
  compressed: number;
  uncompressed: number;
  method: number;
  offset: number;
  mode: number;
  directory: boolean;
}

function findZipEnd(zip: Buffer): number {
  let eocd = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65_557); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0 || zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0)
    throw new Error("Invalid preview browser ZIP");
  return eocd;
}

function readZipEntry(zip: Buffer, at: number, root: string): { entry: ZipEntry; next: number } {
  if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("Invalid preview browser ZIP entry");
  const flags = zip.readUInt16LE(at + 8);
  const method = zip.readUInt16LE(at + 10);
  const compressed = zip.readUInt32LE(at + 20);
  const uncompressed = zip.readUInt32LE(at + 24);
  const nameLength = zip.readUInt16LE(at + 28);
  const extraLength = zip.readUInt16LE(at + 30);
  const commentLength = zip.readUInt16LE(at + 32);
  const mode = zip.readUInt32LE(at + 38) >>> 16;
  const offset = zip.readUInt32LE(at + 42);
  const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
  const relative = name.startsWith(root) ? name.slice(root.length) : "";
  const directory = name.endsWith("/");
  const kind = mode & 0o170000;
  const parts = (directory ? relative.slice(0, -1) : relative).split("/");
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.includes(":") ||
    relative.includes("\0") ||
    parts.some((part) => part === ".." || part === "." || part === "") ||
    flags & 1 ||
    ![0, 8].includes(method) ||
    (kind && kind !== (directory ? 0o040000 : 0o100000))
  )
    throw new Error("Preview browser ZIP contains an unsafe entry");
  return {
    entry: { relative, compressed, uncompressed, method, offset, mode, directory },
    next: at + 46 + nameLength + extraLength + commentLength,
  };
}

function zipEntries(zip: Buffer, platform: ChromePlatform): ZipEntry[] {
  const eocd = findZipEnd(zip);
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  let at = zip.readUInt32LE(eocd + 16);
  if (count > 1000 || at + centralSize > eocd) throw new Error("Invalid preview browser ZIP index");
  const root = `chrome-headless-shell-${platform}/`;
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    const next = readZipEntry(zip, at, root);
    if (seen.has(next.entry.relative))
      throw new Error("Preview browser ZIP contains an unsafe entry");
    seen.add(next.entry.relative);
    total += next.entry.uncompressed;
    if (total > 400 * 1024 * 1024) throw new Error("Preview browser ZIP exceeds extraction limit");
    entries.push(next.entry);
    at = next.next;
  }
  if (at !== zip.readUInt32LE(eocd + 16) + centralSize || !seen.has(executableName(platform)))
    throw new Error("Preview browser ZIP is incomplete");
  return entries;
}

async function writeZipEntry(zip: Buffer, entry: ZipEntry, destination: string): Promise<void> {
  const target = path.join(destination, entry.relative);
  if (entry.directory) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    return;
  }
  const start = entry.offset;
  if (zip.readUInt32LE(start) !== 0x04034b50)
    throw new Error("Invalid preview browser ZIP local header");
  const dataStart = start + 30 + zip.readUInt16LE(start + 26) + zip.readUInt16LE(start + 28);
  if (dataStart + entry.compressed > zip.length)
    throw new Error("Preview browser ZIP entry is truncated");
  const compressed = zip.subarray(dataStart, dataStart + entry.compressed);
  const data =
    entry.method === 8
      ? inflateRawSync(compressed, { maxOutputLength: entry.uncompressed + 1 })
      : compressed;
  if (data.length !== entry.uncompressed)
    throw new Error("Preview browser ZIP entry length mismatch");
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, data, { flag: "wx", mode: entry.mode & 0o777 || 0o600 });
}

// The whole archive has already passed its pinned hash. Validate every ZIP entry before writing any of them.
export async function extractHeadlessShell(
  archivePath: string,
  platform: ChromePlatform,
  destination: string,
): Promise<void> {
  const zip = await readFile(archivePath);
  const entries = zipEntries(zip, platform);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) await writeZipEntry(zip, entry, destination);
}

async function recoverAbandonedLock(
  lock: string,
  current: LockOwner,
  cause: unknown,
): Promise<void> {
  const abandoned = path.join(path.dirname(lock), `.abandoned-${randomUUID()}`);
  try {
    await rename(lock, abandoned);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = await readLockOwner(abandoned);
  if (moved?.token !== current.token || moved.pid !== current.pid) {
    await rename(abandoned, lock).catch(() => undefined);
    throw new Error("Preview browser install lock changed during recovery", { cause });
  }
  await rm(abandoned, { recursive: true, force: true });
}

async function acquireInstallLock(lock: string, owner: LockOwner): Promise<void> {
  const root = path.dirname(lock);
  for (;;) {
    const proposed = path.join(root, `.lock-${owner.token}`);
    await mkdir(proposed, { mode: 0o700 });
    try {
      await writeFile(path.join(proposed, "owner.json"), JSON.stringify(owner), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(proposed, lock);
      return;
    } catch (error) {
      await rm(proposed, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      const current = await readLockOwner(lock);
      if (!current)
        throw new Error("Preview browser install lock has no valid owner", { cause: error });
      if (!ownerAlive(current.pid)) await recoverAbandonedLock(lock, current, error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function installLocked(
  home: string,
  platform: ChromePlatform,
  archiveSource?: string,
): Promise<string> {
  const root = releaseDirectory(home, platform);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory())
    throw new Error("Preview browser install root is not a real directory");
  const lock = path.join(root, ".install-lock");
  const destination = path.join(root, HEADLESS_SHELL_VERSION);
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  const existing = await installedPath(home, platform);
  if (existing) return existing;
  await acquireInstallLock(lock, owner);
  const staging = path.join(root, `.install-${randomUUID()}`);
  try {
    await assertLockOwner(lock, owner);
    const installedAfterLock = await installedPath(home, platform);
    if (installedAfterLock) return installedAfterLock;
    for (const entry of await readdir(root)) {
      if (entry.startsWith(".install-") && entry !== ".install-lock")
        await rm(path.join(root, entry), { recursive: true, force: true });
    }
    await mkdir(staging, { mode: 0o700 });
    const archive = path.join(staging, "download.zip");
    if (archiveSource) {
      await copyFile(archiveSource, archive);
      const info = await stat(archive);
      if (
        info.size !== ARCHIVES[platform].bytes ||
        (await fileSha256(archive)) !== ARCHIVES[platform].sha256
      )
        throw new Error("Preview browser archive failed length or SHA-256 verification");
    } else await downloadArchive(platform, archive);
    const unpacked = path.join(staging, "browser");
    await extractHeadlessShell(archive, platform, unpacked);
    const candidate = path.join(unpacked, executableName(platform));
    await smokeTest(candidate);
    const executableInfo = await lstat(candidate);
    await writeFile(
      path.join(unpacked, "install.json"),
      JSON.stringify({
        version: HEADLESS_SHELL_VERSION,
        platform,
        executableBytes: executableInfo.size,
        executableSha256: await fileSha256(candidate),
        files: await installationFiles(unpacked),
      }),
      { flag: "wx", mode: 0o600 },
    );
    await assertLockOwner(lock, owner);
    if (await lstat(destination).catch(() => null))
      await rename(destination, path.join(root, `.corrupt-${randomUUID()}`));
    await rename(unpacked, destination);
    const installed = await installedPath(home, platform);
    if (!installed) throw new Error("Preview browser installation failed verification");
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (await readLockOwner(lock).then((current) => current?.token === owner.token))
      await rm(lock, { recursive: true, force: true });
  }
}

export async function ensureHeadlessShell(
  home: string,
  waitMs = 45_000,
  archiveSource?: string,
): Promise<string | null> {
  const platform = headlessShellPlatform();
  if (!platform) throw new Error("Preview browser is unsupported on this platform");
  const directory = releaseDirectory(home, platform);
  const existing = await installedPath(home, platform);
  if (existing) return existing;
  let pending = installs.get(directory);
  if (!pending) {
    pending = installLocked(home, platform, archiveSource);
    installs.set(directory, pending);
    void (async () => {
      try {
        await pending;
        failures.delete(directory);
      } catch (error) {
        failures.set(directory, error instanceof Error ? error.message : "Browser install failed");
      } finally {
        installs.delete(directory);
      }
    })();
  }
  if (waitMs < 0) return pending;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
