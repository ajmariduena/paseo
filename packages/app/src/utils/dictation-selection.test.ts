import { describe, expect, it } from "vitest";
import type { ServerDictationStt } from "@getpaseo/protocol/messages";
import { getDictationModelLabel, listDictationLanguages } from "./dictation-selection";

const selection: ServerDictationStt = {
  provider: "elevenlabs",
  model: "scribe_v2",
  language: "es",
  options: [
    {
      provider: "local",
      model: "parakeet-tdt-0.6b-v3-int8",
      label: "Parakeet v3",
      available: true,
    },
    { provider: "elevenlabs", model: "scribe_v2", label: "ElevenLabs Scribe v2", available: true },
  ],
};

describe("dictation selection", () => {
  it("labels the active model from its option", () => {
    expect(getDictationModelLabel({ capabilities: { dictationStt: selection } })).toBe(
      "ElevenLabs Scribe v2",
    );
  });

  it("falls back to the raw model id when no option matches", () => {
    const stale = { ...selection, model: "scribe_v1" };
    expect(getDictationModelLabel({ capabilities: { dictationStt: stale } })).toBe("scribe_v1");
  });

  it("has no label for a host without the selection", () => {
    expect(getDictationModelLabel({ capabilities: {} })).toBeNull();
  });

  it("keeps a configured language that is not in the list", () => {
    expect(listDictationLanguages("ja")[0]).toBe("ja");
    expect(listDictationLanguages("es")).not.toContain("ja");
  });
});
