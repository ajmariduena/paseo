import { describe, expect, it } from "vitest";
import type { VoiceCommandsSettings } from "@getpaseo/protocol/voice-commands/rpc-schemas";
import {
  formatRoundTripSeconds,
  getFooter,
  getKeyRows,
  getLatencyTone,
  getModelLabels,
  getRoundTripBadge,
  getTestTarget,
  groupOptions,
} from "./catalog";

const fast = { provider: "fast", model: "fast-small" };
const steady = { provider: "steady", model: "steady-mini" };

function settings(patch: Partial<VoiceCommandsSettings> = {}): VoiceCommandsSettings {
  return {
    selection: fast,
    backup: steady,
    active: fast,
    lastRoundTripMs: null,
    providers: [
      { id: "fast", label: "Fast Cloud", hasKey: true },
      { id: "steady", label: "Steady AI", hasKey: true },
      { id: "spare", label: "Spare", hasKey: false },
      { id: "custom", label: "Custom endpoint", hasKey: false, baseUrl: "https://llm.example/v1" },
    ],
    options: [
      { provider: "steady", model: "steady-mini", label: "Steady Mini" },
      { provider: "fast", model: "fast-small", label: "Fast Small", description: "Quickest" },
      { provider: "fast", model: "fast-large", label: "Fast Large" },
      { provider: "unlisted", model: "u-1", label: "U1" },
    ],
    ...patch,
  };
}

describe("groupOptions", () => {
  it("groups the catalog in the host's provider order and drops empty providers", () => {
    const labels = (group: ReturnType<typeof groupOptions>[number]) => [
      group.label,
      ...group.options.map((option) => option.label),
    ];
    expect(groupOptions(settings()).map(labels)).toEqual([
      ["Fast Cloud", "Fast Small", "Fast Large"],
      ["Steady AI", "Steady Mini"],
      ["unlisted", "U1"],
    ]);
  });

  it("keeps the custom endpoint out of the catalog groups", () => {
    const groups = groupOptions(
      settings({ options: [{ provider: "custom", model: "mine", label: "mine" }] }),
    );
    expect(groups).toEqual([]);
  });
});

describe("getModelLabels", () => {
  it("names a model by its catalog label and provider label", () => {
    expect(getModelLabels(settings(), fast)).toEqual({
      provider: "Fast Cloud",
      model: "Fast Small",
    });
  });

  it("falls back to the raw ids for models outside the catalog", () => {
    expect(getModelLabels(settings(), { provider: "custom", model: "router-7b" })).toEqual({
      provider: "Custom endpoint",
      model: "router-7b",
    });
    expect(getModelLabels(settings(), { provider: "gone", model: "m" })).toEqual({
      provider: "gone",
      model: "m",
    });
  });
});

describe("getKeyRows", () => {
  it("shows no key rows when calls use the agent only", () => {
    expect(getKeyRows(settings({ selection: null, backup: null, active: null }))).toEqual([]);
  });

  it("always shows the selection's key row", () => {
    expect(getKeyRows(settings())).toEqual([
      { provider: "fast", label: "Fast Cloud", hasKey: true, optional: false },
    ]);
  });

  it("adds the backup's row only when it is another provider without a key", () => {
    const spare = { provider: "spare", model: "spare-1" };
    expect(getKeyRows(settings({ backup: spare })).map((row) => row.provider)).toEqual([
      "fast",
      "spare",
    ]);
    expect(
      getKeyRows(settings({ selection: spare, backup: spare })).map((row) => row.provider),
    ).toEqual(["spare"]);
  });

  it("marks the custom endpoint's key as optional", () => {
    const rows = getKeyRows(settings({ selection: { provider: "custom", model: "router-7b" } }));
    expect(rows[0]).toMatchObject({ provider: "custom", optional: true, hasKey: false });
  });
});

describe("getFooter", () => {
  it("names what answers now", () => {
    expect(getFooter(settings())).toEqual({
      active: { provider: "Fast Cloud", model: "Fast Small" },
      missingKey: null,
    });
  });

  it("reports the selection that needs a key while the backup answers", () => {
    const spare = { provider: "spare", model: "spare-1" };
    expect(getFooter(settings({ selection: spare, active: steady }))).toEqual({
      active: { provider: "Steady AI", model: "Steady Mini" },
      missingKey: { provider: "Spare", model: "spare-1" },
    });
  });

  it("has no active model when calls use the agent", () => {
    expect(getFooter(settings({ selection: null, backup: null, active: null }))).toEqual({
      active: null,
      missingKey: null,
    });
  });

  it("does not ask for a key for the custom endpoint", () => {
    const custom = { provider: "custom", model: "router-7b" };
    expect(getFooter(settings({ selection: custom, active: custom })).missingKey).toBeNull();
  });
});

describe("getTestTarget", () => {
  it("tests whatever answers now", () => {
    expect(getTestTarget(settings())).toBe("selection");
    expect(getTestTarget(settings({ active: steady }))).toBe("backup");
    expect(getTestTarget(settings({ active: null }))).toBeNull();
  });

  it("prefers the selection when it is also the backup", () => {
    expect(getTestTarget(settings({ backup: fast }))).toBe("selection");
  });
});

describe("latency", () => {
  it("is green under 0.6 s, amber under 2 s, red above", () => {
    expect(getLatencyTone(340)).toBe("success");
    expect(getLatencyTone(599)).toBe("success");
    expect(getLatencyTone(600)).toBe("warning");
    expect(getLatencyTone(1999)).toBe("warning");
    expect(getLatencyTone(2000)).toBe("error");
  });

  it("shows the freshest round trip, or a failure", () => {
    expect(getRoundTripBadge(settings(), { failed: false, roundTripMs: null })).toBeNull();
    expect(
      getRoundTripBadge(settings({ lastRoundTripMs: 1400 }), { failed: false, roundTripMs: null }),
    ).toEqual({ kind: "time", ms: 1400, tone: "warning" });
    expect(
      getRoundTripBadge(settings({ lastRoundTripMs: 1400 }), { failed: false, roundTripMs: 340 }),
    ).toEqual({ kind: "time", ms: 340, tone: "success" });
    expect(getRoundTripBadge(settings(), { failed: true, roundTripMs: null })).toEqual({
      kind: "failed",
    });
  });

  it("shows no round trip when calls use the agent", () => {
    expect(
      getRoundTripBadge(settings({ active: null, lastRoundTripMs: 300 }), {
        failed: false,
        roundTripMs: null,
      }),
    ).toBeNull();
  });

  it("formats seconds for the locale", () => {
    expect(formatRoundTripSeconds(340, "en")).toBe("0.34");
    expect(formatRoundTripSeconds(1400, "en")).toBe("1.4");
    expect(formatRoundTripSeconds(340, "es")).toBe("0,34");
  });
});
