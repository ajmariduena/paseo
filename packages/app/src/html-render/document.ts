import type { Theme } from "@/styles/theme";
import type { RenderTheme } from "@getpaseo/protocol/html-render";
export {
  MIN_RENDER_HEIGHT as MIN_HEIGHT,
  MAX_RENDER_HEIGHT as MAX_HEIGHT,
  RENDER_CSP,
  prepareRenderDocument,
  readRenderBridgeMessage,
  renderThemeMessage,
  clampRenderHeight,
  renderFrameHeight,
} from "@getpaseo/protocol/html-render";
export type { RenderTheme } from "@getpaseo/protocol/html-render";

const CHART_COLORS = {
  light: ["#2563eb", "#d97706", "#9333ea", "#e11d48", "#0891b2"],
  dark: ["#60a5fa", "#fbbf24", "#c084fc", "#fb7185", "#22d3ee"],
} as const;

export function mapRenderTheme(theme: Theme): RenderTheme {
  const colors = theme.colors;
  const charts = CHART_COLORS[theme.colorScheme];
  return {
    appearance: theme.colorScheme,
    variables: {
      "--background": colors.background,
      "--foreground": colors.foreground,
      "--muted": colors.muted,
      "--muted-foreground": colors.mutedForeground,
      "--card": colors.surface1,
      "--card-foreground": colors.foreground,
      "--popover": colors.popover,
      "--popover-foreground": colors.popoverForeground,
      "--secondary": colors.secondary,
      "--secondary-foreground": colors.secondaryForeground,
      "--border": colors.border,
      "--input": colors.input,
      "--ring": colors.ring,
      "--primary": colors.primary,
      "--primary-foreground": colors.primaryForeground,
      "--accent": colors.accent,
      "--accent-foreground": colors.accentForeground,
      "--accent-surface": colors.surface2,
      "--accent-surface-foreground": colors.foreground,
      "--destructive": colors.destructive,
      "--destructive-foreground": colors.destructiveForeground,
      "--destructive-surface": colors.surface2,
      "--warning": colors.statusWarning,
      "--warning-foreground": colors.foreground,
      "--warning-surface": colors.surface2,
      "--success": colors.success,
      "--success-foreground": colors.successForeground,
      "--info": colors.palette.blue[500],
      "--info-foreground": colors.foreground,
      "--code-background": colors.surface1,
      "--code-foreground": colors.foreground,
      "--chart-1": colors.accent,
      "--chart-2": charts[0],
      "--chart-3": charts[1],
      "--chart-4": charts[2],
      "--chart-5": charts[3],
      "--chart-6": charts[4],
      "--radius": "10px",
      "--font-sans": theme.fontFamily.ui,
      "--font-mono": theme.fontFamily.mono,
      "--font-size-base": `${theme.fontSize.base}px`,
    },
  };
}
