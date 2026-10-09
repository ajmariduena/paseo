import { AppState } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { VoiceFleetDigest, VoiceToolResult } from "@getpaseo/protocol/voice-fleet/types";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { normalizeHostLabel } from "@/types/host-connection";
import { logVoiceCallEvent } from "@/voice-chat/call-event-log";
import {
  buildFleetHostStates,
  createFleetSyncLoop,
  createOperationDedupe,
  rememberFleetHosts,
  selectDigestHosts,
  type FleetHost,
  type RememberedFleetHost,
} from "@/voice-chat/fleet-courier-state";

// The host running the call treats the phone's view as stale after 20 s of silence.
const SYNC_INTERVAL_MS = 5_000;
const CHANGE_SYNC_DELAY_MS = 1_000;
const DIGEST_TIMEOUT_MS = 3_000;
const REMEMBERED_OPERATIONS = 200;
const CALL_START_GRACE_MS = 30_000;

type CourierRequest = Extract<SessionOutboundMessage, { type: "voice.courier.execute" }>["payload"];

interface CourierOutcome {
  result: VoiceToolResult | null;
  error: string | null;
}

function supportsVoiceFleet(serverId: string): boolean {
  const serverInfo = useSessionStore.getState().getSession(serverId)?.serverInfo;
  return serverInfo?.features?.voiceFleet === true;
}

function isConnected(serverId: string): boolean {
  return isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(serverId));
}

function hostLabel(serverId: string): string {
  const host = getHostRuntimeStore()
    .getHosts()
    .find((entry) => entry.serverId === serverId);
  return normalizeHostLabel(host?.label, serverId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readFleetHosts(directorServerId: string): FleetHost[] {
  return getHostRuntimeStore()
    .getHosts()
    .filter((host) => host.serverId !== directorServerId)
    .map((host) => ({
      serverId: host.serverId,
      label: normalizeHostLabel(host.label, host.serverId),
      isConnected: isConnected(host.serverId),
      supportsFleet: supportsVoiceFleet(host.serverId),
    }));
}

function didFleetFactsChange(before: SessionState | undefined, after: SessionState): boolean {
  if (!before) return true;
  const agentsChanged = before.agents !== after.agents;
  const permissionsChanged = before.pendingPermissions !== after.pendingPermissions;
  const workspacesChanged = before.workspaces !== after.workspaces;
  return agentsChanged || permissionsChanged || workspacesChanged;
}

function watchOtherHosts(directorServerId: string, onChange: () => void): () => void {
  return useSessionStore.subscribe(
    (state) => state.sessions,
    (sessions, previous) => {
      for (const [serverId, session] of Object.entries(sessions)) {
        if (serverId === directorServerId) continue;
        if (didFleetFactsChange(previous[serverId], session)) {
          onChange();
          return;
        }
      }
    },
  );
}

/** Follows the director's client across reconnects, which can swap the client object. */
function subscribeCourierRequests(
  directorServerId: string,
  onRequest: (request: CourierRequest) => void,
): () => void {
  const store = getHostRuntimeStore();
  let client: DaemonClient | null = null;
  let unsubscribe: (() => void) | null = null;
  function attach(): void {
    const next = store.getClient(directorServerId);
    if (next === client) return;
    unsubscribe?.();
    client = next;
    unsubscribe =
      next?.on("voice.courier.execute", (message) => onRequest(message.payload)) ?? null;
  }
  attach();
  const unsubscribeStore = store.subscribe(directorServerId, attach);
  return () => {
    unsubscribeStore();
    unsubscribe?.();
  };
}

async function invokeOnHost(request: CourierRequest, language: string): Promise<CourierOutcome> {
  const client = getHostRuntimeStore().getClient(request.serverId);
  if (!client || !isConnected(request.serverId)) {
    return { result: null, error: `${hostLabel(request.serverId)} is not connected to the phone` };
  }
  try {
    return await client.invokeVoiceTool({
      operationId: request.operationId,
      tool: request.tool,
      args: request.args,
      language: request.language ?? language,
    });
  } catch (error) {
    return { result: null, error: errorMessage(error) };
  }
}

async function runCourierRequest(input: {
  request: CourierRequest;
  directorServerId: string;
  language: string;
}): Promise<void> {
  const { request } = input;
  const startedAt = Date.now();
  const outcome = await invokeOnHost(request, input.language);
  logVoiceCallEvent("courier_run", {
    tool: request.tool,
    ms: Date.now() - startedAt,
    ok: outcome.result?.ok === true,
    ...(outcome.error ? { error: outcome.error } : {}),
  });
  const director = getHostRuntimeStore().getClient(input.directorServerId);
  if (!director) {
    logVoiceCallEvent("courier_result_failed", { tool: request.tool, error: "disconnected" });
    return;
  }
  try {
    await director.sendVoiceCourierResult({ operationId: request.operationId, ...outcome });
  } catch (error) {
    logVoiceCallEvent("courier_result_failed", { tool: request.tool, error: errorMessage(error) });
  }
}

async function fetchDigests(input: {
  hosts: FleetHost[];
  language: string;
  failingHosts: Set<string>;
}): Promise<Map<string, VoiceFleetDigest>> {
  const digests = new Map<string, VoiceFleetDigest>();
  await Promise.all(
    input.hosts.map(async (host) => {
      const client = getHostRuntimeStore().getClient(host.serverId);
      if (!client) return;
      try {
        const digest = await client.getVoiceFleetDigest({
          language: input.language,
          timeoutMs: DIGEST_TIMEOUT_MS,
        });
        if (digest) digests.set(host.serverId, digest);
        input.failingHosts.delete(host.serverId);
      } catch (error) {
        if (input.failingHosts.has(host.serverId)) return;
        input.failingHosts.add(host.serverId);
        logVoiceCallEvent("fleet_digest_failed", {
          serverId: host.serverId,
          error: errorMessage(error),
        });
      }
    }),
  );
  return digests;
}

/**
 * Makes the phone the link between the host running a global voice call and the user's other
 * hosts: it reports their agents to the call every few seconds (which also proves the phone is
 * alive) and carries the call's actions to them. Returns the function that stops it.
 */
export function startFleetCourier(input: { serverId: string; language: string }): () => void {
  const directorServerId = input.serverId;
  if (!supportsVoiceFleet(directorServerId)) return () => undefined;

  let remembered = new Map<string, RememberedFleetHost>();
  const failingHosts = new Set<string>();
  let failedSyncs = 0;
  let isStopped = false;
  let everActive = false;
  const startedAt = Date.now();

  async function sync(): Promise<void> {
    const hosts = readFleetHosts(directorServerId);
    const digests = await fetchDigests({
      hosts: selectDigestHosts(hosts),
      language: input.language,
      failingHosts,
    });
    remembered = rememberFleetHosts({
      previous: remembered,
      hosts,
      digests,
      now: new Date().toISOString(),
    });
    const director = getHostRuntimeStore().getClient(directorServerId);
    if (isStopped || !director || !isConnected(directorServerId)) return;
    try {
      const { active } = await director.syncVoiceFleet({
        hosts: buildFleetHostStates({ hosts, remembered }),
        selfLabel: hostLabel(directorServerId),
        appState: AppState.currentState,
      });
      if (failedSyncs > 0) logVoiceCallEvent("fleet_sync_recovered", { failures: failedSyncs });
      failedSyncs = 0;
      if (active) {
        everActive = true;
      } else if (everActive || Date.now() - startedAt > CALL_START_GRACE_MS) {
        // Before the call connects the host may not have it yet; after that, inactive means over.
        logVoiceCallEvent("fleet_sync_inactive");
        stop();
      }
    } catch (error) {
      failedSyncs += 1;
      if (failedSyncs === 1) logVoiceCallEvent("fleet_sync_failed", { error: errorMessage(error) });
    }
  }

  const loop = createFleetSyncLoop({
    run: sync,
    intervalMs: SYNC_INTERVAL_MS,
    soonMs: CHANGE_SYNC_DELAY_MS,
  });
  const dedupe = createOperationDedupe(REMEMBERED_OPERATIONS);
  const stopCourier = subscribeCourierRequests(directorServerId, (request) => {
    if (isStopped || !dedupe.claim(request.operationId)) return;
    void runCourierRequest({ request, directorServerId, language: input.language });
  });
  const stopWatching = watchOtherHosts(directorServerId, () => loop.requestSoon());

  function stop(): void {
    if (isStopped) return;
    isStopped = true;
    loop.stop();
    stopCourier();
    stopWatching();
  }

  logVoiceCallEvent("fleet_courier_started", { hosts: readFleetHosts(directorServerId).length });
  loop.start();
  return stop;
}
