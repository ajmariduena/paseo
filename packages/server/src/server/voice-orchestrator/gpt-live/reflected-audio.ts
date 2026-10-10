// A real microphone never captures exact digital silence; WebRTC sends zeros until the phone's
// audio unit runs, and speech played before then is lost.
const LIVE_MIC_MIN_PEAK = 2;
const INPUT_WINDOW_MS = 3_000;

interface Sample {
  at: number;
  level: number;
}

export function meanAmplitude(pcm16: Buffer): number {
  const samples = Math.floor(pcm16.length / 2);
  if (samples === 0) return 0;
  let total = 0;
  for (let index = 0; index < samples; index += 1) total += Math.abs(pcm16.readInt16LE(index * 2));
  return total / samples;
}

function peakAmplitude(pcm16: Buffer): number {
  let peak = 0;
  for (let index = 0; index + 1 < pcm16.length; index += 2) {
    peak = Math.max(peak, Math.abs(pcm16.readInt16LE(index)));
  }
  return peak;
}

/** What the sideband's copy of the phone's microphone says about the call. */
export class ReflectedInput {
  private firstFrameAt: number | null = null;
  private liveAt: number | null = null;
  private recent: Sample[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns true for the first frame that carries real microphone signal. */
  note(pcm16: Buffer): boolean {
    const at = this.now();
    this.firstFrameAt ??= at;
    this.recent.push({ at, level: meanAmplitude(pcm16) });
    while (this.recent.length > 0 && at - this.recent[0].at > INPUT_WINDOW_MS) this.recent.shift();
    if (this.liveAt !== null || peakAmplitude(pcm16) < LIVE_MIC_MIN_PEAK) return false;
    this.liveAt = at;
    return true;
  }

  get isLive(): boolean {
    return this.liveAt !== null;
  }

  /** Milliseconds between the first frame and the first live one. */
  get silentLeadMs(): number | null {
    return this.firstFrameAt !== null && this.liveAt !== null
      ? this.liveAt - this.firstFrameAt
      : null;
  }

  /** The loudest input over the last `windowMs`, as mean PCM16 amplitude per frame. */
  peak(windowMs: number): number {
    const since = this.now() - windowMs;
    return Math.round(
      this.recent.reduce(
        (max, sample) => (sample.at >= since ? Math.max(max, sample.level) : max),
        0,
      ),
    );
  }
}
