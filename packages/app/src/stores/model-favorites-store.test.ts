import { describe, expect, it } from "vitest";
import { toggleModelFavorite } from "./model-favorites-store";

describe("toggleModelFavorite", () => {
  it("stars and unstars a model by its row key", () => {
    const starred = toggleModelFavorite([], "claude:opus-5");
    expect(starred).toEqual(["claude:opus-5"]);
    expect(toggleModelFavorite(starred, "claude:opus-5")).toEqual([]);
  });

  it("keeps the most recent hundred stars", () => {
    const keys = Array.from({ length: 100 }, (_, index) => `p:m${index}`);
    const next = toggleModelFavorite(keys, "p:new");
    expect(next).toHaveLength(100);
    expect(next[0]).toBe("p:m1");
    expect(next.at(-1)).toBe("p:new");
  });
});
