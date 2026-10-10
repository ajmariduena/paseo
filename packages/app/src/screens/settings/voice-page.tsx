import { Play } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { DictionarySection } from "@/dictionary/settings-section";
import { VoiceCommandsSection } from "@/voice-commands/settings-section";
import { OnTheGoSettingsSection } from "@/voice-chat/on-the-go/settings-section";
import { isNative } from "@/constants/platform";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE } from "@/styles/theme";
import { settingsStyles } from "@/styles/settings";
import { DictationSettingsSection } from "./dictation-settings";

type ElevenLabsModel =
  | "eleven_flash_v2_5"
  | "eleven_multilingual_v2"
  | "eleven_v4"
  | "eleven_v4_turbo";
type Delivery = "expressive" | "natural" | "stable";

export function VoicePage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const capability = useSessionStore(
    useCallback(
      (state) => state.sessions[serverId]?.serverInfo?.capabilities?.readAloud,
      [serverId],
    ),
  );
  const snapshot = useProvidersSnapshot(serverId);
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const [draftEnabled, setEnabled] = useState<boolean | null>(null);
  const enabled = draftEnabled ?? capability?.enabled ?? false;
  const [model, setModel] = useState<ElevenLabsModel>("eleven_v4_turbo");
  const [delivery, setDelivery] = useState<Delivery>("natural");
  const [rewriteEnabled, setRewriteEnabled] = useState(true);
  const [rewriteProvider, setRewriteProvider] = useState<{ provider: string; model: string }>({
    provider: "",
    model: "",
  });

  const modelOptions = useMemo<SelectFieldOption<ElevenLabsModel>[]>(
    () => [
      {
        id: "eleven_v4_turbo",
        value: "eleven_v4_turbo",
        label: "Eleven v4 Turbo",
        description: t("settings.readAloud.models.v4Turbo"),
      },
      {
        id: "eleven_v4",
        value: "eleven_v4",
        label: "Eleven v4",
        description: t("settings.readAloud.models.v4"),
      },
      {
        id: "eleven_flash_v2_5",
        value: "eleven_flash_v2_5",
        label: "Flash v2.5",
        description: t("settings.readAloud.models.flash"),
      },
      {
        id: "eleven_multilingual_v2",
        value: "eleven_multilingual_v2",
        label: "Multilingual v2",
        description: t("settings.readAloud.models.multilingual"),
      },
    ],
    [t],
  );
  const deliveryOptions = useMemo(
    () => [
      { value: "expressive" as const, label: t("settings.readAloud.deliveryExpressive") },
      { value: "natural" as const, label: t("settings.readAloud.deliveryNatural") },
      { value: "stable" as const, label: t("settings.readAloud.deliveryStable") },
    ],
    [t],
  );
  const selectedModel = modelOptions.find((option) => option.value === model);
  const selectedModelDisplay = useMemo(
    () => (selectedModel ? { label: selectedModel.label } : null),
    [selectedModel],
  );
  const handleRewriteModelSelect = useCallback((provider: AgentProvider, next: string) => {
    setRewriteProvider({ provider, model: next });
  }, []);
  const playIcon = useMemo(() => <Play size={ICON_SIZE.sm} color={styles.iconColor.color} />, []);

  return (
    <View>
      <DictationSettingsSection serverId={serverId} />
      <DictionarySection key={serverId} serverId={serverId} />
      <VoiceCommandsSection key={serverId} serverId={serverId} />
      {isNative ? <OnTheGoSettingsSection /> : null}
      <SettingsSection
        title={t("settings.readAloud.title")}
        info={t("settings.readAloud.description")}
        testID="read-aloud-settings"
      >
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.readAloud.enabled")}</Text>
              {capability && !capability.enabled && capability.reason ? (
                <Text style={settingsStyles.rowHint}>{capability.reason}</Text>
              ) : null}
            </View>
            <Switch
              value={enabled}
              onValueChange={setEnabled}
              accessibilityLabel={t("settings.readAloud.enabled")}
            />
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.readAloud.apiKey")}</Text>
            </View>
            <View style={styles.inline}>
              <Text style={styles.secret}>
                {capability?.enabled ? "••••••••••••" : t("settings.readAloud.apiKeyMissing")}
              </Text>
              <Button variant="secondary" size="sm">
                {t("settings.readAloud.change")}
              </Button>
            </View>
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.readAloud.voiceTitle")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.readAloud.model")}</Text>
            </View>
            <View style={styles.control}>
              <SelectField
                label={t("settings.readAloud.model")}
                field={false}
                size="sm"
                value={model}
                selectedDisplay={selectedModelDisplay}
                options={modelOptions}
                onChange={setModel}
                placeholder={t("settings.readAloud.model")}
                emptyText={t("settings.readAloud.model")}
              />
            </View>
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.readAloud.voice")}</Text>
              <Text style={settingsStyles.rowHint}>{t("settings.readAloud.voiceNone")}</Text>
            </View>
            <View style={styles.inline}>
              <Button variant="ghost" size="sm" leftIcon={playIcon}>
                {t("settings.readAloud.testVoice")}
              </Button>
              <Button variant="secondary" size="sm">
                {t("settings.readAloud.chooseVoice")}
              </Button>
            </View>
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.readAloud.delivery")}</Text>
            </View>
            <SegmentedControl
              options={deliveryOptions}
              value={delivery}
              onValueChange={setDelivery}
              size="sm"
            />
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.readAloud.rewriteTitle")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.readAloud.rewriteEnabled")}</Text>
            </View>
            <Switch
              value={rewriteEnabled}
              onValueChange={setRewriteEnabled}
              accessibilityLabel={t("settings.readAloud.rewriteEnabled")}
            />
          </View>
          {rewriteEnabled ? (
            <>
              <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
                <View style={settingsStyles.rowContent}>
                  <Text style={settingsStyles.rowTitle}>
                    {t("settings.readAloud.rewriteModel")}
                  </Text>
                </View>
                <CombinedModelSelector
                  providers={providers}
                  selectedProvider={rewriteProvider.provider}
                  selectedModel={rewriteProvider.model}
                  onSelect={handleRewriteModelSelect}
                  isLoading={snapshot.isLoading || snapshot.isFetching}
                  serverId={serverId}
                  desktopPlacement="bottom-start"
                  desktopMinWidth={360}
                />
              </View>
              <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
                <View style={settingsStyles.rowContent}>
                  <Text style={settingsStyles.rowTitle}>{t("settings.readAloud.style")}</Text>
                </View>
                <FormTextInput
                  size="sm"
                  placeholder={t("settings.readAloud.stylePlaceholder")}
                  style={styles.styleInput}
                  accessibilityLabel={t("settings.readAloud.style")}
                />
              </View>
            </>
          ) : null}
        </View>
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inline: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  control: {
    minWidth: 220,
  },
  secret: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  styleInput: {
    width: 300,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
}));
