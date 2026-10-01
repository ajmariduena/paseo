import type { ForgeLinkRef, ForgeLinkSummary } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseForgeLink, type ParsedForgeLink } from "./forge-link-ref";
import {
  getForgeLinkSummary,
  requestForgeLinkSummary,
  resetForgeLinkSummariesForTest,
} from "./forge-link-summaries";

function link(number: number): ParsedForgeLink {
  return parseForgeLink(`https://github.com/getpaseo/paseo/pull/${number}`) as ParsedForgeLink;
}

function createClient() {
  const calls: ForgeLinkRef[][] = [];
  return {
    calls,
    async getForgeLinkSummaries({ refs }: { refs: ForgeLinkRef[] }): Promise<ForgeLinkSummary[]> {
      calls.push(refs);
      return refs.map((ref) => ({
        ...ref,
        kind: "pull_request",
        state: "merged",
        draft: false,
        title: `PR ${ref.number}`,
        checksStatus: null,
        available: true,
      }));
    },
  };
}

describe("forge link summaries store", () => {
  afterEach(() => {
    resetForgeLinkSummariesForTest();
    vi.useRealTimers();
  });

  it("batches links requested in the same tick into one request", async () => {
    vi.useFakeTimers();
    const client = createClient();
    for (const number of [1, 2, 2, 3]) {
      requestForgeLinkSummary({ serverId: "srv", link: link(number), client });
    }
    await vi.runAllTimersAsync();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.map((ref) => ref.number)).toEqual([1, 2, 3]);
    expect(getForgeLinkSummary("srv", link(2).key)?.title).toBe("PR 2");
  });

  it("does not refetch a fresh terminal summary", async () => {
    vi.useFakeTimers();
    const client = createClient();
    requestForgeLinkSummary({ serverId: "srv", link: link(1), client });
    await vi.runAllTimersAsync();
    requestForgeLinkSummary({ serverId: "srv", link: link(1), client });
    await vi.runAllTimersAsync();

    expect(client.calls).toHaveLength(1);
  });
});
