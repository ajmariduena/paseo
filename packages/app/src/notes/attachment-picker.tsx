import { useCallback, useMemo, useState, type ReactElement, type RefObject } from "react";
import type { View } from "react-native";
import { useTranslation } from "react-i18next";
import { NotebookPen } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { noteDisplayTitle } from "@getpaseo/protocol/notes/types";
import type { UserComposerAttachment } from "@/attachments/types";
import type { AttachmentMenuItem } from "@/composer/input/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { useHostFeature } from "@/runtime/host-features";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { createNoteAttachment, toggleNoteAttachment } from "./attachment";
import { useNotes, type HostNote } from "./data";

const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedNotebookPen = withUnistyles(NotebookPen);

interface NoteAttachmentPickerInput {
  serverId: string;
  attachments: UserComposerAttachment[];
  onChangeAttachments: (attachments: UserComposerAttachment[]) => void;
  anchorRef: RefObject<View | null>;
}

interface NoteAttachmentPickerBinding {
  menuItems: AttachmentMenuItem[];
  picker: ReactElement | null;
}

function noteOptions(notes: readonly HostNote[], selected: ReadonlySet<string>): ComboboxOption[] {
  return notes.map((note) => ({
    id: note.id,
    label: noteDisplayTitle(note),
    description: [
      note.todoState === "open" ? "Todo" : null,
      note.todoState === "done" ? "Done" : null,
      selected.has(note.id) ? "Attached" : null,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
}

export function useNoteAttachmentPicker(
  input: NoteAttachmentPickerInput,
): NoteAttachmentPickerBinding {
  const { t } = useTranslation();
  const supported = useHostFeature(input.serverId, "notes");
  const [open, setOpen] = useState(false);
  const { loadState } = useNotes({ poll: false });
  const notes = useMemo(
    () =>
      loadState.status === "loaded"
        ? loadState.notes.filter((note) => note.serverId === input.serverId)
        : [],
    [input.serverId, loadState],
  );
  const selected = useMemo(
    () =>
      new Set(
        input.attachments.flatMap((attachment) =>
          attachment.kind === "note" ? [attachment.noteId] : [],
        ),
      ),
    [input.attachments],
  );
  const options = useMemo(() => noteOptions(notes, selected), [notes, selected]);
  const handleOpenChange = useCallback((next: boolean) => setOpen(next), []);
  const handleSelect = useCallback(
    (noteId: string) => {
      const note = notes.find((candidate) => candidate.id === noteId);
      if (!note) return;
      input.onChangeAttachments(
        toggleNoteAttachment(input.attachments, createNoteAttachment(input.serverId, note)),
      );
      setOpen(false);
    },
    [input, notes],
  );
  const menuItems = useMemo<AttachmentMenuItem[]>(
    () =>
      supported
        ? [
            {
              id: "note",
              label: t("notes.composer.attach"),
              icon: <ThemedNotebookPen size={ICON_SIZE.md} uniProps={iconColorMapping} />,
              onSelect: () => setOpen(true),
            },
          ]
        : [],
    [supported, t],
  );
  if (!open) return { menuItems, picker: null };
  return {
    menuItems,
    picker: (
      <Combobox
        options={options}
        value=""
        onSelect={handleSelect}
        searchable
        searchPlaceholder={t("notes.composer.searchPlaceholder")}
        title={t("notes.composer.pickerTitle")}
        open
        onOpenChange={handleOpenChange}
        desktopPlacement="top-start"
        anchorRef={input.anchorRef}
        emptyText={loadState.status === "loading" ? t("notes.loading") : t("notes.empty.title")}
      />
    ),
  };
}
