import { describe, expect, it } from "vitest";
import {
  buildFleetBlock,
  buildLiveGreeting,
  buildLiveInstructions,
  describeLanguage,
} from "./prompt.js";

describe("voice language prompts", () => {
  it("names the language instead of passing a bare code", () => {
    expect(describeLanguage("es")).toBe("Spanish (español)");
    expect(describeLanguage("en")).toBe("English");
  });

  it("tells GPT-Live to speak the configured language, greeting included", () => {
    expect(buildLiveInstructions("es")).toContain("Always speak Spanish (español)");
    expect(buildLiveGreeting([], "es")).toContain("Greet the user in Spanish (español)");
  });

  it("lists older open sessions after the active ones", () => {
    const block = buildFleetBlock(
      ['- auth · "Login fix" (id a1) | status: working'],
      [
        '- Reminders Atlas · "Mira por que Atlas no puede recordar?" (id b2, idle since 2026-10-03)',
      ],
    );
    expect(block).toContain("Other open sessions (older or not loaded):");
    expect(block.indexOf("Login fix")).toBeLessThan(block.indexOf("Reminders Atlas"));
  });
});
