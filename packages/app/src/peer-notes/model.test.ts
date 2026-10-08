import { beforeAll, describe, expect, it } from "vitest";
import { formatPeerMessage } from "@getpaseo/protocol/peer-message";
import { i18n } from "@/i18n/i18next";
import type { StreamItem, ToolCallItem, UserMessageItem } from "@/types/stream";
import {
  excerptPeerNote,
  formatPromptPreview,
  isOwnUserMessage,
  isPeerNote,
  readPeerNote,
  resolvePeerNoteSenderName,
} from "./model";

const sender = {
  agentId: "agt_1234567890",
  title: "Rename charge",
  workspaceTitle: "cents",
  branch: "peers-create-charge",
};
const body = "Heads up: I renamed `charge` to `createCharge`.\n\nRebase before you touch it.";

function userMessage(text: string): UserMessageItem {
  return { kind: "user_message", id: "msg", text, timestamp: new Date(0) };
}

function agentMessageRow(relation?: "peer"): ToolCallItem {
  return {
    kind: "tool_call",
    id: "agent_tool_note",
    timestamp: new Date(0),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: "paseo-agent-message:note",
        name: "agent_message",
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: body },
        agentMessage: {
          event: "message",
          sender: {
            id: sender.agentId,
            title: sender.title,
            workspaceTitle: sender.workspaceTitle,
            branch: sender.branch,
          },
          ...(relation ? { relation } : {}),
          text: body,
        },
      },
    },
  };
}

describe("peer notes", () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init();
    }
    await i18n.changeLanguage("en");
  });

  it("reads the sender and only the body, never the hint written for the model", () => {
    const note = readPeerNote(userMessage(formatPeerMessage({ sender, body })));

    expect(note).toEqual({ sender, body });
    expect(note?.body).not.toContain("send_agent_prompt");
  });

  it("reads a peer note delivered in an agent-message row, but not a parent's message", () => {
    expect(readPeerNote(agentMessageRow("peer"))).toEqual({ sender, body });
    expect(isPeerNote(agentMessageRow())).toBe(false);
  });

  it("treats a plain prompt, including one another agent sent, as the user's own message", () => {
    const fromParent: StreamItem = {
      ...userMessage("Fix the tests"),
      origin: { kind: "agent", agentId: "agt_parent" },
    };
    const note = userMessage(formatPeerMessage({ sender, body }));

    expect(isPeerNote(fromParent)).toBe(false);
    expect(isOwnUserMessage(fromParent)).toBe(true);
    expect(isPeerNote(note)).toBe(true);
    expect(isOwnUserMessage(note)).toBe(false);
    expect(isPeerNote(userMessage("<paseo-peer-message broken"))).toBe(false);
  });

  it("names the sender by workspace, then title, then live title, then a short id", () => {
    expect(resolvePeerNoteSenderName(sender)).toBe("cents");
    expect(resolvePeerNoteSenderName({ ...sender, workspaceTitle: null })).toBe("Rename charge");
    expect(
      resolvePeerNoteSenderName(
        { agentId: sender.agentId, title: " ", workspaceTitle: null },
        "Live",
      ),
    ).toBe("Live");
    expect(resolvePeerNoteSenderName({ agentId: sender.agentId })).toBe("agt_1234");
  });

  it("collapses the body to one line for the closed row", () => {
    expect(excerptPeerNote(body)).toBe(
      "Heads up: I renamed `charge` to `createCharge`. Rebase before you touch it.",
    );
  });

  it("turns a truncated envelope preview into 'Note from' and leaves other previews alone", () => {
    const envelope = formatPeerMessage({ sender, body }).replace(/\s+/g, " ");

    expect(formatPromptPreview(i18n.t, `${envelope.slice(0, 119)}…`)).toBe("Note from cents");
    const cutAfterId = envelope.slice(0, envelope.indexOf(" from_title"));
    expect(formatPromptPreview(i18n.t, cutAfterId)).toBe("Note from agt_1234");
    expect(formatPromptPreview(i18n.t, "Fix the tests")).toBe("Fix the tests");
  });
});
