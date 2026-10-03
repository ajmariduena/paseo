import { memo, useMemo } from "react";
import { View, type TextStyle } from "react-native";
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
  // iOS spans inherit only the paragraph root's style, not the link's, so each one restates it.
  const labelStyle = useMemo(() => [chipStyle, styles.label], [chipStyle]);
  const titleStyle = useMemo(() => [chipStyle, styles.title], [chipStyle]);
  const checks = presentation.checks;
  const checksStyle = useMemo(
    () => (checks ? [chipStyle, checkStyles[checks]] : null),
    [checks, chipStyle],
  );

  return (
    <AssistantMarkdownLink source={source} style={chipStyle}>
      <MarkdownTextSpan style={labelStyle}>{presentation.label}</MarkdownTextSpan>
      {presentation.title ? (
        <MarkdownTextSpan style={titleStyle}> {presentation.title}</MarkdownTextSpan>
      ) : null}
      {checksStyle ? <MarkdownTextSpan style={checksStyle}> ●</MarkdownTextSpan> : null}
    </AssistantMarkdownLink>
  );
});

// A lone forge link can leave the paragraph UITextView and use a real rounded
// surface. Inline links stay as text so the surrounding paragraph remains selectable.
export const StandaloneForgeLinkChip = memo(function StandaloneForgeLinkChip({
  source,
  link,
  serverId,
  fetchEnabled,
  linkStyle,
}: ForgeLinkChipProps) {
  const summary = useForgeLinkSummary({ serverId, link, enabled: fetchEnabled });
  const presentation = presentForgeLinkChip(link, summary);
  const background = standaloneBackgrounds[presentation.tone];
  const chipStyle = useMemo(() => [linkStyle, styles.chip, styles.standaloneText], [linkStyle]);
  const labelStyle = useMemo(() => [chipStyle, styles.standaloneLabel], [chipStyle]);
  const titleStyle = useMemo(() => [chipStyle, styles.standaloneTitle], [chipStyle]);
  const checksStyle = useMemo(
    () => (presentation.checks ? [chipStyle, checkStyles[presentation.checks]] : null),
    [chipStyle, presentation.checks],
  );

  return (
    <View style={[styles.standaloneChip, background]}>
      <AssistantMarkdownLink source={source} style={chipStyle}>
        <MarkdownTextSpan style={labelStyle}>{presentation.label}</MarkdownTextSpan>
        {presentation.title ? (
          <MarkdownTextSpan style={titleStyle}> {presentation.title}</MarkdownTextSpan>
        ) : null}
        {checksStyle ? <MarkdownTextSpan style={checksStyle}> ●</MarkdownTextSpan> : null}
      </AssistantMarkdownLink>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  chip: {
    fontSize: theme.fontSize.sm,
  },
  standaloneChip: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  standaloneText: {
    lineHeight: 20,
  },
  standaloneLabel: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  standaloneTitle: {
    color: theme.colors.foregroundMuted,
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

const standaloneBackgrounds = StyleSheet.create((theme) => ({
  neutral: { backgroundColor: theme.colors.surface2 },
  open: { backgroundColor: theme.colors.statusSuccessTint },
  merged: { backgroundColor: theme.colors.statusMergedTint },
  closed: { backgroundColor: theme.colors.statusDangerTint },
  draft: { backgroundColor: theme.colors.surface2 },
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
