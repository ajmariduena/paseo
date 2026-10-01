import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeSafariBinaryCookies,
  decryptChromium,
  readSourceCookies,
  snapshotDatabase,
} from "./sources.js";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-cookie-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("native cookie sources", () => {
  it("decrypts Chromium CBC values with the host hash prefix", () => {
    const password = "test-secret";
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const host = ".example.com";
    const plain = Buffer.concat([
      createHash("sha256").update(host).digest(),
      Buffer.from("session-value"),
    ]);
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
    expect(
      decryptChromium(encrypted, { mode: "cbc", versions: { v10: key } }, host, 24)?.toString(),
    ).toBe("session-value");
    expect(decryptChromium(encrypted, null, host, 24)).toBeNull();
  });
  it("reads a committed WAL-only Chromium row from a private snapshot", async () => {
    const dir = temp(),
      path = join(dir, "Cookies");
    const db = new DatabaseSync(path);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,expires_utc INTEGER,top_frame_site_key TEXT,has_cross_site_ancestor INTEGER);",
    );
    db.prepare("INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      ".example.com",
      "session",
      Buffer.from("wal-value"),
      Buffer.alloc(0),
      "/",
      1,
      0,
      1,
      0,
      "",
      0,
    );
    const before = readFileSync(path);
    const source = {
      family: "chrome" as const,
      label: "Google Chrome",
      profiles: [{ id: "Default", label: "Default", path }],
    };
    const result = await readSourceCookies(source, path);
    expect(result.total).toBe(1);
    expect(result.cookies).toEqual([
      {
        domain: ".example.com",
        name: "session",
        value: "wal-value",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "lax",
        partition: { status: "unpartitioned" },
      },
    ]);
    expect(readFileSync(path)).toEqual(before);
    db.close();
  });
  it("retries a changed snapshot and cleans a failed partial copy", () => {
    const dir = temp(),
      root = temp(),
      path = join(dir, "Cookies");
    writeFileSync(path, "first");
    let copies = 0;
    const snapshot = snapshotDatabase(path, {
      tempRoot: root,
      copy: (from, to) => {
        copyFileSync(from, to);
        if (++copies === 1) writeFileSync(path, "second-longer");
      },
    });
    expect(copies).toBe(2);
    expect(readFileSync(snapshot.path, "utf8")).toBe("second-longer");
    snapshot.cleanup();
    expect(readdirSync(root)).toEqual([]);
    expect(() =>
      snapshotDatabase(path, {
        tempRoot: root,
        copy: (_from, to) => {
          writeFileSync(to, "partial");
          throw new Error("busy");
        },
      }),
    ).toThrow("source_busy");
    expect(readdirSync(root)).toEqual([]);
  });
  it("bounds-checks Safari pages and converts the 2001 expiry epoch", () => {
    const strings = Buffer.from("example.com\0sid\0/\0value\0");
    const entry = Buffer.alloc(48 + strings.length);
    entry.writeUInt32LE(entry.length, 0);
    entry.writeUInt32LE(1, 8);
    entry.writeUInt32LE(48, 16);
    entry.writeUInt32LE(60, 20);
    entry.writeUInt32LE(64, 24);
    entry.writeUInt32LE(66, 28);
    entry.writeDoubleLE(Date.now() / 1000 + 3600 - 978_307_200, 40);
    strings.copy(entry, 48);
    const page = Buffer.alloc(16 + entry.length);
    page.writeUInt32BE(0x100, 0);
    page.writeUInt32LE(1, 4);
    page.writeUInt32LE(16, 8);
    entry.copy(page, 16);
    const file = Buffer.alloc(12 + page.length);
    file.write("cook", 0);
    file.writeUInt32BE(1, 4);
    file.writeUInt32BE(page.length, 8);
    page.copy(file, 12);
    const decoded = decodeSafariBinaryCookies(file);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({
      domain: "example.com",
      name: "sid",
      value: "value",
      secure: true,
    });
    expect(decoded[0].expirationDate).toBeGreaterThan(Date.now() / 1000);
    expect(decodeSafariBinaryCookies(file.subarray(0, 15))).toEqual([]);
  });
});
