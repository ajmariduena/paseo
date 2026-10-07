import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  extractHeadlessShell,
  headlessShellPlatform,
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
