import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Zap } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  VoiceCommandsModel,
  VoiceCommandsSettings,
} from "@getpaseo/protocol/voice-commands/rpc-schemas";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import {
  CUSTOM_PROVIDER,
  formatRoundTripSeconds,
  getFooter,
  getKeyRows,
  getModelLabels,
  getRoundTripBadge,
  getTestTarget,
  groupOptions,
  type VoiceCommandsKeyRow,
} from "./catalog";
import { CustomEndpointDialog, KeyDialog } from "./dialogs";
import { openVoiceCommandsCard, type VoiceCommandsApi } from "./form";
import { ModelPicker, type ModelPickerExtra } from "./model-picker";
import { useVoiceCommands, type VoiceCommandsLoadState } from "./use-voice-commands";

const KEY_MASK = "••••••••••••";

type VoiceCommandsCard = ReturnType<typeof openVoiceCommandsCard>;
type VoiceCommandsCardState = ReturnType<VoiceCommandsCard["getState"]>;

/** Captured when the dialog opens, so live settings never rewrite what the user is editing. */
type DialogSnapshot =
  | { kind: "key"; provider: string; label: string; hasKey: boolean }
  | { kind: "custom"; baseUrl: string; model: string; hasKey: boolean };

export function VoiceCommandsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { state, api, retry } = useVoiceCommands(serverId);
  const [card] = useState(openVoiceCommandsCard);
  const cardState = useSyncExternalStore(card.subscribe, card.getState, card.getState);
  const [dialog, setDialog] = useState<DialogSnapshot | null>(null);
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const closeDialog = useCallback(() => setDialog(null), []);
  const handleSaved = useCallback(() => {
    card.reset();
    setDialog(null);
  }, [card]);
  return (
    <>
      <SettingsSection
        title={t("settings.voiceCommands.title")}
        info={t("settings.voiceCommands.description")}
        testID="voice-commands-settings"
      >
        {state.status === "ready" ? (
          <ModelCard
            settings={state.settings}
            card={card}
            cardState={cardState}
            api={api}
            size={size}
            onOpenDialog={setDialog}
          />
        ) : (
          <UnavailableCard state={state} size={size} onRetry={retry} />
        )}
      </SettingsSection>
      {dialog?.kind === "key" ? (
        <KeyDialog
          key={dialog.provider}
          provider={dialog.provider}
          providerLabel={dialog.label}
          hasKey={dialog.hasKey}
          api={api}
          size={size}
          onSaved={handleSaved}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "custom" ? (
        <CustomEndpointDialog
          baseUrl={dialog.baseUrl}
          model={dialog.model}
          hasKey={dialog.hasKey}
          api={api}
          size={size}
          onSaved={handleSaved}
          onClose={closeDialog}
        />
      ) : null}
    </>
  );
}

function UnavailableCard({
  state,
  size,
  onRetry,
}: {
  state: Exclude<VoiceCommandsLoadState, { status: "ready" }>;
  size: FieldControlSize;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (state.status === "error") {
    return (
      <SettingsCard>
        <SettingsRow label={t("settings.voiceCommands.loadFailed")} error={state.message}>
          <Button variant="outline" size={size} onPress={onRetry}>
            {t("common.actions.retry")}
          </Button>
        </SettingsRow>
      </SettingsCard>
    );
  }
  let label = t("common.states.loading");
  if (state.status === "disconnected") label = t("settings.voiceCommands.unavailable");
  else if (state.status === "unsupported") label = t("settings.voiceCommands.unsupported");
  return (
    <SettingsCard>
      <SettingsRow label={label} testID={`voice-commands-${state.status}`} />
    </SettingsCard>
  );
}

interface ModelCardProps {
  settings: VoiceCommandsSettings;
  card: VoiceCommandsCard;
  cardState: VoiceCommandsCardState;
  api: VoiceCommandsApi;
  size: FieldControlSize;
  onOpenDialog: (dialog: DialogSnapshot) => void;
}

function ModelCard({ settings, card, cardState, api, size, onOpenDialog }: ModelCardProps) {
  const { t } = useTranslation();
  const { selection, backup } = settings;
  const groups = useMemo(() => groupOptions(settings), [settings]);
  const [selectionKey, backupKey] = useMemo(() => getKeyRows(settings), [settings]);
  const custom = settings.providers.find((provider) => provider.id === CUSTOM_PROVIDER);
  const isCustom = selection?.provider === CUSTOM_PROVIDER;
  const customModel = isCustom ? selection.model : "";

  const chooseSelection = useCallback(
    (model: VoiceCommandsModel | null) => {
      void card.choose("selection", model, api);
    },
    [card, api],
  );
  const chooseBackup = useCallback(
    (model: VoiceCommandsModel | null) => {
      void card.choose("backup", model, api);
    },
    [card, api],
  );
  const openCustom = useCallback(
    () =>
      onOpenDialog({
        kind: "custom",
        baseUrl: custom?.baseUrl ?? "",
        model: customModel,
        hasKey: custom?.hasKey === true,
      }),
    [onOpenDialog, custom, customModel],
  );
  const openKey = useCallback(
    (row: VoiceCommandsKeyRow) =>
      onOpenDialog({ kind: "key", provider: row.provider, label: row.label, hasKey: row.hasKey }),
    [onOpenDialog],
  );

  const selectionExtras = useMemo<ModelPickerExtra[]>(
    () => [
      {
        id: "custom",
        label: t("settings.voiceCommands.customEndpoint"),
        description: t("settings.voiceCommands.customEndpointHint"),
        selected: isCustom,
        onSelect: openCustom,
      },
      {
        id: "agent-only",
        label: t("settings.voiceCommands.agentOnly"),
        selected: selection === null,
        onSelect: () => chooseSelection(null),
      },
    ],
    [t, isCustom, openCustom, selection, chooseSelection],
  );
  const backupExtras = useMemo<ModelPickerExtra[]>(
    () => [
      {
        id: "none",
        label: t("settings.voiceCommands.none"),
        selected: backup === null,
        onSelect: () => chooseBackup(null),
      },
    ],
    [t, backup, chooseBackup],
  );

  const busy = cardState.saving !== null;
  return (
    <SettingsCard testID="voice-commands-card">
      <PickerRow label={t("settings.voiceCommands.model")} size={size}>
        <ModelPicker
          label={t("settings.voiceCommands.model")}
          display={
            selection
              ? getModelLabels(settings, selection).model
              : t("settings.voiceCommands.agentOnly")
          }
          groups={groups}
          value={selection}
          extras={selectionExtras}
          disabled={busy}
          loading={cardState.saving === "selection"}
          size={size}
          onSelect={chooseSelection}
          testID="voice-commands-model"
        />
      </PickerRow>
      {isCustom ? (
        <ValueRow
          label={t("settings.voiceCommands.endpoint")}
          value={custom?.baseUrl || t("settings.voiceCommands.notSet")}
          mono={Boolean(custom?.baseUrl)}
          action={t("settings.voiceCommands.change")}
          size={size}
          onPress={openCustom}
          testID="voice-commands-endpoint"
        />
      ) : null}
      {selectionKey ? <KeyRow row={selectionKey} size={size} onEdit={openKey} /> : null}
      {selection ? (
        <PickerRow
          label={t("settings.voiceCommands.backup")}
          hint={t("settings.voiceCommands.backupHint")}
          size={size}
        >
          <ModelPicker
            label={t("settings.voiceCommands.backup")}
            display={
              backup ? getModelLabels(settings, backup).model : t("settings.voiceCommands.none")
            }
            groups={groups}
            value={backup}
            extras={backupExtras}
            disabled={busy}
            loading={cardState.saving === "backup"}
            size={size}
            onSelect={chooseBackup}
            testID="voice-commands-backup"
          />
        </PickerRow>
      ) : null}
      {backupKey ? <KeyRow row={backupKey} size={size} onEdit={openKey} /> : null}
      <FooterRow settings={settings} card={card} cardState={cardState} api={api} size={size} />
    </SettingsCard>
  );
}

/** On compact the picker takes the full row under its label, so long model names stay readable. */
function PickerRow({
  label,
  hint,
  size,
  children,
}: {
  label: string;
  hint?: string;
  size: FieldControlSize;
  children: ReactNode;
}) {
  if (size === "sm") {
    return (
      <SettingsRow label={label} hint={hint}>
        <View style={styles.picker}>{children}</View>
      </SettingsRow>
    );
  }
  return (
    <View style={[settingsStyles.row, styles.stackedRow]}>
      <View>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        {hint ? <Text style={settingsStyles.rowHint}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function KeyRow({
  row,
  size,
  onEdit,
}: {
  row: VoiceCommandsKeyRow;
  size: FieldControlSize;
  onEdit: (row: VoiceCommandsKeyRow) => void;
}) {
  const { t } = useTranslation();
  const edit = useCallback(() => onEdit(row), [onEdit, row]);
  return (
    <ValueRow
      label={t("settings.voiceCommands.apiKey", { provider: row.label })}
      hint={row.optional ? t("settings.voiceCommands.optional") : undefined}
      value={row.hasKey ? KEY_MASK : t("settings.voiceCommands.notSet")}
      mono={row.hasKey}
      action={row.hasKey ? t("settings.voiceCommands.change") : t("settings.voiceCommands.addKey")}
      size={size}
      onPress={edit}
      testID={`voice-commands-key-${row.provider}`}
    />
  );
}

function ValueRow({
  label,
  hint,
  value,
  mono,
  action,
  size,
  onPress,
  testID,
}: {
  label: string;
  hint?: string;
  value: string;
  mono: boolean;
  action: string;
  size: FieldControlSize;
  onPress: () => void;
  testID: string;
}) {
  return (
    <SettingsRow label={label} hint={hint} testID={testID}>
      <View style={styles.inline}>
        <Text style={mono ? styles.mono : styles.value} numberOfLines={1}>
          {value}
        </Text>
        <Button variant="outline" size={size} onPress={onPress} testID={`${testID}-action`}>
          {action}
        </Button>
      </View>
    </SettingsRow>
  );
}

function FooterRow({
  settings,
  card,
  cardState,
  api,
  size,
}: {
  settings: VoiceCommandsSettings;
  card: VoiceCommandsCard;
  cardState: VoiceCommandsCardState;
  api: VoiceCommandsApi;
  size: FieldControlSize;
}) {
  const { t, i18n } = useTranslation();
  const footer = getFooter(settings);
  const target = getTestTarget(settings);
  const { test } = cardState;
  const badge = getRoundTripBadge(settings, {
    failed: test.status === "failed",
    roundTripMs: test.status === "passed" ? test.roundTripMs : null,
  });
  const runTest = useCallback(() => {
    if (target) void card.test(target, api);
  }, [card, target, api]);
  const error =
    cardState.error ?? (test.status === "failed" ? t("settings.voiceCommands.testFailed") : null);
  return (
    <View style={settingsStyles.row} testID="voice-commands-footer">
      <View style={styles.footerContent}>
        <View style={styles.activeLine}>
          <Text style={styles.activeText}>
            {footer.active
              ? t("settings.voiceCommands.active", { ...footer.active })
              : t("settings.voiceCommands.agentFallback")}
          </Text>
          {badge ? (
            <StatusBadge
              size="xs"
              variant={badge.kind === "failed" ? "error" : badge.tone}
              label={
                badge.kind === "failed"
                  ? t("settings.voiceCommands.noReply")
                  : t("settings.voiceCommands.roundTrip", {
                      seconds: formatRoundTripSeconds(badge.ms, i18n.language),
                    })
              }
            />
          ) : null}
        </View>
        {footer.missingKey ? (
          <Text style={settingsStyles.rowHint}>
            {t("settings.voiceCommands.missingKey", { ...footer.missingKey })}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {error}
          </Text>
        ) : null}
      </View>
      {target ? (
        <TestButton
          testing={test.status === "testing"}
          disabled={cardState.saving !== null}
          size={size}
          onPress={runTest}
        />
      ) : null}
    </View>
  );
}

/** Keeps the width of its longer label, so "Testing..." does not push the footer around. */
function TestButton({
  testing,
  disabled,
  size,
  onPress,
}: {
  testing: boolean;
  disabled: boolean;
  size: FieldControlSize;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const idle = t("settings.voiceCommands.test");
  const busy = t("settings.voiceCommands.testing");
  return (
    <View style={styles.testSlot}>
      <View
        style={styles.testSizer}
        pointerEvents="none"
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Button variant="ghost" size={size} leftIcon={Zap} disabled>
          {busy.length >= idle.length ? busy : idle}
        </Button>
      </View>
      <Button
        variant="ghost"
        size={size}
        leftIcon={Zap}
        loading={testing}
        disabled={disabled}
        onPress={onPress}
        style={styles.testButton}
        testID="voice-commands-test"
      >
        {testing ? busy : idle}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  picker: {
    minWidth: 240,
  },
  stackedRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[3],
  },
  inline: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flexShrink: 1,
    minWidth: 0,
  },
  value: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  mono: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  footerContent: {
    flex: 1,
    minWidth: 0,
    marginRight: theme.spacing[3],
  },
  activeLine: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  activeText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  testSlot: {
    position: "relative",
  },
  testSizer: {
    opacity: 0,
  },
  testButton: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: "flex-end",
  },
}));
