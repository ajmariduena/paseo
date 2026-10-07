import { expect, test } from "vitest";
import { confirmNativeExternalLink } from "./native-link";

test("shows the full native URL and does not open on cancel", async () => {
  const calls: string[] = [];
  await expect(
    confirmNativeExternalLink(
      "https://example.com/path?token=visible",
      async (input) => {
        calls.push(JSON.stringify(input));
        return false;
      },
      async (url) => {
        calls.push(url);
      },
    ),
  ).rejects.toThrow("cancelled");
  expect(calls).toEqual([
    JSON.stringify({
      title: "Open link?",
      message: "https://example.com/path?token=visible",
      confirmLabel: "Open",
    }),
  ]);
});

test("opens only after confirmation and propagates opener failure", async () => {
  const calls: string[] = [];
  await expect(
    confirmNativeExternalLink(
      "https://example.com/target",
      async () => {
        calls.push("confirmed");
        return true;
      },
      async () => {
        calls.push("opened");
        throw new Error("Platform refused");
      },
    ),
  ).rejects.toThrow("Platform refused");
  expect(calls).toEqual(["confirmed", "opened"]);
  await expect(
    confirmNativeExternalLink(
      "javascript:alert(1)",
      async () => true,
      async () => {
        throw new Error("should not open");
      },
    ),
  ).rejects.toThrow("Invalid link");
});
