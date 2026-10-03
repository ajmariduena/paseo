export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const TERMINAL_FONT_WEIGHT = "500";
export const TERMINAL_FONT_WEIGHT_BOLD = "700";

/** Declared in public/index.html; ships with the app so prompt icons never depend on installed fonts. */
export const BUNDLED_TERMINAL_SYMBOLS_FONT = "Paseo Nerd Font Symbols";

const TERMINAL_FONT_FALLBACKS = [
  "JetBrains Mono",
  "JetBrainsMono Nerd Font",
  "JetBrainsMono NF",
  "MesloLGS NF",
  "MesloLGM Nerd Font",
  "MesloLGM NF",
  "Hack Nerd Font",
  "FiraCode Nerd Font",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Liberation Mono",
  BUNDLED_TERMINAL_SYMBOLS_FONT,
  "Symbols Nerd Font Mono",
  "Symbols Nerd Font",
  "monospace",
];

function quoteFontFamily(family: string): string {
  if (family === "monospace" || /^["'].*["']$/.test(family)) return family;
  return /\s/.test(family) ? `"${family}"` : family;
}

function unquoteFontFamily(family: string): string {
  return family.replace(/^["']|["']$/g, "").toLowerCase();
}

/** The user's family first, then every fallback it does not already name. */
export function resolveTerminalFontFamily(fontFamily: string | undefined): string {
  const chosen = (fontFamily ?? "")
    .split(",")
    .map((family) => family.trim())
    .filter((family) => family.length > 0);
  const named = new Set(chosen.map(unquoteFontFamily));
  const fallbacks = TERMINAL_FONT_FALLBACKS.filter((family) => !named.has(family.toLowerCase()));
  return [...chosen, ...fallbacks].map(quoteFontFamily).join(", ");
}

export const DEFAULT_TERMINAL_FONT_FAMILY = resolveTerminalFontFamily(undefined);

export function resolveTerminalFontSize(fontSize: number | undefined): number {
  return typeof fontSize === "number" && Number.isFinite(fontSize) && fontSize > 0
    ? fontSize
    : DEFAULT_TERMINAL_FONT_SIZE;
}

let symbolsFontLoad: Promise<boolean> | null = null;

/**
 * The bundled symbols face has a Private Use Area unicode-range, so the browser only fetches it
 * once a matching glyph is laid out in the DOM. The WebGL renderer rasterizes into a canvas atlas
 * instead, which would cache the missing-glyph box, so the face has to be loaded up front.
 */
export function loadBundledTerminalSymbolsFont(): Promise<boolean> {
  if (symbolsFontLoad) return symbolsFontLoad;
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts?.load) return Promise.resolve(false);
  symbolsFontLoad = fonts
    .load(`16px "${BUNDLED_TERMINAL_SYMBOLS_FONT}"`, "\ue0b0\uf015")
    .then((faces) => faces.length > 0)
    .catch(() => false);
  return symbolsFontLoad;
}

const LIGATURE_FONT_TOKENS = [
  "fira code",
  "jetbrains mono",
  "jetbrainsmono",
  "cascadia code",
  "iosevka",
  "victor mono",
  "hasklig",
  "monaspace",
  "monolisa",
  "commit mono",
  "geist mono",
  "maple mono",
];

/** Ligature shaping costs every repaint, so it only runs when the user picked a ligature font. */
export function terminalFontHasKnownLigatures(fontFamily: string | undefined): boolean {
  const primary = fontFamily?.split(",")[0]?.replace(/["']/g, "").trim().toLowerCase();
  return Boolean(primary) && LIGATURE_FONT_TOKENS.some((token) => primary!.includes(token));
}
