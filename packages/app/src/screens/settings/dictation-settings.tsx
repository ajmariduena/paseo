import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import {
  findActiveDictationOption,
  getDictationChoiceKey,
  getDictationLanguageName,
  listDictationLanguages,
  type DictationModelChoice,
} from "@/utils/dictation-selection";

export function DictationSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const selection = useSessionStore(
    useCallback(
      (state) => state.sessions[serverId]?.serverInfo?.capabilities?.dictationStt,
      [serverId],
    ),
  );
  const { patchConfig } = useDaemonConfig(serverId);
  const mutation = useMutation({
    mutationFn: async (stt: { provider?: string; model?: string; language?: string }) => {
      const result = await patchConfig({ dictation: { stt } });
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });

  const modelOptions = useMemo<SelectFieldOption<DictationModelChoice>[]>(
    () =>
      (selection?.options ?? [])
        .filter((option) => option.available)
        .map((option) => {
          const choice = { provider: option.provider, model: option.model };
          const entry: SelectFieldOption<DictationModelChoice> = {
            id: getDictationChoiceKey(choice),
            value: choice,
            label: option.label,
          };
          if (option.provider === "local") {
            entry.description = option.downloaded
              ? t("settings.dictation.downloaded")
              : t("settings.dictation.downloadOnSelect");
          } else if (option.description) {
            entry.description = option.description;
          }
          return entry;
        }),
    [selection, t],
  );
  const unavailableOptions = useMemo(
    () => (selection?.options ?? []).filter((option) => !option.available),
    [selection],
  );
  const languageOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      listDictationLanguages(selection?.language ?? "en").map((code) => ({
        id: code,
        value: code,
        label: getDictationLanguageName(code),
      })),
    [selection?.language],
  );

  const handleModelChange = useCallback(
    (choice: DictationModelChoice) => {
      mutation.mutate({ provider: choice.provider, model: choice.model });
    },
    [mutation],
  );
  const handleLanguageChange = useCallback(
    (language: string) => {
      mutation.mutate({ language });
    },
    [mutation],
  );

  const activeOption = selection ? findActiveDictationOption(selection) : undefined;
  const activeLabel = activeOption?.label ?? selection?.model ?? "";
  const activeChoice = useMemo<DictationModelChoice | null>(
    () => (selection ? { provider: selection.provider, model: selection.model } : null),
    [selection],
  );
  const modelDisplay = useMemo(() => (activeLabel ? { label: activeLabel } : null), [activeLabel]);
  const languageDisplay = useMemo(
    () => (selection ? { label: getDictationLanguageName(selection.language) } : null),
    [selection],
  );
  const disabled = !selection || selection.locked === true || mutation.isPending;

  return (
    <SettingsSection
      title={t("settings.dictation.title")}
      info={t("settings.dictation.description")}
      testID="dictation-settings"
    >
      <View style={settingsStyles.card}>
        {selection ? null : (
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>{t("settings.dictation.updateHost")}</Text>
          </View>
        )}
        {selection ? (
          <>
            <View style={settingsStyles.row}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>{t("settings.dictation.model")}</Text>
                <Text style={settingsStyles.rowHint}>{t("settings.dictation.modelHint")}</Text>
                {unavailableOptions.map((option) => (
                  <Text key={getDictationChoiceKey(option)} style={settingsStyles.rowHint}>
                    {`${option.label}: ${option.unavailableReason ?? t("settings.dictation.unavailable")}`}
                  </Text>
                ))}
              </View>
              <View style={styles.control}>
                <SelectField
                  label={t("settings.dictation.model")}
                  field={false}
                  size="sm"
                  value={activeChoice}
                  getValueKey={getDictationChoiceKey}
                  selectedDisplay={modelDisplay}
                  options={modelOptions}
                  onChange={handleModelChange}
                  disabled={disabled}
                  placeholder={t("settings.dictation.model")}
                  emptyText={t("settings.dictation.unavailable")}
                  testID="dictation-model-select"
                />
              </View>
            </View>
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>{t("settings.dictation.language")}</Text>
                <Text style={settingsStyles.rowHint}>{t("settings.dictation.languageHint")}</Text>
              </View>
              <View style={styles.control}>
                <SelectField
                  label={t("settings.dictation.language")}
                  field={false}
                  size="sm"
                  value={selection.language}
                  selectedDisplay={languageDisplay}
                  options={languageOptions}
                  onChange={handleLanguageChange}
                  disabled={disabled}
                  placeholder={t("settings.dictation.language")}
                  emptyText={t("settings.dictation.language")}
                  testID="dictation-language-select"
                />
              </View>
            </View>
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <Text style={settingsStyles.rowHint}>
                {selection.locked
                  ? t("settings.dictation.locked")
                  : t("settings.dictation.active", {
                      model: activeLabel,
                      language: getDictationLanguageName(selection.language),
                    })}
              </Text>
              {mutation.error ? (
                <Text style={settingsStyles.rowError}>{t("settings.dictation.saveFailed")}</Text>
              ) : null}
            </View>
          </>
        ) : null}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create(() => ({
  control: {
    minWidth: 240,
  },
}));
