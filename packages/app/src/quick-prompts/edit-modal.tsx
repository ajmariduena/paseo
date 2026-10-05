import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { QuickPrompt } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openQuickPromptForm } from "./form";

export function QuickPromptEditModal({
  prompt,
  isNew,
  pinCount,
  onSave,
  onClose,
}: {
  prompt: QuickPrompt;
  isNew: boolean;
  pinCount: number;
  onSave: (prompt: QuickPrompt) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [model] = useState(() => openQuickPromptForm(prompt, pinCount));
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const close = useCallback(() => {
    if (!state.submitting) onClose();
  }, [state.submitting, onClose]);
  const save = useCallback(async () => {
    if (await model.submit(onSave)) onClose();
  }, [model, onSave, onClose]);
  const header = useMemo(
    () => ({ title: t(isNew ? "quickPrompts.add" : "quickPrompts.edit") }),
    [t, isNew],
  );
  const setTitle = useCallback((title: string) => model.set({ title }), [model]);
  const setText = useCallback((text: string) => model.set({ text }), [model]);
  const setMode = useCallback((mode: QuickPrompt["mode"]) => model.set({ mode }), [model]);
  const setPinned = useCallback((pinned: boolean) => model.set({ pinned }), [model]);
  const setDefault = useCallback((isDefault: boolean) => model.set({ isDefault }), [model]);
  const pressSave = useCallback(() => {
    void save();
  }, [save]);
  const pinLimit = !prompt.pinned && pinCount >= 3;
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={520}
      testID="quick-prompt-editor"
    >
      <View style={styles.body}>
        <Field label={t("quickPrompts.title")}>
          <FormTextInput
            initialValue={prompt.title}
            onChangeText={setTitle}
            size={size}
            editable={!state.submitting}
            maxLength={80}
            accessibilityLabel={t("quickPrompts.title")}
            testID="quick-prompt-title"
          />
        </Field>
        <Field label={t("quickPrompts.text")}>
          <FormTextInput
            initialValue={prompt.text}
            onChangeText={setText}
            size={size}
            editable={!state.submitting}
            multiline
            numberOfLines={4}
            style={styles.textInput}
            accessibilityLabel={t("quickPrompts.text")}
            testID="quick-prompt-text"
          />
        </Field>
        <Field label={t("quickPrompts.mode")}>
          <SegmentedControl
            value={state.prompt.mode}
            onValueChange={setMode}
            size={size}
            options={[
              { value: "send", label: t("quickPrompts.send"), disabled: state.submitting },
              { value: "insert", label: t("quickPrompts.insert"), disabled: state.submitting },
            ]}
          />
        </Field>
        <View style={styles.row}>
          <Text style={styles.label}>{t("quickPrompts.pin")}</Text>
          <Switch
            value={state.prompt.pinned}
            onValueChange={setPinned}
            disabled={state.submitting || pinLimit}
            accessibilityLabel={t("quickPrompts.pin")}
          />
        </View>
        {pinLimit ? <Text style={styles.label}>{t("quickPrompts.pinLimit")}</Text> : null}
        <View style={styles.row}>
          <Text style={styles.label}>{t("quickPrompts.default")}</Text>
          <Switch
            value={state.prompt.isDefault}
            onValueChange={setDefault}
            disabled={state.submitting}
            accessibilityLabel={t("quickPrompts.default")}
          />
        </View>
        {state.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {state.error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button variant="secondary" onPress={close} disabled={state.submitting}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onPress={pressSave}
            loading={state.submitting}
            disabled={!state.canSubmit}
            testID="quick-prompt-save"
          >
            {t("quickPrompts.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  textInput: { minHeight: 100, textAlignVertical: "top" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
}));
