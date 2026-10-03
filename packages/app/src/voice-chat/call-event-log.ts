import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";

const FLUSH_INTERVAL_MS = 5_000;
const MAX_BUFFERED = 200;

interface CallEvent {
  at: string;
  kind: string;
  detail?: Record<string, unknown>;
}

let serverId: string | null = null;
let buffer: CallEvent[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

async function flush(): Promise<void> {
  if (flushing || !serverId || buffer.length === 0) return;
  const store = getHostRuntimeStore();
  const client = store.getClient(serverId);
  if (!client || !isHostRuntimeConnected(store.getSnapshot(serverId))) return;
  flushing = true;
  const batch = buffer.slice(0, 50);
  try {
    await client.logVoiceCallEvents(batch);
    buffer = buffer.slice(batch.length);
  } catch {
    // Kept for the next flush; the log exists to explain disconnects.
  } finally {
    flushing = false;
  }
}

/**
 * Records the phone's side of a voice call (network, app state, reconnects, mode changes)
 * and ships it to the host's daemon log once connected, so a dropped call can be explained.
 */
export function logVoiceCallEvent(kind: string, detail?: Record<string, unknown>): void {
  buffer.push({ at: new Date().toISOString(), kind, ...(detail ? { detail } : {}) });
  if (buffer.length > MAX_BUFFERED) buffer = buffer.slice(-MAX_BUFFERED);
}

export function startVoiceCallEventLog(nextServerId: string): void {
  serverId = nextServerId;
  timer ??= setInterval(() => void flush(), FLUSH_INTERVAL_MS);
}

export function stopVoiceCallEventLog(): void {
  void flush().finally(() => {
    if (timer) clearInterval(timer);
    timer = null;
    serverId = null;
  });
}
