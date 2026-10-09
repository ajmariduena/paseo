import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
} from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ArrowRight, Pencil, Trash2, X } from "lucide-react-native";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DICTIONARY_LIMITS, type DictionaryReplacement } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useTouchHitSlop } from "@/components/ui/touch-target";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { DictionaryEntries } from "./catalog";
import {
  openDictionaryForm,
  openReplacementForm,
  type DictionaryFormError,
  type DictionaryErrorScope,
  type SaveDictionary,
} from "./form";
import { useDictionary } from "./use-dictionary";

type DictionaryForm = ReturnType<typeof openDictionaryForm>;
type DictionaryFormState = ReturnType<DictionaryForm["getState"]>;

const ThemedArrowRight = withUnistyles(ArrowRight);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedX = withUnistyles(X);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type ThemedIcon = ComponentType<{
  size: number;
  uniProps: (theme: Theme) => { color: string };
}>;

function errorMessage(error: DictionaryFormError, t: TFunction): string {
  switch (error.code) {
    case "emptyWord":
      return t("settings.dictionary.errors.emptyWord");
    case "emptyReplacement":
      return t("settings.dictionary.errors.emptyReplacement");
    case "tooLong":
      return t("settings.dictionary.errors.tooLong", { max: error.max });
    case "duplicateWord":
      return t("settings.dictionary.errors.duplicateWord");
    case "duplicateHeard":
      return t("settings.dictionary.errors.duplicateHeard");
    case "wordLimit":
      return t("settings.dictionary.errors.wordLimit", { max: error.max });
    case "replacementLimit":
      return t("settings.dictionary.errors.replacementLimit", { max: error.max });
    case "saveFailed":
      return error.message;
  }
}

function scopedError(state: DictionaryFormState, scope: DictionaryErrorScope, t: TFunction) {
  return state.error?.scope === scope ? errorMessage(state.error.error, t) : null;
}

export function DictionarySection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { dictionary, loaded, supported, connected, save } = useDictionary(serverId);
  const [form] = useState(openDictionaryForm);
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const [editing, setEditing] = useState<DictionaryReplacement | null>(null);
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const closeEditor = useCallback(() => setEditing(null), []);
  const ready = supported && connected && loaded;
  let unavailable = t("common.states.loading");
  if (!connected) unavailable = t("settings.dictionary.unavailable");
  else if (!supported) unavailable = t("settings.dictionary.unsupported");
  return (
    <>
      <SettingsSection
        title={t("settings.dictionary.title")}
        info={t("settings.dictionary.description")}
        testID="dictionary-settings"
      >
        {ready ? (
          <>
            <WordsCard form={form} state={state} dictionary={dictionary} save={save} size={size} />
            <ReplacementsCard
              form={form}
              state={state}
              dictionary={dictionary}
              save={save}
              size={size}
              onEdit={setEditing}
            />
          </>
        ) : (
          <SettingsCard>
            <SettingsRow label={unavailable} />
          </SettingsCard>
        )}
      </SettingsSection>
      {editing ? (
        <ReplacementEditModal
          key={editing.from}
          replacement={editing}
          dictionary={dictionary}
          save={save}
          size={size}
          onClose={closeEditor}
        />
      ) : null}
    </>
  );
}

interface CardProps {
  form: DictionaryForm;
  state: DictionaryFormState;
  dictionary: DictionaryEntries;
  save: SaveDictionary;
  size: FieldControlSize;
}

function WordsCard({ form, state, dictionary, save, size }: CardProps) {
  const { t } = useTranslation();
  const add = useCallback(() => {
    void form.addWord(dictionary, save);
  }, [form, dictionary, save]);
  const remove = useCallback(
    (word: string) => {
      void form.removeWord(dictionary, word, save);
    },
    [form, dictionary, save],
  );
  const error = scopedError(state, "word", t);
  return (
    <SettingsCard testID="dictionary-words">
      <SettingsRow label={t("settings.dictionary.words")} />
      {dictionary.words.length > 0 ? (
        <View style={[settingsStyles.row, styles.chips]}>
          {dictionary.words.map((word) => (
            <WordChip key={word} word={word} disabled={state.pending} onRemove={remove} />
          ))}
        </View>
      ) : (
        <View style={settingsStyles.row}>
          <Text style={styles.muted}>{t("settings.dictionary.wordsEmpty")}</Text>
        </View>
      )}
      <View style={styles.addRow}>
        <View style={styles.addLine}>
          <View style={styles.field}>
            <FormTextInput
              size={size}
              initialValue=""
              resetKey={state.wordResetKey}
              onChangeText={form.setWord}
              onSubmitEditing={add}
              submitBehavior="submit"
              placeholder={t("settings.dictionary.wordPlaceholder")}
              accessibilityLabel={t("settings.dictionary.wordPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              testID="dictionary-word-input"
            />
          </View>
          <Button
            variant="secondary"
            size={size}
            onPress={add}
            disabled={!state.canAddWord}
            testID="dictionary-word-add"
          >
            {t("settings.dictionary.add")}
          </Button>
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {error}
          </Text>
        ) : null}
      </View>
    </SettingsCard>
  );
}

function WordChip({
  word,
  disabled,
  onRemove,
}: {
  word: string;
  disabled: boolean;
  onRemove: (word: string) => void;
}) {
  const { t } = useTranslation();
  const remove = useCallback(() => onRemove(word), [onRemove, word]);
  return (
    <View style={styles.chip} testID={`dictionary-word-${word}`}>
      <Text style={styles.chipText} numberOfLines={1}>
        {word}
      </Text>
      <IconAction
        Icon={ThemedX}
        iconSize={ICON_SIZE.xs}
        label={t("settings.dictionary.removeWord", { word })}
        disabled={disabled}
        onPress={remove}
        testID={`dictionary-word-remove-${word}`}
      />
    </View>
  );
}

function ReplacementsCard({
  form,
  state,
  dictionary,
  save,
  size,
  onEdit,
}: CardProps & { onEdit: (replacement: DictionaryReplacement) => void }) {
  const { t } = useTranslation();
  const written = useRef<EditingTextInputHandle>(null);
  const add = useCallback(() => {
    void form.addReplacement(dictionary, save);
  }, [form, dictionary, save]);
  const remove = useCallback(
    (from: string) => {
      void form.removeReplacement(dictionary, from, save);
    },
    [form, dictionary, save],
  );
  const setFrom = useCallback((from: string) => form.setReplacement({ from }), [form]);
  const setTo = useCallback((to: string) => form.setReplacement({ to }), [form]);
  const focusWritten = useCallback(() => written.current?.focus(), []);
  const error = scopedError(state, "replacement", t);
  return (
    <SettingsCard testID="dictionary-replacements">
      <SettingsRow label={t("settings.dictionary.replacements")} />
      {dictionary.replacements.length === 0 ? (
        <View style={settingsStyles.row}>
          <Text style={styles.muted}>{t("settings.dictionary.replacementsEmpty")}</Text>
        </View>
      ) : null}
      {dictionary.replacements.map((replacement) => (
        <ReplacementRow
          key={replacement.from}
          replacement={replacement}
          disabled={state.pending}
          onEdit={onEdit}
          onRemove={remove}
        />
      ))}
      <View style={styles.addRow}>
        <View style={styles.addLine}>
          <View style={styles.field}>
            <FormTextInput
              size={size}
              initialValue=""
              resetKey={state.replacementResetKey}
              onChangeText={setFrom}
              onSubmitEditing={focusWritten}
              submitBehavior="submit"
              maxLength={DICTIONARY_LIMITS.termLength}
              placeholder={t("settings.dictionary.heard")}
              accessibilityLabel={t("settings.dictionary.heard")}
              autoCapitalize="none"
              autoCorrect={false}
              testID="dictionary-replacement-from"
            />
          </View>
          <ThemedArrowRight size={ICON_SIZE.sm} uniProps={mutedMapping} />
          <View style={styles.field}>
            <FormTextInput
              ref={written}
              size={size}
              initialValue=""
              resetKey={state.replacementResetKey}
              onChangeText={setTo}
              onSubmitEditing={add}
              submitBehavior="submit"
              maxLength={DICTIONARY_LIMITS.termLength}
              placeholder={t("settings.dictionary.written")}
              accessibilityLabel={t("settings.dictionary.written")}
              autoCapitalize="none"
              autoCorrect={false}
              testID="dictionary-replacement-to"
            />
          </View>
          <Button
            variant="secondary"
            size={size}
            onPress={add}
            disabled={!state.canAddReplacement}
            testID="dictionary-replacement-add"
          >
            {t("settings.dictionary.add")}
          </Button>
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {error}
          </Text>
        ) : null}
      </View>
    </SettingsCard>
  );
}

function ReplacementRow({
  replacement,
  disabled,
  onEdit,
  onRemove,
}: {
  replacement: DictionaryReplacement;
  disabled: boolean;
  onEdit: (replacement: DictionaryReplacement) => void;
  onRemove: (from: string) => void;
}) {
  const { t } = useTranslation();
  const edit = useCallback(() => onEdit(replacement), [onEdit, replacement]);
  const remove = useCallback(() => onRemove(replacement.from), [onRemove, replacement.from]);
  return (
    <View style={settingsStyles.row} testID={`dictionary-replacement-${replacement.from}`}>
      <View style={styles.pair}>
        <Text style={styles.term} numberOfLines={1}>
          {replacement.from}
        </Text>
        <ThemedArrowRight size={ICON_SIZE.sm} uniProps={mutedMapping} />
        <Text style={styles.term} numberOfLines={1}>
          {replacement.to}
        </Text>
      </View>
      <View style={styles.actions}>
        <IconAction
          Icon={ThemedPencil}
          iconSize={ICON_SIZE.sm}
          label={t("settings.dictionary.editNamed", { heard: replacement.from })}
          disabled={disabled}
          onPress={edit}
          testID={`dictionary-replacement-edit-${replacement.from}`}
        />
        <IconAction
          Icon={ThemedTrash2}
          iconSize={ICON_SIZE.sm}
          label={t("settings.dictionary.removeNamed", { heard: replacement.from })}
          disabled={disabled}
          onPress={remove}
          testID={`dictionary-replacement-remove-${replacement.from}`}
        />
      </View>
    </View>
  );
}

function IconAction({
  Icon,
  iconSize,
  label,
  disabled,
  onPress,
  testID,
}: {
  Icon: ThemedIcon;
  iconSize: number;
  label: string;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  const hitSlop = useTouchHitSlop(iconSize);
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.iconAction,
      pressed && styles.iconActionPressed,
      disabled && styles.disabled,
    ],
    [disabled],
  );
  const renderIcon = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }): ReactElement => (
      <Icon size={iconSize} uniProps={hovered ? foregroundMapping : mutedMapping} />
    ),
    [Icon, iconSize],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      style={pressableStyle}
      testID={testID}
    >
      {renderIcon}
    </Pressable>
  );
}

function ReplacementEditModal({
  replacement,
  dictionary,
  save,
  size,
  onClose,
}: {
  replacement: DictionaryReplacement;
  dictionary: DictionaryEntries;
  save: SaveDictionary;
  size: FieldControlSize;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [form] = useState(() => openReplacementForm(replacement));
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const written = useRef<EditingTextInputHandle>(null);
  const header = useMemo(() => ({ title: t("settings.dictionary.edit") }), [t]);
  const close = useCallback(() => {
    if (!state.submitting) onClose();
  }, [state.submitting, onClose]);
  const submit = useCallback(async () => {
    if (await form.submit(dictionary, save)) onClose();
  }, [form, dictionary, save, onClose]);
  const pressSubmit = useCallback(() => {
    void submit();
  }, [submit]);
  const setFrom = useCallback((from: string) => form.set({ from }), [form]);
  const setTo = useCallback((to: string) => form.set({ to }), [form]);
  const focusWritten = useCallback(() => written.current?.focus(), []);
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={480}
      testID="dictionary-replacement-editor"
    >
      <View style={styles.modalBody}>
        <Field label={t("settings.dictionary.heard")}>
          <FormTextInput
            size={size}
            initialValue={replacement.from}
            onChangeText={setFrom}
            onSubmitEditing={focusWritten}
            submitBehavior="submit"
            editable={!state.submitting}
            maxLength={DICTIONARY_LIMITS.termLength}
            accessibilityLabel={t("settings.dictionary.heard")}
            autoCapitalize="none"
            autoCorrect={false}
            testID="dictionary-replacement-editor-from"
          />
        </Field>
        <Field label={t("settings.dictionary.written")}>
          <FormTextInput
            ref={written}
            size={size}
            initialValue={replacement.to}
            onChangeText={setTo}
            onSubmitEditing={pressSubmit}
            editable={!state.submitting}
            maxLength={DICTIONARY_LIMITS.termLength}
            accessibilityLabel={t("settings.dictionary.written")}
            autoCapitalize="none"
            autoCorrect={false}
            testID="dictionary-replacement-editor-to"
          />
        </Field>
        {state.error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {errorMessage(state.error, t)}
          </Text>
        ) : null}
        <View style={styles.modalActions}>
          <Button variant="secondary" onPress={close} disabled={state.submitting}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onPress={pressSubmit}
            loading={state.submitting}
            disabled={!state.canSubmit}
            testID="dictionary-replacement-editor-save"
          >
            {t("settings.dictionary.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  chips: {
    flexWrap: "wrap",
    justifyContent: "flex-start",
    gap: theme.spacing[2],
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: "100%",
    minHeight: 28,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1.5],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  chipText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  addRow: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  addLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  field: {
    flex: 1,
    minWidth: 0,
  },
  pair: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginRight: theme.spacing[3],
  },
  term: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  iconAction: {
    alignItems: "center",
    justifyContent: "center",
  },
  iconActionPressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: theme.opacity[50],
  },
  modalBody: { gap: theme.spacing[4] },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
