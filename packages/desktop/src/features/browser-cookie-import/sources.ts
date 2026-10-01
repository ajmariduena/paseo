// Adapted from stablyai/orca (MIT).
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  chromiumPartition,
  databaseSameSite,
  firefoxPartition,
  importableDomain,
  isGoogle,
  registrableFamily,
  type SourceCookie,
} from "./policy.js";
import type { BrowserCookieImportFamily, BrowserCookieImportSource } from "./types.js";

interface ChromiumDef {
  family: BrowserCookieImportFamily;
  label: string;
  service: string;
  account: string;
  mac?: string;
  win?: string;
  linux?: string;
}
const chromium: ChromiumDef[] = [
  {
    family: "chrome",
    label: "Google Chrome",
    service: "Chrome Safe Storage",
    account: "Chrome",
    mac: "Google/Chrome",
    win: "Google/Chrome/User Data",
    linux: "google-chrome",
  },
  {
    family: "edge",
    label: "Microsoft Edge",
    service: "Microsoft Edge Safe Storage",
    account: "Microsoft Edge",
    mac: "Microsoft Edge",
    win: "Microsoft/Edge/User Data",
    linux: "microsoft-edge",
  },
  {
    family: "arc",
    label: "Arc",
    service: "Arc Safe Storage",
    account: "Arc",
    mac: "Arc/User Data",
  },
  {
    family: "brave",
    label: "Brave",
    service: "Brave Safe Storage",
    account: "Brave",
    mac: "BraveSoftware/Brave-Browser",
    win: "BraveSoftware/Brave-Browser/User Data",
    linux: "BraveSoftware/Brave-Browser",
  },
  {
    family: "comet",
    label: "Comet",
    service: "Comet Safe Storage",
    account: "Comet",
    mac: "Comet",
    win: "Comet/User Data",
  },
  {
    family: "helium",
    label: "Helium",
    service: "Helium Storage Key",
    account: "Helium",
    mac: "net.imput.helium",
  },
  {
    family: "chromium",
    label: "Chromium",
    service: "Chromium Safe Storage",
    account: "Chromium",
    mac: "Chromium",
    win: "Chromium/User Data",
    linux: "chromium",
  },
];
export interface DetectedSource extends BrowserCookieImportSource {
  profiles: Array<{ id: string; label: string; path: string }>;
  definition?: ChromiumDef;
}
export class SourceError extends Error {
  constructor(
    public readonly code: "source_busy" | "keychain_denied" | "full_disk_access" | "failed",
  ) {
    super(code);
    this.name = "SourceError";
  }
}
export function validProfileId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id !== "." &&
    !id.includes("..") &&
    !/[/\\]/.test(id) &&
    !id.includes("\0")
  );
}
function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
// Without Full Disk Access, macOS refuses even a stat inside Safari's container; still list
// Safari so the import can explain the permission instead of hiding the browser.
function presentOrProtected(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}
function rootFor(def: ChromiumDef): string | null {
  let platformRoot: string | undefined;
  if (process.platform === "darwin") platformRoot = def.mac;
  else if (process.platform === "win32") platformRoot = def.win;
  else platformRoot = def.linux;
  if (!platformRoot) return null;
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", platformRoot);
  if (process.platform === "win32")
    return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, platformRoot) : null;
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), platformRoot);
}
function cookieDb(profileDir: string): string | null {
  for (const filename of [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")])
    if (readable(filename)) return filename;
  return null;
}
function contained(root: string, child: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(child));
    return !!rel && rel !== ".." && !rel.startsWith(".." + sep) && !rel.startsWith(sep);
  } catch {
    return false;
  }
}
function chromiumProfiles(root: string): Array<{ id: string; label: string; path: string }> {
  let cache: Record<string, { name?: unknown }> = {};
  try {
    const localState = JSON.parse(readFileSync(join(root, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    cache = localState.profile?.info_cache ?? {};
  } catch {
    /* Default fallback. */
  }
  const entries = Object.keys(cache).length
    ? Object.entries(cache)
    : [["Default", { name: "Default" }] as const];
  return entries.flatMap(([id, info]) => {
    if (!validProfileId(id)) return [];
    const dir = join(root, id);
    const path = cookieDb(dir);
    return path && contained(root, path)
      ? [{ id, label: typeof info.name === "string" ? info.name : id, path }]
      : [];
  });
}
function firefoxRoot(): string | null {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Firefox", "Profiles");
  if (process.platform === "win32")
    return process.env.APPDATA ? join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles") : null;
  return join(homedir(), ".mozilla", "firefox");
}
export function detectSources(): DetectedSource[] {
  const found: DetectedSource[] = [];
  for (const def of chromium) {
    const root = rootFor(def);
    if (!root || !existsSync(root)) continue;
    const profiles = chromiumProfiles(root);
    if (profiles.length)
      found.push({ family: def.family, label: def.label, profiles, definition: def });
  }
  const ffRoot = firefoxRoot();
  if (ffRoot && existsSync(ffRoot)) {
    let entries: Dirent[];
    try {
      entries = readdirSync(ffRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const profiles = entries
      .filter((entry) => entry.isDirectory() && validProfileId(entry.name))
      .map((entry) => {
        const path = join(ffRoot, entry.name, "cookies.sqlite");
        return readable(path) && contained(ffRoot, path)
          ? {
              id: entry.name,
              label: entry.name.includes(".")
                ? entry.name.split(".").slice(1).join(".")
                : entry.name,
              path,
            }
          : null;
      })
      .filter((value): value is { id: string; label: string; path: string } => value !== null)
      .sort(
        (a, b) =>
          Number(b.id.includes("default-release")) - Number(a.id.includes("default-release")),
      );
    if (profiles.length) found.push({ family: "firefox", label: "Firefox", profiles });
  }
  if (process.platform === "darwin") {
    for (const path of [
      join(homedir(), "Library", "Cookies", "Cookies.binarycookies"),
      join(
        homedir(),
        "Library",
        "Containers",
        "com.apple.Safari",
        "Data",
        "Library",
        "Cookies",
        "Cookies.binarycookies",
      ),
    ]) {
      if (presentOrProtected(path)) {
        found.push({
          family: "safari",
          label: "Safari",
          profiles: [{ id: "Default", label: "Safari", path }],
          requiresFullDiskAccess: true,
        });
        break;
      }
    }
  }
  return found;
}
export function selectedSource(
  family: BrowserCookieImportFamily,
  profileId?: string,
): { source: DetectedSource; profile: DetectedSource["profiles"][number] } | null {
  if (profileId !== undefined && !validProfileId(profileId)) return null;
  const source = detectSources().find((entry) => entry.family === family);
  if (!source) return null;
  const profile = profileId
    ? source.profiles.find((item) => item.id === profileId)
    : source.profiles[0];
  return profile ? { source, profile } : null;
}
interface FileState {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtime: bigint;
  ctime: bigint;
}
function fileState(path: string): FileState | null {
  try {
    const stat = statSync(path, { bigint: true });
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtime: stat.mtimeNs,
      ctime: stat.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export function snapshotDatabase(
  path: string,
  options: { tempRoot?: string; copy?: (from: string, to: string) => void } = {},
): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(options.tempRoot ?? tmpdir(), "paseo-cookie-import-"));
  const target = join(dir, basename(path));
  const copy = options.copy ?? copyFileSync;
  let success = false;
  try {
    for (let n = 0; n < 5; n++) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(target + suffix);
        } catch {
          /* Partial prior attempt. */
        }
      }
      try {
        const before = fileState(path),
          walBefore = fileState(path + "-wal");
        if (!before) break;
        copy(path, target);
        if (walBefore) copy(path + "-wal", target + "-wal");
        const after = fileState(path),
          walAfter = fileState(path + "-wal");
        const targetState = fileState(target),
          targetWal = fileState(target + "-wal");
        if (
          JSON.stringify(before, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          ) ===
            JSON.stringify(after, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
            ) &&
          JSON.stringify(walBefore, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          ) ===
            JSON.stringify(walAfter, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
            ) &&
          targetState?.size === before.size &&
          (walBefore ? targetWal?.size === walBefore.size : targetWal === null)
        ) {
          success = true;
          return {
            path: target,
            cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }),
          };
        }
      } catch {
        /* Retry a moving or locked source. */
      }
    }
    throw new SourceError("source_busy");
  } finally {
    if (!success) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
type Key =
  | { mode: "cbc"; versions: Partial<Record<"v10" | "v11", Buffer>> }
  | { mode: "gcm"; value: Buffer };
function command(file: string, args: string[], timeout: number, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
    if (input !== undefined) child.stdin?.end(input + "\n");
  });
}
async function keyFor(source: DetectedSource, needsV11: boolean): Promise<Key | null> {
  const def = source.definition;
  if (!def) return null;
  if (process.platform === "darwin") {
    try {
      const password = await command(
        "security",
        ["find-generic-password", "-w", "-s", def.service, "-a", def.account],
        // The Keychain prompt waits on the user typing a password.
        120_000,
      );
      return {
        mode: "cbc",
        versions: {
          v10: pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"),
          v11: pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"),
        },
      };
    } catch {
      throw new SourceError("keychain_denied");
    }
  }
  if (process.platform === "linux") {
    const versions: Partial<Record<"v10" | "v11", Buffer>> = {
      v10: pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1"),
    };
    if (!needsV11) return { mode: "cbc", versions };
    let password: string | null = null;
    try {
      password = await command(
        "secret-tool",
        ["lookup", "service", def.service, "account", def.account],
        5_000,
      );
    } catch {
      try {
        password = await command(
          "secret-tool",
          ["lookup", "application", def.account.toLowerCase().replaceAll(" ", "")],
          5_000,
        );
      } catch {
        /* v10 remains usable. */
      }
    }
    if (password) versions.v11 = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
    return { mode: "cbc", versions };
  }
  if (process.platform === "win32") {
    try {
      const root = rootFor(def);
      if (!root) return null;
      const localState = JSON.parse(readFileSync(join(root, "Local State"), "utf8")) as {
        os_crypt?: { encrypted_key?: string };
      };
      const encrypted = Buffer.from(localState.os_crypt?.encrypted_key ?? "", "base64");
      if (encrypted.subarray(0, 5).toString() !== "DPAPI") return null;
      const script = [
        "try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop }",
        "catch { try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {} };",
        "$in=[Convert]::FromBase64String([Console]::In.ReadLine());",
        "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,",
        "[System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
        "[Convert]::ToBase64String($out)",
      ].join("");
      const shell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const output = await command(
        shell,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        10_000,
        encrypted.subarray(5).toString("base64"),
      );
      return { mode: "gcm", value: Buffer.from(output, "base64") };
    } catch {
      return null;
    }
  }
  return null;
}
export function decryptChromium(
  encrypted: Buffer,
  key: Key | null,
  host: string,
  dbVersion = 0,
): Buffer | null {
  const version = encrypted.subarray(0, 3).toString();
  if (version === "v20" || !key || !/^v\d\d$/.test(version)) return null;
  try {
    let plain: Buffer;
    if (key.mode === "gcm") {
      const payload = encrypted.subarray(3);
      if (payload.length < 28) return null;
      const decipher = createDecipheriv("aes-256-gcm", key.value, payload.subarray(0, 12));
      decipher.setAuthTag(payload.subarray(-16));
      plain = Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()]);
    } else {
      const cbcKey = key.versions[version as "v10" | "v11"];
      if (!cbcKey) return null;
      const decipher = createDecipheriv("aes-128-cbc", cbcKey, Buffer.alloc(16, " "));
      plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    }
    const hash = createHash("sha256").update(host).digest();
    if (
      plain.length >= 32 &&
      ((dbVersion >= 24 && plain.subarray(0, 32).equals(hash)) ||
        plain.subarray(0, 32).equals(hash))
    )
      return plain.subarray(32);
    return plain;
  } catch {
    return null;
  }
}
function readRows(
  dbPath: string,
  table: string,
): { columns: Set<string>; rows: Record<string, unknown>[]; version: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(" + table + ")").all() as Array<{ name: string }>).map(
        (entry) => entry.name,
      ),
    );
    const statement = db.prepare("SELECT * FROM " + table);
    statement.setReadBigInts(true);
    const rows = statement.all() as Record<string, unknown>[];
    let version = 0;
    if (table === "cookies") {
      try {
        version = Number(
          (
            db.prepare("SELECT value FROM meta WHERE key='version'").get() as
              | { value: unknown }
              | undefined
          )?.value ?? 0,
        );
      } catch {
        /* Old schema. */
      }
    }
    return { columns, rows, version };
  } finally {
    db.close();
  }
}
function number(raw: unknown): number {
  return typeof raw === "bigint" || typeof raw === "number" ? Number(raw) : 0;
}
function sourceRowEligible(
  row: Record<string, unknown>,
  firefox: boolean,
  suppressed: ReadonlySet<string>,
): boolean {
  const domain = String(row[firefox ? "host" : "host_key"] ?? "");
  const name = row.name;
  const path = row.path;
  const expiration = firefox ? number(row.expiry) : number(row.expires_utc) / 1e6 - 11644473600;
  return (
    !!importableDomain(domain) &&
    typeof name === "string" &&
    name.length > 0 &&
    typeof path === "string" &&
    path.startsWith("/") &&
    !isGoogle(domain) &&
    !suppressed.has(registrableFamily(domain) ?? "") &&
    (expiration <= 0 || expiration > Date.now() / 1000)
  );
}
function sourceRowCookie(
  row: Record<string, unknown>,
  firefox: boolean,
  partition: SourceCookie["partition"],
  suppressed: ReadonlySet<string>,
  key: Key | null,
  version: number,
): SourceCookie | null {
  const domain = row[firefox ? "host" : "host_key"];
  if (typeof domain !== "string" || typeof row.name !== "string") return null;
  const value = sourceRowValue(row, domain, firefox, partition, suppressed, key, version);
  if (value === null) return null;
  const session = !firefox && (row.is_persistent === 0 || row.is_persistent === 0n);
  let expiry = 0;
  if (!session) expiry = firefox ? number(row.expiry) : number(row.expires_utc) / 1e6 - 11644473600;
  return {
    domain,
    name: row.name,
    value,
    path: typeof row.path === "string" ? row.path : "/",
    secure: number(row[firefox ? "isSecure" : "is_secure"]) === 1,
    httpOnly: number(row[firefox ? "isHttpOnly" : "is_httponly"]) === 1,
    sameSite: databaseSameSite(row[firefox ? "sameSite" : "samesite"]),
    ...(expiry > 0 ? { expirationDate: expiry } : {}),
    partition,
  };
}
function sourceRowValue(
  row: Record<string, unknown>,
  domain: string,
  firefox: boolean,
  partition: SourceCookie["partition"],
  suppressed: ReadonlySet<string>,
  key: Key | null,
  version: number,
): string | null {
  if (partition.status === "unreadable" || suppressed.has(registrableFamily(domain) ?? ""))
    return "";
  if (firefox) return String(row.value ?? "");
  if (!(row.encrypted_value instanceof Uint8Array) || !row.encrypted_value.length)
    return row.value instanceof Uint8Array
      ? Buffer.from(row.value).toString("latin1")
      : String(row.value ?? "");
  const plain = decryptChromium(Buffer.from(row.encrypted_value), key, domain, version);
  return plain?.toString("latin1") ?? null;
}
export async function readSourceCookies(
  source: DetectedSource,
  path: string,
): Promise<{ cookies: SourceCookie[]; total: number }> {
  if (source.family === "safari") {
    try {
      return decodeSafariBinaryCookiesWithCount(readFileSync(path));
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new SourceError("full_disk_access");
      throw new SourceError("failed");
    }
  }
  const snapshot = snapshotDatabase(path);
  try {
    const table = source.family === "firefox" ? "moz_cookies" : "cookies";
    const { rows, columns, version } = readRows(snapshot.path, table);
    const partitionByRow = new Map(
      rows.map(
        (row) =>
          [
            row,
            source.family === "firefox"
              ? firefoxPartition(row, columns)
              : chromiumPartition(row, columns),
          ] as const,
      ),
    );
    const suppressed = new Set(
      rows.flatMap((row) => {
        const partition = partitionByRow.get(row)!;
        const domain = row[source.family === "firefox" ? "host" : "host_key"];
        const family = typeof domain === "string" ? registrableFamily(domain) : null;
        return partition.status === "unreadable" && family ? [family] : [];
      }),
    );
    const eligible = rows.filter((row) =>
      sourceRowEligible(row, source.family === "firefox", suppressed),
    );
    const encrypted =
      source.family !== "firefox" &&
      eligible.some(
        (row) =>
          row.encrypted_value instanceof Uint8Array &&
          /^(v10|v11)$/.test(Buffer.from(row.encrypted_value).subarray(0, 3).toString()),
      );
    const needsV11 = eligible.some(
      (row) =>
        row.encrypted_value instanceof Uint8Array &&
        Buffer.from(row.encrypted_value).subarray(0, 3).toString() === "v11",
    );
    const key = encrypted ? await keyFor(source, needsV11) : null;
    const cookies: SourceCookie[] = [];
    for (const row of rows) {
      const cookie = sourceRowCookie(
        row,
        source.family === "firefox",
        partitionByRow.get(row)!,
        suppressed,
        key,
        version,
      );
      if (cookie) cookies.push(cookie);
    }
    return { cookies, total: rows.length };
  } finally {
    snapshot.cleanup();
  }
}
const MAC_EPOCH = 978_307_200;
function cstring(buffer: Buffer, offset: number, end: number): string | null {
  if (offset < 0 || offset >= end) return null;
  const nul = buffer.indexOf(0, offset);
  return nul >= 0 && nul < end ? buffer.toString("utf8", offset, nul) : null;
}
export function decodeSafariBinaryCookies(buffer: Buffer): SourceCookie[] {
  return decodeSafariBinaryCookiesWithCount(buffer).cookies;
}
function decodeSafariBinaryCookiesWithCount(buffer: Buffer): {
  cookies: SourceCookie[];
  total: number;
} {
  if (buffer.length < 8 || buffer.toString("utf8", 0, 4) !== "cook")
    return { cookies: [], total: 0 };
  const count = buffer.readUInt32BE(4);
  if (count > Math.floor((buffer.length - 8) / 4)) return { cookies: [], total: 0 };
  const sizes = Array.from({ length: count }, (_, i) => buffer.readUInt32BE(8 + i * 4));
  let cursor = 8 + count * 4;
  const cookies: SourceCookie[] = [];
  let total = 0;
  for (const size of sizes) {
    if (size > buffer.length - cursor) return { cookies: [], total: 0 };
    const page = buffer.subarray(cursor, cursor + size);
    cursor += size;
    const decoded = decodeSafariPage(page);
    total += decoded.total;
    for (const cookie of decoded.cookies) cookies.push(cookie);
  }
  return { cookies, total };
}
function decodeSafariPage(page: Buffer): { cookies: SourceCookie[]; total: number } {
  if (page.length < 16 || page.readUInt32BE(0) !== 0x100) return { cookies: [], total: 0 };
  const count = page.readUInt32LE(4);
  if (count > Math.floor((page.length - 8) / 4)) return { cookies: [], total: 0 };
  const cookies: SourceCookie[] = [];
  for (let i = 0; i < count; i++) {
    const offset = page.readUInt32LE(8 + i * 4);
    if (offset > page.length - 48) continue;
    const cookie = decodeSafariCookie(page.subarray(offset));
    if (cookie) cookies.push(cookie);
  }
  return { cookies, total: count };
}
function decodeSafariCookie(chunk: Buffer): SourceCookie | null {
  const length = chunk.readUInt32LE(0);
  if (length < 48 || length > chunk.length) return null;
  const flags = chunk.readUInt32LE(8);
  const domain = cstring(chunk, chunk.readUInt32LE(16), length);
  const name = cstring(chunk, chunk.readUInt32LE(20), length);
  const path = cstring(chunk, chunk.readUInt32LE(24), length);
  const value = cstring(chunk, chunk.readUInt32LE(28), length);
  const rawExpiration = chunk.readDoubleLE(40);
  const expiration = rawExpiration > 0 ? rawExpiration + MAC_EPOCH : 0;
  if (
    !domain ||
    !name ||
    value === null ||
    !importableDomain(domain) ||
    (expiration > 0 && expiration <= Date.now() / 1000)
  )
    return null;
  return {
    domain,
    name,
    path: path?.startsWith("/") ? path : "/",
    value,
    secure: (flags & 1) !== 0,
    httpOnly: (flags & 4) !== 0,
    sameSite: "unspecified",
    ...(expiration > 0 ? { expirationDate: expiration } : {}),
    partition: { status: "unpartitioned" },
  };
}
