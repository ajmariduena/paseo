import { describe, expect, it } from "vitest";
import { buildLiveGreeting, buildLiveInstructions, describeLanguage } from "./prompt.js";

describe("voice language prompts", () => {
  it("names the language instead of passing a bare code", () => {
    expect(describeLanguage("es")).toBe("Spanish (español)");
    expect(describeLanguage("en")).toBe("English");
  });

  it("tells GPT-Live to speak the configured language, greeting included", () => {
    expect(buildLiveInstructions("es")).toContain("Always speak Spanish (español)");
    expect(buildLiveGreeting([], "es")).toContain("Greet the user in Spanish (español)");
  });
});
