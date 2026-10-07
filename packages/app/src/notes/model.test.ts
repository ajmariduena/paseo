import { describe, expect, it } from "vitest";
import type { HostNote } from "./data";
import { countOpenTodos, filterNotes, groupNotesByProject, resolveLinkedAgentState } from "./model";

function note(overrides: Partial<HostNote>): HostNote {
  return {
    id: "n1",
    title: "Title",
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

describe("filterNotes", () => {
  const plain = note({ id: "plain", title: "Relay reconnect is slow" });
  const open = note({ id: "open", title: "Fix flicker", todoState: "open" });
  const done = note({ id: "done", title: "Ship widget", todoState: "done", body: "relay" });

  it("hides done todos from All and shows only open todos under Todos", () => {
    expect(filterNotes([plain, open, done], { filter: "all", query: "" }).map((n) => n.id)).toEqual(
      ["plain", "open"],
    );
    expect(
      filterNotes([plain, open, done], { filter: "todos", query: "" }).map((n) => n.id),
    ).toEqual(["open"]);
    expect(
      filterNotes([plain, open, done], { filter: "done", query: "" }).map((n) => n.id),
    ).toEqual(["done"]);
  });

  it("searches title and body case-insensitively", () => {
    expect(filterNotes([plain, open, done], { filter: "done", query: "RELAY" })).toEqual([done]);
    expect(filterNotes([plain, open, done], { filter: "all", query: "relay" })).toEqual([plain]);
  });

  it("counts open todos only", () => {
    expect(countOpenTodos([plain, open, done])).toBe(1);
  });
});

describe("groupNotesByProject", () => {
  const projectName = (_serverId: string, projectId: string) =>
    projectId === "p1" ? "paseo" : null;

  it("keeps project groups in first-seen order and puts unassigned notes last", () => {
    const groups = groupNotesByProject(
      [note({ id: "a" }), note({ id: "b", projectId: "p1" }), note({ id: "c", projectId: "p1" })],
      { projectName, noProjectLabel: "No project" },
    );
    const ids = (group: { notes: HostNote[] }) => group.notes.map((n) => n.id);
    expect(groups.map((group) => [group.label, ids(group)])).toEqual([
      ["paseo", ["b", "c"]],
      ["No project", ["a"]],
    ]);
  });

  it("names the host only when notes come from more than one host", () => {
    const groups = groupNotesByProject(
      [note({ id: "a" }), note({ id: "b", serverId: "host-b", serverName: "Mini" })],
      { projectName, noProjectLabel: "No project" },
    );
    expect(groups.map((group) => group.label)).toEqual([
      "No project · Host A",
      "No project · Mini",
    ]);
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
