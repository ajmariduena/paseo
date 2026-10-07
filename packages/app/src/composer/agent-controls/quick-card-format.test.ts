import { describe, expect, it } from "vitest";
import { formatContextWindow } from "./quick-card-format";

describe("formatContextWindow", () => {
  it("reads a million-token window as 1M and smaller ones in thousands", () => {
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
    expect(formatContextWindow(200_000)).toBe("200k");
    expect(formatContextWindow(128_000)).toBe("128k");
  });
});
