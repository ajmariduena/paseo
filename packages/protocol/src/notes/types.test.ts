import { describe, expect, it } from "vitest";
import { noteDisplayTitle } from "./types";

describe("noteDisplayTitle", () => {
  it("prefers a stored title", () => {
    expect(noteDisplayTitle({ title: " Stored ", body: "- [ ] body" })).toBe("Stored");
  });

  it("strips checklist, list and heading markers from the first body line", () => {
    expect(noteDisplayTitle({ title: "", body: "- [ ] foo" })).toBe("foo");
    expect(noteDisplayTitle({ title: "", body: "- [x] done thing" })).toBe("done thing");
    expect(noteDisplayTitle({ title: "", body: "\n\n1. foo\n2. bar" })).toBe("foo");
    expect(noteDisplayTitle({ title: "", body: "## Heading" })).toBe("Heading");
  });

  it("caps derived titles at 120 characters", () => {
    expect(noteDisplayTitle({ title: "", body: "a".repeat(200) })).toHaveLength(120);
  });
});
