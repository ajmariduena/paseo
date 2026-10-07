import { describe, expect, it } from "vitest";
import { formatPeerMessage, isPeerMessage, parsePeerMessage } from "./peer-message.js";

describe("peer message envelope", () => {
  it("round-trips the sender and a multi-line body", () => {
    const text = formatPeerMessage({
      sender: {
        agentId: "agent-1",
        title: 'Rename "charge"',
        workspaceTitle: "peers · createCharge",
        branch: "peers-create-charge",
      },
      body: "Heads up: charge is now createCharge.\n\nIt returns {id, amount, status}.",
    });

    expect(isPeerMessage(text)).toBe(true);
    expect(parsePeerMessage(text)).toEqual({
      sender: {
        agentId: "agent-1",
        title: 'Rename "charge"',
        workspaceTitle: "peers · createCharge",
        branch: "peers-create-charge",
      },
      body: "Heads up: charge is now createCharge.\n\nIt returns {id, amount, status}.",
    });
  });

  it("tells the receiving model who sent it and how to reply", () => {
    const text = formatPeerMessage({ sender: { agentId: "agent-9" }, body: "hi" });
    expect(text.split("\n")[1]).toContain("not from your user");
    expect(text.split("\n")[1]).toContain("send_agent_prompt to agent-9");
  });

  it("omits empty sender fields", () => {
    const text = formatPeerMessage({
      sender: { agentId: "agent-2", title: "  ", workspaceTitle: null },
      body: "hi",
    });
    expect(text.split("\n")[0]).toBe('<paseo-peer-message from_agent="agent-2">');
    expect(parsePeerMessage(text)?.sender).toEqual({
      agentId: "agent-2",
      title: null,
      workspaceTitle: null,
      branch: null,
    });
  });

  it("rejects ordinary text and envelopes without a sender", () => {
    expect(parsePeerMessage("hello")).toBeNull();
    expect(parsePeerMessage("<paseo-peer-message>\nhint\nbody\n</paseo-peer-message>")).toBeNull();
    expect(isPeerMessage("<paseo-system>\nx\n</paseo-system>")).toBe(false);
  });
});
