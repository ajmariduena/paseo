import { isEchoOfAssistant } from "./speech-floor.js";

interface Fragment {
  role: "user" | "assistant";
  text: string;
  at: number;
}

// A pause this long inside the user's speech starts a new group for the echo check.
const GROUP_GAP_MS = 900;
// Assistant speech shorter than this between user fragments is a backchannel, not a reply.
const REPLY_MIN_WORDS = 4;
const MAX_FRAGMENTS = 400;

/**
 * Works out what the user asked when GPT-Live delegates. The delegation carries no text, so
 * the request is the user's speech since the assistant last replied, kept whole: fragments
 * the barge-in filter held back while the assistant was audible still count once GPT-Live
 * acted on them. Echoes of the assistant's own voice are dropped.
 */
export class RequestTracker {
  private fragments: Fragment[] = [];
  private consumedThrough = 0;
  private recentAssistant = "";

  /**
   * `filterEcho` only where the host relays the audio: over WebRTC the phone cancels echo,
   * and the filter would drop a real "sí" right after the assistant said "di sí".
   */
  constructor(private readonly options: { filterEcho: boolean }) {}

  noteUser(text: string, at: number): void {
    if (!text) return;
    this.push({ role: "user", text, at });
  }

  noteAssistant(text: string, at: number): void {
    if (!text) return;
    this.recentAssistant = `${this.recentAssistant}${text}`.slice(-600);
    this.push({ role: "assistant", text, at });
  }

  /** The request as it stands, without consuming it (for speculative planning). */
  peek(): string {
    return this.render(this.currentRun());
  }

  /** The request for a delegation; the next one starts after it. */
  take(): string {
    const run = this.currentRun();
    this.consumedThrough = this.fragments.length;
    return this.render(run);
  }

  private push(fragment: Fragment): void {
    this.fragments.push(fragment);
    if (this.fragments.length > MAX_FRAGMENTS) {
      const drop = this.fragments.length - MAX_FRAGMENTS;
      this.fragments.splice(0, drop);
      this.consumedThrough = Math.max(0, this.consumedThrough - drop);
    }
  }

  /** User fragments after the last real assistant reply that came between them. */
  private currentRun(): Fragment[] {
    const run: Fragment[] = [];
    // Deltas split words ("De a", "cuer", "do."), so words are counted on the joined text.
    let assistantText = "";
    for (let index = this.fragments.length - 1; index >= this.consumedThrough; index -= 1) {
      const fragment = this.fragments[index];
      if (fragment.role === "assistant") {
        if (run.length === 0) continue;
        assistantText = `${fragment.text}${assistantText}`;
        if (countWords(assistantText) >= REPLY_MIN_WORDS) break;
        continue;
      }
      assistantText = "";
      run.unshift(fragment);
    }
    return run;
  }

  private render(run: Fragment[]): string {
    const groups: string[] = [];
    let current = "";
    let lastAt = Number.NEGATIVE_INFINITY;
    for (const fragment of run) {
      if (current && fragment.at - lastAt > GROUP_GAP_MS) {
        groups.push(current);
        current = "";
      }
      current += fragment.text;
      lastAt = fragment.at;
    }
    if (current) groups.push(current);
    return groups
      .filter(
        (group) =>
          group.trim().length > 0 &&
          !(this.options.filterEcho && isEchoOfAssistant(group.trim(), this.recentAssistant)),
      )
      .map((group) => group.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
