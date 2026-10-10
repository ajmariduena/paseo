import { describe, expect, it } from "vitest";
import { isBareApproval, isSpokenApproval, mentionsApproval } from "./spoken-approval.js";

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

describe("isBareApproval", () => {
  it("accepts a yes with nothing else", () => {
    for (const text of ["Sí", "Sí, dale.", "dale, hazlo", "ok", "Sí, por favor", "claro que sí"]) {
      expect(isBareApproval(text), text).toBe(text !== "claro que sí");
    }
  });

  it("rejects a yes that carries a correction or a condition", () => {
    for (const text of [
      "Sí, para la mini",
      "sí, el de la MacBook",
      "dale si es seguro",
      "sí, espera",
    ]) {
      expect(isBareApproval(text), text).toBe(false);
    }
  });
});

describe("mentionsApproval", () => {
  it("sees a yes next to a no", () => {
    expect(mentionsApproval("sí, espera")).toBe(true);
    expect(mentionsApproval("no, mejor el otro")).toBe(false);
  });
});
