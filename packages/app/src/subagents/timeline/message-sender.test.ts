import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { formatSentByLabel, readAgentMessageSender } from "./message-sender";

describe("agent message attribution", () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init();
    }
    await i18n.changeLanguage("en");
  });

  it("names a sender only for messages another agent wrote", () => {
    expect(readAgentMessageSender({ kind: "agent", agentId: "agt_parent" })).toBe("agt_parent");
    expect(readAgentMessageSender({ kind: "user" })).toBeNull();
    expect(readAgentMessageSender(undefined)).toBeNull();
  });

  it("reads 'Sent by {title}', and 'Sent by an agent' while the title loads", () => {
    expect(formatSentByLabel(i18n.t, " Opus 5.5 — Diff panel plan ")).toBe(
      "Sent by Opus 5.5 — Diff panel plan",
    );
    expect(formatSentByLabel(i18n.t, null)).toBe("Sent by an agent");
    expect(formatSentByLabel(i18n.t, "   ")).toBe("Sent by an agent");
  });
});
