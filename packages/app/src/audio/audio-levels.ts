const WINDOW_MS = 40;
// Reports stop when capture stops or is muted; a level older than this is silence.
const STALE_MS = 300;
const FLOOR_DB = -55;
const RANGE_DB = 45;

export interface AudioLevels {
  /** The microphone, 0–1. */
  user: number;
  /** What the assistant is saying right now, 0–1. */
  assistant: number;
}

interface Segment {
  startsAt: number;
  endsAt: number;
  level: number;
}

let capture = { level: 0, at: 0 };
let remote = { level: 0, at: 0 };
let playback: Segment[] = [];

/** Maps a linear amplitude (RMS or WebRTC `audioLevel`) onto a perceptual 0–1 scale. */
export function levelFromAmplitude(amplitude: number): number {
  if (!(amplitude > 0)) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / RANGE_DB));
}

function pcm16Rms(pcm: Uint8Array, from: number, to: number): number {
  const count = to - from;
  if (count <= 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  for (let index = from; index < to; index += 1) {
    const value = view.getInt16(index * 2, true) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / count);
}

export function reportCapturedPcm16(pcm: Uint8Array, now = Date.now()): void {
  capture = {
    level: levelFromAmplitude(pcm16Rms(pcm, 0, Math.floor(pcm.byteLength / 2))),
    at: now,
  };
}

/** Levels measured by a transport that plays and captures audio itself (WebRTC). */
export function reportTransportLevels(levels: AudioLevels, now = Date.now()): void {
  capture = { level: levels.user, at: now };
  remote = { level: levels.assistant, at: now };
}

/**
 * Records the loudness of PCM handed to the native player, keyed to when it will actually be
 * heard: the player queues ahead, so the level at hand-off time would run early.
 */
export function schedulePlaybackPcm16(pcm: Uint8Array, sampleRate: number, startsAt: number): void {
  const samples = Math.floor(pcm.byteLength / 2);
  const perWindow = Math.max(1, Math.round((sampleRate * WINDOW_MS) / 1000));
  for (let from = 0; from < samples; from += perWindow) {
    const to = Math.min(samples, from + perWindow);
    const offsetMs = (from / sampleRate) * 1000;
    playback.push({
      startsAt: startsAt + offsetMs,
      endsAt: startsAt + (to / sampleRate) * 1000,
      level: levelFromAmplitude(pcm16Rms(pcm, from, to)),
    });
  }
}

export function clearPlaybackLevels(): void {
  playback = [];
}

export function readAudioLevels(now = Date.now()): AudioLevels {
  while (playback.length > 0 && playback[0].endsAt <= now) playback.shift();
  const playing = playback.length > 0 && playback[0].startsAt <= now ? playback[0].level : 0;
  const fresh = (sample: { level: number; at: number }) =>
    now - sample.at <= STALE_MS ? sample.level : 0;
  return { user: fresh(capture), assistant: Math.max(playing, fresh(remote)) };
}

export function resetAudioLevels(): void {
  capture = { level: 0, at: 0 };
  remote = { level: 0, at: 0 };
  playback = [];
}
