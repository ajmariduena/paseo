import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNodeExecPath } from "./runtime-paths";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn((): string[] => []),
  app: {
    isPackaged: true,
  },
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readdirSync: mocks.readdirSync,
  readFileSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: mocks.app,
}));

vi.mock("electron-log/main", () => ({
  default: { warn: vi.fn() },
}));

const originalPlatform = process.platform;
const originalExecPath = process.execPath;
const originalResourcesPath = process.resourcesPath;

function setProcessRuntime(input: {
  platform: NodeJS.Platform;
  execPath: string;
  resourcesPath?: string;
}): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: input.platform,
  });
  Object.defineProperty(process, "execPath", {
    configurable: true,
    value: input.execPath,
  });
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: input.resourcesPath,
  });
}

describe("runtime-paths", () => {
  beforeEach(() => {
    mocks.app.isPackaged = true;
    mocks.existsSync.mockReturnValue(true);
    setProcessRuntime({
      platform: "darwin",
      execPath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
      resourcesPath: "/Applications/Paseo.app/Contents/Resources",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setProcessRuntime({
      platform: originalPlatform,
      execPath: originalExecPath,
      resourcesPath: originalResourcesPath,
    });
  });

  it("uses the macOS Helper executable for packaged daemon node launches", () => {
    expect(resolveNodeExecPath()).toBe(
      "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
    );
  });

  it("finds a helper named after the bundle when productName differs from the executable", () => {
    const helper =
      "/Applications/Paseo Canary.app/Contents/Frameworks/Paseo Canary Helper.app/Contents/MacOS/Paseo Canary Helper";
    mocks.existsSync.mockImplementation((candidate: string) => candidate === helper);
    setProcessRuntime({
      platform: "darwin",
      execPath: "/Applications/Paseo Canary.app/Contents/MacOS/Paseo",
      resourcesPath: "/Applications/Paseo Canary.app/Contents/Resources",
    });

    expect(resolveNodeExecPath()).toBe(helper);
  });

  it("finds the product helper in a renamed copy of the bundle", () => {
    const helper =
      "/Applications/Paseo Canary Runtime.app/Contents/Frameworks/Paseo Canary Helper.app/Contents/MacOS/Paseo Canary Helper";
    mocks.readdirSync.mockReturnValue([
      "Electron Framework.framework",
      "Paseo Canary Helper (GPU).app",
      "Paseo Canary Helper.app",
    ]);
    mocks.existsSync.mockImplementation((candidate: string) => candidate === helper);
    setProcessRuntime({
      platform: "darwin",
      execPath: "/Applications/Paseo Canary Runtime.app/Contents/MacOS/Paseo",
      resourcesPath: "/Applications/Paseo Canary Runtime.app/Contents/Resources",
    });

    expect(resolveNodeExecPath()).toBe(helper);
  });
});
