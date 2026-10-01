import { memo, useMemo } from "react";
import type { TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AssistantMarkdownLink } from "@/assistant-file-links/link";
import type { AssistantFileLinkSource } from "@/assistant-file-links/resolver";
import { MarkdownTextSpan } from "@/components/markdown-text";
import { useForgeLinkSummary } from "@/git/forge-link-summaries";
import type { ParsedForgeLink } from "@/git/forge-link-ref";
import { presentForgeLinkChip } from "./forge-link-chip-presentation";

export interface ForgeLinkChipProps {
  source: AssistantFileLinkSource;
  link: ParsedForgeLink;
  serverId: string | null;
  fetchEnabled: boolean;
  linkStyle: TextStyle;
}

// Text only: on iOS the paragraph is a single UITextView that drops non-text inline
// children, so the state reads through color instead of an icon.
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
  const chipStyle = useMemo(() => [linkStyle, styles.chip, tone], [linkStyle, tone]);

  return (
    <AssistantMarkdownLink source={source} style={chipStyle}>
      <MarkdownTextSpan style={styles.label}>{presentation.label}</MarkdownTextSpan>
      {presentation.title ? (
        <MarkdownTextSpan style={styles.title}> {presentation.title}</MarkdownTextSpan>
      ) : null}
      {presentation.checks ? (
        <MarkdownTextSpan style={checkStyles[presentation.checks]}> ●</MarkdownTextSpan>
      ) : null}
    </AssistantMarkdownLink>
  );
});

const styles = StyleSheet.create((theme) => ({
  chip: {
    fontSize: theme.fontSize.sm,
  },
  neutral: {
    color: theme.colors.accentBright,
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
  },
  title: {
    color: theme.colors.foregroundMuted,
  },
}));

const checkStyles = StyleSheet.create((theme) => ({
  success: {
    color: theme.colors.statusDotSuccess,
  },
  pending: {
    color: theme.colors.statusDotWarning,
  },
  failure: {
    color: theme.colors.statusDotDanger,
  },
}));
