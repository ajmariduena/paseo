import { chmod, lstat, mkdir, mkdtemp, open, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  extractHeadlessShell,
  ensureHeadlessShell,
  headlessShellPlatform,
  headlessShellStatus,
  HEADLESS_SHELL_VERSION,
} from "./browser-install.js";

function singleFileZip(name: string, bytes: Buffer, mode = 0o100755): Buffer {
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((mode * 65536) >>> 0, 38);
  const offset = local.length + nameBytes.length + bytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, nameBytes, bytes, central, nameBytes, end]);
}

test("pins a supported shell platform and rejects unsupported hosts", () => {
  expect(HEADLESS_SHELL_VERSION).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  expect(headlessShellPlatform("darwin", "arm64")).toBe("mac-arm64");
  expect(headlessShellPlatform("darwin", "x64")).toBe("mac-x64");
  expect(headlessShellPlatform("linux", "arm64")).toBe("linux-arm64");
  expect(headlessShellPlatform("linux", "x64")).toBe("linux64");
  expect(headlessShellPlatform("win32", "x64")).toBe("win64");
  expect(headlessShellPlatform("win32", "arm64")).toBeNull();
});

test("rejects a damaged executable and reports another daemon's install", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-browser-status-"));
  const platform = headlessShellPlatform();
  if (!platform) return;
  const root = path.join(home, "tools", "chrome-headless-shell", platform);
  try {
    const release = path.join(root, HEADLESS_SHELL_VERSION);
    await mkdir(release, { recursive: true });
    const executable = path.join(
      release,
      platform === "win64" ? "chrome-headless-shell.exe" : "chrome-headless-shell",
    );
    await writeFile(executable, "bad binary");
    await chmod(executable, 0o755);
    expect((await headlessShellStatus(home)).state).toBe("missing");
    const lock = path.join(root, ".install-lock");
    await mkdir(lock);
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "foreign" }),
    );
    const old = new Date(Date.now() - 21 * 60_000);
    await utimes(lock, old, old);
    expect((await headlessShellStatus(home)).state).toBe("installing");
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: 999999999, token: "abandoned" }),
    );
    expect((await headlessShellStatus(home)).state).toBe("failed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const pinnedArchive = process.env.PASEO_TEST_HEADLESS_SHELL_ARCHIVE;
test.skipIf(!pinnedArchive)(
  "does not steal an aged lock from a live installer",
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-browser-lock-"));
    const platform = headlessShellPlatform()!;
    const lock = path.join(home, "tools", "chrome-headless-shell", platform, ".install-lock");
    try {
      await mkdir(lock, { recursive: true });
      await writeFile(
        path.join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, token: "foreign" }),
      );
      const old = new Date(Date.now() - 21 * 60_000);
      await utimes(lock, old, old);
      expect(await ensureHeadlessShell(home, 50, pinnedArchive)).toBeNull();
      expect((await lstat(lock)).mtimeMs).toBeLessThan(Date.now() - 20 * 60_000);
      await rm(lock, { recursive: true });
      expect(await ensureHeadlessShell(home, -1, pinnedArchive)).toContain(HEADLESS_SHELL_VERSION);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);

test.skipIf(!pinnedArchive)(
  "repairs a damaged install and sweeps abandoned staging under the lock",
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-browser-repair-"));
    const platform = headlessShellPlatform()!;
    const root = path.join(home, "tools", "chrome-headless-shell", platform);
    try {
      const executable = await ensureHeadlessShell(home, -1, pinnedArchive);
      expect(executable).toContain(HEADLESS_SHELL_VERSION);
      expect((await headlessShellStatus(home)).state).toBe("installed");
      await writeFile(path.join(root, HEADLESS_SHELL_VERSION, "icudtl.dat"), "damaged resource");
      expect((await headlessShellStatus(home)).state).toBe("missing");
      await ensureHeadlessShell(home, -1, pinnedArchive);
      expect((await headlessShellStatus(home)).state).toBe("installed");
      await writeFile(executable!, "bad binary");
      await chmod(executable!, 0o755);
      expect((await headlessShellStatus(home)).state).toBe("missing");
      await mkdir(path.join(root, ".install-leftover"));
      const lock = path.join(root, ".install-lock");
      await mkdir(lock);
      await writeFile(
        path.join(lock, "owner.json"),
        JSON.stringify({ pid: 999999999, token: "abandoned" }),
      );
      expect((await headlessShellStatus(home)).state).toBe("failed");
      const repaired = await ensureHeadlessShell(home, -1, pinnedArchive);
      expect(repaired).toBe(executable);
      expect((await headlessShellStatus(home)).state).toBe("installed");
      const handle = await open(repaired!, "r");
      try {
        const prefix = Buffer.alloc(10);
        await handle.read(prefix, 0, 10, 0);
        expect(prefix.toString()).not.toBe("bad binary");
      } finally {
        await handle.close();
      }
      await expect(lstat(path.join(root, ".install-leftover"))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);

test("safe extractor rejects traversal and ZIP symlink entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-browser-zip-test-"));
  try {
    const archive = path.join(root, "browser.zip");
    await writeFile(
      archive,
      singleFileZip("chrome-headless-shell-mac-arm64/../escape", Buffer.from("bad")),
    );
    await expect(
      extractHeadlessShell(archive, "mac-arm64", path.join(root, "out")),
    ).rejects.toThrow(/unsafe/);
    await writeFile(
      archive,
      singleFileZip(
        "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        Buffer.from("bad"),
        0o120777,
      ),
    );
    await expect(
      extractHeadlessShell(archive, "mac-arm64", path.join(root, "out")),
    ).rejects.toThrow(/unsafe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
