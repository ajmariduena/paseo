import { describe, expect, it } from "vitest";
import {
  buildFleetBlock,
  buildLiveGreeting,
  buildLiveInstructions,
  clipAgentMessage,
  describeLanguage,
} from "./prompt.js";

describe("voice language prompts", () => {
  it("names the language instead of passing a bare code", () => {
    expect(describeLanguage("es")).toBe("Spanish (español)");
    expect(describeLanguage("en")).toBe("English");
  });

  it("tells GPT-Live to speak the configured language, greeting included", () => {
    expect(buildLiveInstructions("es")).toContain("Always speak Spanish (español)");
    expect(buildLiveGreeting("es")).toContain('Say exactly "Hola, aquí estoy." and nothing else');
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

describe("clipAgentMessage", () => {
  it("leaves a message that fits untouched", () => {
    expect(clipAgentMessage("Done.  All  green.", 400, "agent-1")).toBe("Done. All green.");
  });

  it("points at get_agent_activity when it had to clip", () => {
    const clipped = clipAgentMessage("x".repeat(500), 400, "agent-1");
    expect(clipped.startsWith(`${"x".repeat(399)}…`)).toBe(true);
    expect(clipped).toContain("[truncated; get_agent_activity on agent agent-1 has the full text]");
  });
});
