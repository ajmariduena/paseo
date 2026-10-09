import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldDisplay } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { handoffFormActions, type HandoffFormState } from "./form-model";
import type { HandoffOrigin } from "./persistence";
import { useHandoffForm } from "./use-handoff-form";

interface Props extends HandoffOrigin {
  visible: boolean;
  active: boolean;
  onClose: () => void;
}

export function HandoffSheet(props: Props) {
  if (!props.visible || !props.active) return null;
  return (
    <OpenHandoffSheet key={JSON.stringify([props.sourceServerId, props.workspaceId])} {...props} />
  );
}

function statusKey(state: Extract<HandoffFormState, { kind: "transfer" }>) {
  if (state.run.status === "running") return state.run.progress?.phase ?? "saving";
  if (state.record.snapshot?.state === "active") return "active";
  if (state.record.snapshot?.state === "cancelled") return "cancelled";
  const forward =
    state.record.intent === "activate" ||
    state.record.snapshot?.state === "released" ||
    state.record.snapshot?.state === "activating";
  if (forward) return "forward";
  if (state.record.snapshot?.state === "staged") return "ready";
  return "paused";
}

function OpenHandoffSheet(props: Props) {
  const { t } = useTranslation();
  const { model, state } = useHandoffForm(props);
  const hosts = useHosts();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const hostOptions = useMemo(
    () =>
      hosts
        .filter((host) => host.serverId !== props.sourceServerId)
        .map((host) => ({
          id: host.serverId,
          value: host.serverId,
          label: host.label,
          testID: `handoff-host-${host.serverId}`,
        })),
    [hosts, props.sourceServerId],
  );
  const modeOptions = useMemo(
    () => [
      { id: "native", value: "native" as const, label: t("handoff.native") },
      { id: "context", value: "context" as const, label: t("handoff.context") },
    ],
    [t],
  );
  const actions = handoffFormActions(state);
  const primary = actions.primary;
  const labels = useMemo(
    () => ({
      prepare: t("handoff.prepare"),
      activate: t("handoff.activate"),
      retry: t("handoff.resume"),
      load: t("handoff.resume"),
      open: t("handoff.open"),
      startOver: t("handoff.startOver"),
    }),
    [t],
  );
  const submit = useCallback(() => {
    if (!primary) return;
    if (primary === "open") {
      if (state.kind !== "transfer" || !state.record.snapshot) return;
      navigateToWorkspace({
        serverId: state.record.destinationServerId,
        workspaceId: state.record.snapshot.workspaceId,
      });
      props.onClose();
      return;
    }
    void model[primary]();
  }, [model, primary, props, state]);
  const cancel = useCallback(() => void model.cancel(), [model]);
  const setHost = useCallback(
    (serverId: string, display: SelectFieldDisplay) =>
      model.setDestination({ serverId, label: display.label }),
    [model],
  );
  const header = useMemo(() => ({ title: t("handoff.title") }), [t]);
  const selectedMode = state.kind === "editing" ? state.draft.continuationMode : "native";
  const modeDisplay = useMemo(() => ({ label: t(`handoff.${selectedMode}`) }), [selectedMode, t]);
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        {actions.canCancel ? (
          <Button variant="outline" onPress={cancel} testID="handoff-cancel">
            {t("handoff.cancel")}
          </Button>
        ) : null}
        {primary ? (
          <Button variant="default" onPress={submit} testID="handoff-submit">
            {labels[primary]}
          </Button>
        ) : null}
      </View>
    ),
    [actions.canCancel, cancel, primary, submit, t, labels],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={props.onClose}
      testID="handoff-sheet"
      footer={footer}
      contentStyle={styles.content}
    >
      {state.kind === "loading" ? <Text style={styles.text}>{t("handoff.loading")}</Text> : null}
      {state.kind === "checking" ? (
        <Text style={styles.text}>{t("handoff.inspecting")}</Text>
      ) : null}
      {state.kind === "load_error" ? (
        <Text style={styles.error} accessibilityRole="alert">
          {state.message}
        </Text>
      ) : null}
      {state.kind === "editing" ? (
        <>
          <SelectField
            label={t("handoff.destination")}
            value={state.draft.destination?.serverId ?? null}
            selectedDisplay={state.draft.destination}
            options={hostOptions}
            size={size}
            onChange={setHost}
            placeholder={t("handoff.chooseHost")}
            emptyText={t("handoff.noHosts")}
            testID="handoff-host"
            triggerTestID="handoff-host-trigger"
          />
          <Field label={t("handoff.parent")}>
            <FormTextInput
              initialValue={state.draft.destinationParent}
              onChangeText={model.setDestinationParent}
              size={size}
              autoCapitalize="none"
              autoCorrect={false}
              testID="handoff-parent"
            />
          </Field>
          <SelectField
            label={t("handoff.mode")}
            value={state.draft.continuationMode}
            selectedDisplay={modeDisplay}
            options={modeOptions}
            onChange={model.setContinuationMode}
            size={size}
            placeholder={t("handoff.mode")}
            emptyText=""
            triggerTestID="handoff-mode-trigger"
          />
          <Text style={styles.text}>{t(`handoff.${state.draft.continuationMode}Description`)}</Text>
          <Text style={styles.text}>{t("handoff.stopNotice")}</Text>
          {state.error ? (
            <Text style={styles.error} accessibilityRole="alert" testID="handoff-error">
              {state.error}
            </Text>
          ) : null}
        </>
      ) : null}
      {state.kind === "transfer" ? (
        <>
          <Text style={styles.title}>{state.record.destinationLabel}</Text>
          <Text style={styles.path} selectable>
            {state.record.snapshot?.destinationCwd ?? state.record.destinationParent}
          </Text>
          <Text style={styles.text}>{t(`handoff.${state.record.continuationMode}`)}</Text>
          <Text style={styles.text} testID="handoff-status" accessibilityLiveRegion="polite">
            {t(`handoff.${statusKey(state)}`)}
          </Text>
          {state.run.status === "running" && state.run.progress?.transfer ? (
            <Text style={styles.text}>
              {Math.floor(state.run.progress.transfer.receivedBytes / 1024)} /{" "}
              {Math.ceil(state.run.progress.transfer.totalBytes / 1024)} KiB
            </Text>
          ) : null}
          {state.run.status === "error" ? (
            <Text style={styles.error} accessibilityRole="alert" testID="handoff-error">
              {state.run.message}
            </Text>
          ) : null}
          <Text style={styles.text}>{t("handoff.closeNotice")}</Text>
        </>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4] },
  actions: { flexDirection: "row", gap: theme.spacing[2], justifyContent: "flex-end" },
  title: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  text: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  path: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  error: { fontSize: theme.fontSize.sm, color: theme.colors.destructive },
}));
