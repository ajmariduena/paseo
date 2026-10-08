import { describe, expect, it } from "vitest";
import type { HostNote } from "./data";
import {
  appendTranscript,
  checklistProgress,
  continueChecklist,
  filterNotes,
  foldTitleIntoBody,
  isBlankNoteText,
  noteSummaryLine,
  resolveLinkedAgentState,
  toggleChecklistLine,
} from "./model";

function note(overrides: Partial<HostNote>): HostNote {
  return {
    id: "n1",
    title: "",
    body: "",
    todoState: null,
    projectId: null,
    workspaceId: null,
    author: { type: "user" },
    linkedAgents: [],
    archivedAt: null,
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
    revision: 0,
    serverId: "host-a",
    serverName: "Host A",
    ...overrides,
  };
}

function caret(offset: number) {
  return { start: offset, end: offset };
}

describe("filterNotes", () => {
  const plain = note({ id: "plain", title: "Relay reconnect is slow" });
  const done = note({ id: "done", title: "Ship widget", todoState: "done", body: "relay" });

  it("keeps every note, including legacy done todos, when the query is empty", () => {
    expect(filterNotes([plain, done], "").map((n) => n.id)).toEqual(["plain", "done"]);
  });

  it("searches title and body case-insensitively", () => {
    expect(filterNotes([plain, done], "RELAY").map((n) => n.id)).toEqual(["plain", "done"]);
    expect(filterNotes([plain, done], "widget")).toEqual([done]);
  });
});

describe("noteSummaryLine", () => {
  it("shows checklist progress when the body has checkboxes", () => {
    expect(noteSummaryLine(note({ body: "Ship\n- [x] a\n- [ ] b\n- [X] c" }))).toEqual({
      kind: "progress",
      done: 2,
      total: 3,
    });
  });

  it("shows the second non-empty line of an untitled note", () => {
    expect(noteSummaryLine(note({ body: "# Relay\n\n> slow on wake\nmore" }))).toEqual({
      kind: "line",
      text: "slow on wake",
    });
    expect(noteSummaryLine(note({ body: "Only one line" }))).toBeNull();
  });

  it("shows the first body line under a stored title", () => {
    expect(noteSummaryLine(note({ title: "Relay", body: "slow on wake" }))).toEqual({
      kind: "line",
      text: "slow on wake",
    });
  });
});

describe("checklistProgress", () => {
  it("returns null without checklist lines", () => {
    expect(checklistProgress("- plain bullet\n[ ] not a list")).toBeNull();
  });

  it("counts indented and alternate bullets", () => {
    expect(checklistProgress("  * [x] a\n+ [ ] b")).toEqual({ done: 1, total: 2 });
  });
});

describe("toggleChecklistLine", () => {
  it("flips an open item to done and back, keeping the caret", () => {
    const text = "Plan\n- [ ] ship";
    const done = toggleChecklistLine(text, caret(9));
    expect(done).toEqual({ text: "Plan\n- [x] ship", selection: caret(9) });
    expect(toggleChecklistLine(done.text, caret(9)).text).toBe(text);
  });

  it("turns a plain line into an open item and moves the caret past the marker", () => {
    expect(toggleChecklistLine("Plan\nship it", caret(7))).toEqual({
      text: "Plan\n- [ ] ship it",
      selection: caret(13),
    });
  });

  it("turns a bullet into an item and keeps indentation", () => {
    expect(toggleChecklistLine("  - ship", caret(8)).text).toBe("  - [ ] ship");
  });

  it("starts an item on an empty line", () => {
    expect(toggleChecklistLine("", caret(0))).toEqual({ text: "- [ ] ", selection: caret(6) });
  });
});

describe("continueChecklist", () => {
  it("starts the next item at the end of an item", () => {
    expect(continueChecklist("- [x] one", caret(9))).toEqual({
      text: "- [x] one\n- [ ] ",
      selection: caret(16),
    });
  });

  it("keeps indentation and bullet style", () => {
    expect(continueChecklist("  * [ ] one\nnext", caret(11))?.text).toBe(
      "  * [ ] one\n  * [ ] \nnext",
    );
  });

  it("removes the marker from an empty item", () => {
    expect(continueChecklist("- [ ] one\n- [ ] ", caret(16))).toEqual({
      text: "- [ ] one\n",
      selection: caret(10),
    });
  });

  it("leaves Enter alone mid-line, on plain lines and with a range selected", () => {
    expect(continueChecklist("- [ ] one", caret(7))).toBeNull();
    expect(continueChecklist("plain", caret(5))).toBeNull();
    expect(continueChecklist("- [ ] one", { start: 2, end: 9 })).toBeNull();
  });
});

describe("draft rules", () => {
  it("treats whitespace-only text as blank, so a draft is never created from it", () => {
    expect(isBlankNoteText("  \n\t")).toBe(true);
    expect(isBlankNoteText("- [ ] ")).toBe(false);
  });

  it("folds a stored title into the body on first edit", () => {
    expect(foldTitleIntoBody({ title: "Relay", body: "slow" })).toBe("Relay\nslow");
    expect(foldTitleIntoBody({ title: "Relay", body: "" })).toBe("Relay");
    expect(foldTitleIntoBody({ title: " ", body: "slow" })).toBe("slow");
  });

  it("appends dictated text with a single separating space", () => {
    expect(appendTranscript("", " hi ")).toBe("hi");
    expect(appendTranscript("one", "two")).toBe("one two");
    expect(appendTranscript("one\n", "two")).toBe("one\ntwo");
  });
});

describe("resolveLinkedAgentState", () => {
  it("reports an idle agent on an open todo as ready to review", () => {
    expect(resolveLinkedAgentState({ status: "idle" }, { todoState: "open" })).toBe("review");
  });

  it("does not claim review for plain notes or done todos", () => {
    expect(resolveLinkedAgentState({ status: "idle" }, { todoState: null })).toBe("idle");
    expect(resolveLinkedAgentState({ status: "idle" }, { todoState: "done" })).toBe("idle");
  });

  it("prefers archived, then running and error states", () => {
    expect(
      resolveLinkedAgentState({ status: "running", archivedAt: new Date() }, { todoState: "open" }),
    ).toBe("archived");
    expect(resolveLinkedAgentState({ status: "initializing" }, { todoState: "open" })).toBe(
      "running",
    );
    expect(resolveLinkedAgentState({ status: "error" }, { todoState: "open" })).toBe("error");
  });
});
