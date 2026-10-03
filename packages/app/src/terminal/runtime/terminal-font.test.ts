import { describe, expect, it } from "vitest";
import {
  BUNDLED_TERMINAL_SYMBOLS_FONT,
  resolveTerminalFontFamily,
  terminalFontHasKnownLigatures,
} from "./terminal-font";

describe("resolveTerminalFontFamily", () => {
  it("keeps the bundled symbols font behind a user-chosen family", () => {
    const family = resolveTerminalFontFamily("Berkeley Mono");
    expect(family.startsWith('"Berkeley Mono", ')).toBe(true);
    expect(family).toContain(`"${BUNDLED_TERMINAL_SYMBOLS_FONT}"`);
    expect(family.endsWith("monospace")).toBe(true);
  });

  it("does not repeat a fallback the user already named", () => {
    const family = resolveTerminalFontFamily("'SF Mono', Menlo");
    expect(family.match(/SF Mono/g)).toHaveLength(1);
    expect(family.match(/Menlo/g)).toHaveLength(1);
    expect(family.startsWith("'SF Mono', Menlo, ")).toBe(true);
  });

  it("uses the default chain, including the bundled symbols font, when nothing is set", () => {
    expect(resolveTerminalFontFamily("  ")).toContain(`"${BUNDLED_TERMINAL_SYMBOLS_FONT}"`);
  });
});

describe("terminalFontHasKnownLigatures", () => {
  it("only enables ligatures for a ligature font the user picked", () => {
    expect(terminalFontHasKnownLigatures("Fira Code")).toBe(true);
    expect(terminalFontHasKnownLigatures('"JetBrainsMono Nerd Font", monospace')).toBe(true);
    expect(terminalFontHasKnownLigatures("SF Mono")).toBe(false);
    expect(terminalFontHasKnownLigatures(undefined)).toBe(false);
  });
});
