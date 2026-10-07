import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import { NotebookPen, SquareCheck } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { buildNotesRoute } from "@/utils/host-routes";
import type { NoteComposerAttachment } from "./attachment";

const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedNotebookPen = withUnistyles(NotebookPen);
const ThemedSquareCheck = withUnistyles(SquareCheck);

interface NoteAttachmentPillProps {
  attachment: NoteComposerAttachment;
  index: number;
  disabled: boolean;
  onRemove: (index: number) => void;
}

export function NoteAttachmentPill({
  attachment,
  index,
  disabled,
  onRemove,
}: NoteAttachmentPillProps) {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  const handleOpen = useCallback(() => {
    router.push(buildNotesRoute({ serverId: attachment.serverId, noteId: attachment.noteId }));
  }, [attachment.noteId, attachment.serverId]);
  const icon = useMemo(
    () =>
      attachment.isTodo ? (
        <ThemedSquareCheck size={ICON_SIZE.sm} uniProps={iconColorMapping} />
      ) : (
        <ThemedNotebookPen size={ICON_SIZE.sm} uniProps={iconColorMapping} />
      ),
    [attachment.isTodo],
  );
  return (
    <AttachmentPill
      testID="composer-note-attachment-pill"
      onOpen={handleOpen}
      openAccessibilityLabel={t("notes.composer.open", { title: attachment.title })}
      onRemove={handleRemove}
      removeAccessibilityLabel={t("notes.composer.remove", { title: attachment.title })}
      disabled={disabled}
    >
      <AttachmentLabel
        icon={icon}
        title={attachment.title}
        subtitle={attachment.isTodo ? t("notes.kind.todo") : t("notes.kind.note")}
      />
    </AttachmentPill>
  );
}
