import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SquareArrowOutUpRight, StickyNote } from "lucide-react-native";
import { ExpandableBadge, STREAM_METADATA_FONT_SIZE } from "@/components/message";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { useSubagentTimeline } from "@/subagents/timeline/context";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { formatMessageTimestamp } from "@/utils/time";
import { excerptPeerNote, resolvePeerNoteSenderName, type PeerNote } from "./model";

interface PeerNoteRowProps {
  itemId: string;
  note: PeerNote;
  timestamp: Date;
  /** Open until the user toggles it: notes in the latest turn arrive open, older ones closed. */
  defaultExpanded: boolean;
  isLastInSequence: boolean;
  /** Draws the body the way the transcript draws assistant text. */
  renderBody: (input: { itemId: string; body: string }) => ReactNode;
}

/** A note from another session: a collapsible row in the tool-call rhythm, never a user bubble. */
export const PeerNoteRow = memo(function PeerNoteRow({
  itemId,
  note,
  timestamp,
  defaultExpanded,
  isLastInSequence,
  renderBody,
}: PeerNoteRowProps) {
  const { t } = useTranslation();
  const { serverId, providerEntries, open } = useSubagentTimeline();
  const senderId = note.sender.agentId;
  const liveTitle = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (session?.agents.get(senderId) ?? session?.agentDetails.get(senderId))?.title ?? null;
  });
  const provider = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (session?.agents.get(senderId) ?? session?.agentDetails.get(senderId))?.provider ?? null;
  });
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const isExpanded = expandedOverride ?? defaultExpanded;

  const label = t("message.peerNote.from", {
    name: resolvePeerNoteSenderName(note.sender, liveTitle),
  });
  const excerpt = useMemo(() => excerptPeerNote(note.body), [note.body]);
  const timeLabel = useMemo(() => formatMessageTimestamp(timestamp), [timestamp]);
  const meta = useMemo(() => {
    const providerLabel = provider ? resolveProviderLabel(provider, providerEntries) : null;
    return [note.sender.branch, providerLabel].filter(Boolean).join(" · ");
  }, [note.sender.branch, provider, providerEntries]);

  const toggle = useCallback(() => setExpandedOverride(!isExpanded), [isExpanded]);
  const openSender = useCallback(
    () => open({ kind: "agent", agentId: senderId }),
    [open, senderId],
  );
  const renderDetails = useCallback(
    () => (
      <View style={styles.details}>
        {renderBody({ itemId, body: note.body })}
        <View style={styles.footer}>
          <Button
            variant="outline"
            size="xs"
            leftIcon={SquareArrowOutUpRight}
            onPress={openSender}
            testID="peer-note-open-session"
          >
            {t("message.peerNote.openSession")}
          </Button>
          {meta ? (
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </View>
    ),
    [itemId, meta, note.body, openSender, renderBody, t],
  );

  return (
    <ExpandableBadge
      testID="peer-note"
      label={label}
      secondaryLabel={isExpanded ? undefined : excerpt}
      trailingLabel={timeLabel}
      icon={StickyNote}
      isExpanded={isExpanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  details: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  meta: {
    flexShrink: 1,
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
  },
}));
