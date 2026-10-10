import { expect, test } from "vitest";
import { followUpConfirmationMessage, performVisualizationFollowUp } from "./follow-up";

test("labels a page-supplied title while preserving the exact follow-up prompt", () => {
  expect(followUpConfirmationMessage("Explain apples\nprecisely", "Fruit\nchart")).toBe(
    "From the visualization: Fruit chart\n\nExplain apples\nprecisely",
  );
});

test("cancelled follow-up sends no agent message", async () => {
  const sent: string[] = [];
  expect(
    await performVisualizationFollowUp({
      prompt: "Explain the apple series",
      title: "Fruit detail",
      confirm: async (prompt, title) => {
        expect([prompt, title]).toEqual(["Explain the apple series", "Fruit detail"]);
        return false;
      },
      send: async (prompt) => sent.push(prompt),
    }),
  ).toBe(false);
  expect(sent).toEqual([]);
});

test("confirmed follow-up sends once and failed send remains retryable", async () => {
  const sent: string[] = [];
  const input = {
    prompt: "Explain the banana series",
    confirm: async () => true,
    send: async (prompt: string) => {
      sent.push(prompt);
      if (sent.length === 1) throw new Error("Host disconnected");
    },
  };
  await expect(performVisualizationFollowUp(input)).rejects.toThrow("Host disconnected");
  expect(await performVisualizationFollowUp(input)).toBe(true);
  expect(sent).toEqual(["Explain the banana series", "Explain the banana series"]);
});
