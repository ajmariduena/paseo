import { Platform } from "react-native";
import { getElectronHost } from "@/desktop/electron/host";
import type { BrowserKeyboardPolicy } from "@/desktop/browser/shortcuts";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;

export type DesktopNotificationPermission = "granted" | "denied" | "default";
export type DesktopWindowChromeMode = "native-mac" | "custom-windows" | "custom-linux";

export interface DesktopDialogAskOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  kind?: "info" | "warning" | "error";
}

export interface DesktopDialogOpenOptions {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  createDirectory?: boolean;
  multiple?: boolean;
  filters?: Array<{
    name: string;
    extensions: string[];
  }>;
}

export interface DesktopDialogAskWithCheckboxOptions extends DesktopDialogAskOptions {
  checkboxLabel: string;
  checkboxChecked?: boolean;
}

export interface DesktopDialogAskWithCheckboxResult {
  confirmed: boolean;
  dontAskAgain: boolean;
}

export interface DesktopDialogBridge {
  ask?: (message: string, options?: DesktopDialogAskOptions) => Promise<boolean>;
  askWithCheckbox?: (
    message: string,
    options: DesktopDialogAskWithCheckboxOptions,
  ) => Promise<DesktopDialogAskWithCheckboxResult>;
  open?: (options?: DesktopDialogOpenOptions) => Promise<string | string[] | null>;
}

export interface DesktopNotificationBridge {
  isSupported?: () => Promise<boolean>;
  sendNotification?: (
    payload: string | { title: string; body?: string; data?: Record<string, unknown> },
  ) => Promise<boolean>;
}

export interface DesktopOpenerBridge {
  openUrl?: (url: string) => Promise<void>;
}

export interface DesktopEditorTargetDescriptor {
  id: string;
  label: string;
  kind: "editor" | "file-manager";
  icon: { kind: "image"; dataUrl: string } | { kind: "symbol"; name: "folder" | "terminal" };
}

export interface DesktopEditorOpenTargetInput {
  editorId: string;
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
}

export interface DesktopEditorBridge {
  listTargets?: () => Promise<DesktopEditorTargetDescriptor[]>;
  openTarget?: (input: DesktopEditorOpenTargetInput) => Promise<void>;
}

export interface DesktopWebUtilsBridge {
  getPathForFile?: (file: File) => string;
}

export interface DesktopMenuBridge {
  showContextMenu?: (input?: { kind?: "terminal"; hasSelection?: boolean }) => Promise<void>;
  setCapturingShortcut?: (capturing: boolean) => Promise<void>;
}

export interface DesktopWindowChromeUpdate {
  backgroundColor?: string;
  trafficLightOffsetY?: number;
}

export interface DesktopWindowBridge {
  label?: string;
  minimize?: () => Promise<void>;
  close?: () => Promise<void>;
  toggleMaximize?: () => Promise<void>;
  isMaximized?: () => Promise<boolean>;
  setFullscreen?: (fullscreen: boolean) => Promise<void>;
  isFullscreen?: () => Promise<boolean>;
  updateChrome?: (update: DesktopWindowChromeUpdate) => Promise<void>;
  onResized?: <TEvent = unknown>(
    handler: (event: TEvent) => void,
  ) => Promise<() => void> | (() => void);
  setBadgeCount?: (count?: number) => Promise<void>;
  onDragDropEvent?: <TEvent = unknown>(
    handler: (event: TEvent) => void,
  ) => Promise<() => void> | (() => void);
}

export interface DesktopWindowModuleBridge {
  openNew?: (options?: { pendingOpenProjectPath?: string | null }) => Promise<void>;
  getCurrentWindow?: () => DesktopWindowBridge;
}

export interface DesktopEventsBridge {
  on?: (event: string, handler: (payload: unknown) => void) => Promise<() => void> | (() => void);
}

export interface DesktopAgentNavigationBridge {
  ready?: () => Promise<{ serverId: string; agentId: string } | null>;
}

export type DesktopBrowserShortcutEvent =
  | { browserId?: string; action: "focus-url" }
  | { browserId: string; action: "new-tab" };

export interface DesktopBrowserNewTabRequestEvent {
  sourceBrowserId: string;
  url: string;
  background?: boolean;
}

export interface DesktopAttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

export type BrowserCookieImportFamily =
  | "chrome"
  | "edge"
  | "arc"
  | "brave"
  | "comet"
  | "helium"
  | "chromium"
  | "firefox"
  | "safari";
export interface BrowserCookieImportSource {
  family: BrowserCookieImportFamily;
  label: string;
  profiles: Array<{ id: string; label: string }>;
  requiresFullDiskAccess?: boolean;
}
export type BrowserCookieImportRequest =
  | { kind: "browser"; family: BrowserCookieImportFamily; profileId?: string }
  | { kind: "file" };
export type BrowserCookieImportErrorCode =
  | "keychain_denied"
  | "full_disk_access"
  | "source_busy"
  | "source_not_found"
  | "invalid_file"
  | "no_cookies"
  | "unsupported_platform"
  | "failed";
export type BrowserCookieImportResult =
  | {
      status: "imported";
      sourceLabel: string;
      profileLabel?: string;
      imported: number;
      skipped: number;
      googleSkipped: number;
      partitionSkipped: number;
      failed: number;
      importedAt: string;
    }
  | { status: "canceled" }
  | { status: "error"; code: BrowserCookieImportErrorCode; message?: string };
export interface BrowserCookieImportReceipt {
  sourceLabel: string;
  profileLabel?: string;
  importedAt: string;
  imported: number;
  skipped: number;
}

export interface DesktopBrowserBridge {
  setShortcutPolicy?: (input: BrowserKeyboardPolicy) => Promise<void>;
  readonly profilePartition?: string;
  registerAttachedBrowser?: (input: DesktopAttachedBrowserRegistration) => Promise<void>;
  unregisterWorkspaceBrowser?: (browserId: string) => Promise<void>;
  setWorkspaceActiveBrowser?: (input: {
    workspaceId: string;
    browserId: string | null;
  }) => Promise<void>;
  focus?: (browserId: string) => Promise<boolean>;
  openDevTools?: (browserId: string) => Promise<unknown>;
  clearProfile?: (legacyBrowserIds: string[]) => Promise<void>;
  detectCookieImportSources?: () => Promise<BrowserCookieImportSource[]>;
  importCookies?: (request: BrowserCookieImportRequest) => Promise<BrowserCookieImportResult>;
  getCookieImportReceipt?: () => Promise<BrowserCookieImportReceipt | null>;
  reloadBrowserGuests?: () => Promise<void>;
  executeAutomationCommand?: (
    request: BrowserAutomationExecuteRequest,
  ) => Promise<BrowserAutomationExecuteResponse["payload"]>;
  /** Capture a PNG screenshot of the guest viewport cropped to `rect`. */
  captureElement?: (
    browserId: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => Promise<string | null>;
  /** Copy element text and/or an image to the system clipboard from main. */
  copyElement?: (payload: { text?: string; imageDataUrl?: string }) => Promise<boolean>;
}

export interface DesktopInvokeBridge {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export interface DesktopHostBridge {
  platform?: string;
  windowChromeMode?: string;
  invoke?: DesktopInvokeBridge["invoke"];
  getPendingOpenProject?: () => Promise<string | null>;
  agentNavigation?: DesktopAgentNavigationBridge;
  events?: DesktopEventsBridge;
  window?: DesktopWindowModuleBridge;
  dialog?: DesktopDialogBridge;
  notification?: DesktopNotificationBridge;
  opener?: DesktopOpenerBridge;
  editor?: DesktopEditorBridge;
  webUtils?: DesktopWebUtilsBridge;
  menu?: DesktopMenuBridge;
  browser?: DesktopBrowserBridge;
}

declare global {
  interface Window {
    paseoDesktop?: DesktopHostBridge;
  }
}

export function getDesktopHost(): DesktopHostBridge | null {
  if (Platform.OS !== "web") {
    return null;
  }
  return getElectronHost();
}

export function isElectronRuntime(): boolean {
  return getDesktopHost() !== null;
}

export function isElectronRuntimeMac(): boolean {
  if (!isElectronRuntime()) {
    return false;
  }
  if (typeof navigator === "undefined") {
    return false;
  }
  const hostPlatform = getDesktopHost()?.platform?.toLowerCase();
  if (hostPlatform === "darwin" || hostPlatform === "mac" || hostPlatform === "macos") {
    return true;
  }
  const ua = navigator.userAgent;
  return ua.includes("Mac OS") || ua.includes("Macintosh");
}

export function getDesktopWindowChromeMode(): DesktopWindowChromeMode | null {
  const host = getDesktopHost();
  if (!host) return null;
  const mode = host.windowChromeMode;
  if (mode === "native-mac" || mode === "custom-windows" || mode === "custom-linux") {
    return mode;
  }
  // COMPAT(windowChromeMode): added in v0.5.3; remove after 2026-11-25.
  if (isElectronRuntimeMac()) return "native-mac";
  if (host.platform?.toLowerCase() === "linux") return "custom-linux";
  return "custom-windows";
}
