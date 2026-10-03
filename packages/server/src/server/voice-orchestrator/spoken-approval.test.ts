import { describe, expect, it } from "vitest";
import { isSpokenApproval } from "./spoken-approval.js";

describe("isSpokenApproval", () => {
  it.each([
    "Sí",
    "sí, dale",
    "Dale.",
    "apruébalo",
    "Yes",
    "go ahead",
    "ok, approve it",
    "de acuerdo",
  ])("accepts %s", (text) => {
    expect(isSpokenApproval(text)).toBe(true);
  });

  it.each([
    "",
    "no",
    "no, espera",
    "sí, pero no lo apruebes",
    "wait",
    "what does it want to run?",
    "cancela eso",
    "silla",
  ])("rejects %s", (text) => {
    expect(isSpokenApproval(text)).toBe(false);
  });
});
