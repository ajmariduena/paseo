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
import { shortenPath } from "@/utils/shorten-path";

const TRANSFER_SNAP_POINTS = ["55%", "90%"];

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

function busyLabel(state: HandoffFormState) {
  if (state.kind === "loading") return "loading";
  if (state.kind === "checking") return "preparing";
  if (state.kind !== "transfer" || state.run.status !== "running") return null;
  return { prepare: "preparing", activate: "moving", cancel: "cancelling" }[state.record.intent] as
    | "preparing"
    | "moving"
    | "cancelling";
}

function HandoffFooter({
  state,
  onSubmit,
  onCancel,
}: {
  state: HandoffFormState;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const actions = handoffFormActions(state);
  const busy = busyLabel(state);
  const labels = {
    prepare: t("handoff.prepare"),
    activate: t("handoff.activate"),
    retry: t("handoff.resume"),
    load: t("handoff.resume"),
    open: t("handoff.open"),
    startOver: t("handoff.startOver"),
  };
  const retainCancel =
    state.kind === "transfer" &&
    state.run.status === "running" &&
    state.record.snapshot?.state === "staged";
  return (
    <View style={styles.actions}>
      {actions.canCancel || retainCancel ? (
        <Button
          variant="secondary"
          style={styles.action}
          onPress={onCancel}
          disabled={!actions.canCancel}
          testID="handoff-cancel"
        >
          {t("handoff.cancel")}
        </Button>
      ) : null}
      <Button
        variant="default"
        style={styles.action}
        onPress={onSubmit}
        disabled={!actions.primary}
        loading={busy !== null}
        testID="handoff-submit"
      >
        {busy ? t(`handoff.busy.${busy}`) : labels[actions.primary ?? "prepare"]}
      </Button>
    </View>
  );
}

function TransferSummary({ state }: { state: Extract<HandoffFormState, { kind: "transfer" }> }) {
  const { t } = useTranslation();
  const status = statusKey(state);
  const showCloseNotice =
    state.run.status === "running" || state.run.status === "error" || status === "paused";
  return (
    <>
      <Field label={t("handoff.destination")}>
        <Text style={styles.value}>{state.record.destinationLabel}</Text>
      </Field>
      <Field label={t(state.record.snapshot ? "handoff.location" : "handoff.parent")}>
        <Text style={styles.path} selectable>
          {shortenPath(state.record.snapshot?.destinationCwd ?? state.record.destinationParent)}
        </Text>
      </Field>
      <Field label={t("handoff.mode")}>
        <Text style={styles.value}>{t(`handoff.${state.record.continuationMode}`)}</Text>
      </Field>
      <View style={styles.status}>
        <Text style={styles.value} testID="handoff-status" accessibilityLiveRegion="polite">
          {t(`handoff.${status}`)}
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
        {showCloseNotice ? (
          <Text style={styles.text} testID="handoff-close-notice">
            {t("handoff.closeNotice")}
          </Text>
        ) : null}
      </View>
    </>
  );
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
  const draft = state.kind === "editing" || state.kind === "checking" ? state.draft : null;
  const selectedMode = draft?.continuationMode ?? "native";
  const modeDisplay = useMemo(
    () => ({
      label: t(`handoff.${selectedMode}`),
      description: t(`handoff.${selectedMode}Description`),
    }),
    [selectedMode, t],
  );
  const footer = useMemo(
    () => <HandoffFooter state={state} onSubmit={submit} onCancel={cancel} />,
    [state, submit, cancel],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={props.onClose}
      testID="handoff-sheet"
      footer={footer}
      contentStyle={styles.content}
      snapPoints={state.kind === "transfer" ? TRANSFER_SNAP_POINTS : undefined}
    >
      {state.kind === "loading" ? <Text style={styles.text}>{t("handoff.loading")}</Text> : null}
      {state.kind === "load_error" ? (
        <Text style={styles.error} accessibilityRole="alert">
          {state.message}
        </Text>
      ) : null}
      {draft ? (
        <>
          <SelectField
            label={t("handoff.destination")}
            value={draft.destination?.serverId ?? null}
            selectedDisplay={draft.destination}
            disabled={state.kind === "checking"}
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
              initialValue={draft.destinationParent}
              editable={state.kind !== "checking"}
              onChangeText={model.setDestinationParent}
              size={size}
              autoCapitalize="none"
              autoCorrect={false}
              testID="handoff-parent"
            />
          </Field>
          <SelectField
            label={t("handoff.mode")}
            value={draft.continuationMode}
            disabled={state.kind === "checking"}
            selectedDisplay={modeDisplay}
            options={modeOptions}
            onChange={model.setContinuationMode}
            size={size}
            placeholder={t("handoff.mode")}
            emptyText=""
            triggerTestID="handoff-mode-trigger"
          />
          <Text style={styles.text}>{t("handoff.stopNotice")}</Text>
          {state.kind === "editing" && state.error ? (
            <Text style={styles.error} accessibilityRole="alert" testID="handoff-error">
              {state.error}
            </Text>
          ) : null}
        </>
      ) : null}
      {state.kind === "transfer" ? <TransferSummary state={state} /> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4] },
  actions: { flex: 1, flexDirection: "row", gap: theme.spacing[3] },
  action: { flex: 1 },
  status: { gap: theme.spacing[2] },
  value: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  text: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  path: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  error: { fontSize: theme.fontSize.sm, color: theme.colors.palette.red[300] },
}));
