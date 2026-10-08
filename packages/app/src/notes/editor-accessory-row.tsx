import { type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ListChecks, Mic } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { mutedIconColorMapping } from "@/components/ui/icon-color";

const ThemedListChecks = withUnistyles(ListChecks);
const ThemedMic = withUnistyles(Mic);

function buttonStyle({
  pressed,
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.button, (pressed || hovered) && styles.buttonActive];
}

/** Compact editor tools above the keyboard; a plain row, since InputAccessoryView is iOS-only. */
export function EditorAccessoryRow({
  onChecklist,
  onDictate,
  onDone,
  dictationActive,
}: {
  onChecklist: () => void;
  onDictate: () => void;
  onDone: () => void;
  dictationActive: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.row} testID="note-accessory-row">
      <Pressable
        onPress={onChecklist}
        style={buttonStyle}
        accessibilityRole="button"
        testID="note-accessory-checklist"
      >
        <ThemedListChecks size={16} uniProps={mutedIconColorMapping} />
        <Text style={styles.label}>{t("notes.detail.checklist")}</Text>
      </Pressable>
      <Pressable
        onPress={onDictate}
        disabled={dictationActive}
        style={buttonStyle}
        accessibilityRole="button"
        testID="note-accessory-dictate"
      >
        <ThemedMic size={16} uniProps={mutedIconColorMapping} />
        <Text style={styles.label}>{t("notes.detail.dictate")}</Text>
      </Pressable>
      <View style={styles.spacer} />
      <Pressable
        onPress={onDone}
        style={buttonStyle}
        accessibilityRole="button"
        testID="note-accessory-done"
      >
        <Text style={styles.label}>{t("notes.detail.done")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    height: 44,
    paddingHorizontal: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    height: 32,
    paddingHorizontal: 10,
    borderRadius: theme.borderRadius.lg,
  },
  buttonActive: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  spacer: {
    flex: 1,
  },
}));
