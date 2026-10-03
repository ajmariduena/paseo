import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "@/components/settings";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { isNative } from "@/constants/platform";
import {
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  parseClampedFontSize,
  parseTerminalScrollbackLines,
  useAppSettings,
} from "@/hooks/use-settings";
import type { MacOptionAsMeta } from "@/terminal/runtime/terminal-mac-keys";
import { isMacUserAgent } from "@/utils/mac-user-agent";
import { settingsStyles } from "@/styles/settings";

export function TerminalSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const [scrollbackValue, setScrollbackValue] = useState(String(settings.terminalScrollbackLines));
  const [fontSizeValue, setFontSizeValue] = useState(String(settings.terminalFontSize));
  const showOptionAsMeta = !isNative && isMacUserAgent();

  const handleChangeText = useCallback((value: string) => {
    setScrollbackValue(value.replace(/[^\d]/g, ""));
  }, []);

  const commitScrollback = useCallback(() => {
    const nextValue =
      parseTerminalScrollbackLines(scrollbackValue) ?? settings.terminalScrollbackLines;
    setScrollbackValue(String(nextValue));
    if (nextValue !== settings.terminalScrollbackLines) {
      void updateSettings({ terminalScrollbackLines: nextValue });
    }
  }, [scrollbackValue, settings.terminalScrollbackLines, updateSettings]);

  const handleFontSizeChange = useCallback((value: string) => {
    setFontSizeValue(value.replace(/[^\d.]/g, ""));
  }, []);

  const commitFontSize = useCallback(() => {
    const nextValue =
      parseClampedFontSize(fontSizeValue, { min: MIN_CODE_FONT_SIZE, max: MAX_CODE_FONT_SIZE }) ??
      settings.terminalFontSize;
    setFontSizeValue(String(nextValue));
    if (nextValue !== settings.terminalFontSize) {
      void updateSettings({ terminalFontSize: nextValue });
    }
  }, [fontSizeValue, settings.terminalFontSize, updateSettings]);

  const optionAsMetaOptions = useMemo<SegmentedControlOption<MacOptionAsMeta>[]>(
    () => [
      { value: "both", label: t("settings.general.terminalOptionAsMeta.options.both") },
      { value: "left", label: t("settings.general.terminalOptionAsMeta.options.left") },
      { value: "right", label: t("settings.general.terminalOptionAsMeta.options.right") },
      { value: "off", label: t("settings.general.terminalOptionAsMeta.options.off") },
    ],
    [t],
  );

  const handleOptionAsMetaChange = useCallback(
    (value: MacOptionAsMeta) => {
      void updateSettings({ terminalMacOptionAsMeta: value });
    },
    [updateSettings],
  );

  useEffect(() => {
    setScrollbackValue(String(settings.terminalScrollbackLines));
  }, [settings.terminalScrollbackLines]);

  useEffect(() => {
    setFontSizeValue(String(settings.terminalFontSize));
  }, [settings.terminalFontSize]);

  return (
    <SettingsSection title={t("settings.sections.terminal")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.general.terminalFontSize.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.general.terminalFontSize.description")}
            </Text>
          </View>
          <FormTextInput
            size="sm"
            initialValue={fontSizeValue}
            onChangeText={handleFontSizeChange}
            onBlur={commitFontSize}
            onSubmitEditing={commitFontSize}
            keyboardType="decimal-pad"
            inputMode="decimal"
            selectTextOnFocus
            style={styles.numberInput}
            accessibilityLabel={t("settings.general.terminalFontSize.accessibilityLabel")}
          />
        </View>
        {showOptionAsMeta ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.general.terminalOptionAsMeta.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.general.terminalOptionAsMeta.description")}
              </Text>
            </View>
            <SegmentedControl
              options={optionAsMetaOptions}
              value={settings.terminalMacOptionAsMeta}
              onValueChange={handleOptionAsMetaChange}
              size="sm"
              testID="terminal-option-as-meta"
            />
          </View>
        ) : null}
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.general.terminalScrollback.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.general.terminalScrollback.description")}
            </Text>
          </View>
          <FormTextInput
            size="sm"
            initialValue={scrollbackValue}
            onChangeText={handleChangeText}
            onBlur={commitScrollback}
            onSubmitEditing={commitScrollback}
            keyboardType="number-pad"
            inputMode="numeric"
            selectTextOnFocus
            style={styles.numberInput}
            accessibilityLabel={t("settings.general.terminalScrollback.accessibilityLabel")}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  numberInput: {
    width: 112,
    textAlign: "right",
  },
});
