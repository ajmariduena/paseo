import {
  CircleCheck,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-react-native";
import { memo, useMemo } from "react";
import { Text, View, type TextStyle, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AssistantMarkdownLink } from "@/assistant-file-links/link";
import type { AssistantFileLinkSource } from "@/assistant-file-links/resolver";
import { useForgeLinkSummary } from "@/git/forge-link-summaries";
import type { ParsedForgeLink } from "@/git/forge-link-ref";
import { presentForgeLinkChip, type ForgeLinkGlyph } from "./forge-link-chip-presentation";

const GLYPHS: Record<ForgeLinkGlyph, LucideIcon> = {
  pull_request: GitPullRequest,
  pull_request_merged: GitMerge,
  pull_request_closed: GitPullRequestClosed,
  pull_request_draft: GitPullRequestDraft,
  issue: CircleDot,
  issue_closed: CircleCheck,
};

const CHIP_ICON_SIZE = 13;
// RN-web honors these CSS values at runtime; RN's style types do not model them.
const CHIP_NOWRAP_STYLE = {
  display: "inline-block",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  verticalAlign: "bottom",
} as unknown as TextStyle;
const ICON_SLOT_STYLE = {
  display: "inline-flex",
  marginRight: 4,
  verticalAlign: "-2px",
} as unknown as ViewStyle;

export interface ForgeLinkChipProps {
  source: AssistantFileLinkSource;
  link: ParsedForgeLink;
  serverId: string | null;
  fetchEnabled: boolean;
  linkStyle: TextStyle;
}

export const ForgeLinkChip = memo(function ForgeLinkChip({
  source,
  link,
  serverId,
  fetchEnabled,
  linkStyle,
}: ForgeLinkChipProps) {
  const summary = useForgeLinkSummary({ serverId, link, enabled: fetchEnabled });
  const presentation = presentForgeLinkChip(link, summary);
  const tone = styles[presentation.tone];
  const chipStyle = useMemo(
    () => [linkStyle, styles.chip, CHIP_NOWRAP_STYLE, tone],
    [linkStyle, tone],
  );
  const Icon = GLYPHS[presentation.glyph];

  return (
    <AssistantMarkdownLink source={source} style={chipStyle}>
      <View style={ICON_SLOT_STYLE}>
        <Icon size={CHIP_ICON_SIZE} color={tone.color} />
      </View>
      <Text style={styles.label}>{presentation.label}</Text>
      {presentation.title ? <Text style={styles.title}> {presentation.title}</Text> : null}
      {presentation.checks ? <Text style={checkStyles[presentation.checks]}> ●</Text> : null}
    </AssistantMarkdownLink>
  );
});

const styles = StyleSheet.create((theme) => ({
  chip: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  neutral: {
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
  },
  open: {
    color: theme.colors.statusSuccess,
    backgroundColor: theme.colors.statusSuccessTint,
  },
  merged: {
    color: theme.colors.statusMerged,
    backgroundColor: theme.colors.statusMergedTint,
  },
  closed: {
    color: theme.colors.statusDanger,
    backgroundColor: theme.colors.statusDangerTint,
  },
  draft: {
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
  },
  label: {
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  },
  title: {
    color: theme.colors.foregroundMuted,
  },
}));

const checkStyles = StyleSheet.create((theme) => ({
  success: {
    color: theme.colors.statusDotSuccess,
    fontSize: 9,
  },
  pending: {
    color: theme.colors.statusDotWarning,
    fontSize: 9,
  },
  failure: {
    color: theme.colors.statusDotDanger,
    fontSize: 9,
  },
}));
