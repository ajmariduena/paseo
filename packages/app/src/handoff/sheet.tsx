import {
  handoffConversationMode,
  handoffContinuationSummary,
} from "@getpaseo/protocol/handoff-control";
import { isHandoffCancellationComplete } from "./persistence";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { handoffFormActions, type HandoffFormState, type HandoffFormInput } from "./form-model";
import { useHandoffForm } from "./use-handoff-form";
import { shortenPath } from "@/utils/shorten-path";

const TRANSFER_SNAP_POINTS = ["55%", "90%"];
const REVIEW_SNAP_POINTS = ["80%", "95%"];

interface Props extends HandoffFormInput {
  visible: boolean;
  active: boolean;
  onClose: () => void;
}

export function HandoffSheet(props: Props) {
  if (!props.visible || !props.active) return null;
  return (
    <OpenHandoffSheet
      key={JSON.stringify([props.sourceServerId, props.workspaceId, props.recovery?.transferId])}
      {...props}
    />
  );
}

function statusKey(state: Extract<HandoffFormState, { kind: "transfer" }>) {
  if (state.run.status === "running") return state.run.progress?.phase ?? "saving";
  if (state.record.snapshot?.state === "active") return "active";
  if (isHandoffCancellationComplete(state.record.snapshot)) return "cancelled";
  if (state.record.snapshot?.state === "cancelled") return "cancelPending";
  if (state.record.intent === "cancel") return "cancelPending";
  const forward =
    state.record.intent === "activate" ||
    state.record.snapshot?.state === "released" ||
    state.record.snapshot?.state === "activating";
  if (forward) return "forward";
  if (state.record.snapshot?.state === "staged") return "ready";
  return "paused";
}

function busyLabel(state: HandoffFormState) {
  if (state.kind === "recovering" && state.busy) return "loading";
  if (state.kind === "loading") return "loading";
  if (state.kind === "checking") return "reviewing";
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
    moreTransfers: t("handoff.resume"),
    review: t("handoff.review"),
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
  const returning = state.kind === "review" || state.kind === "recovering";
  const canReturn = returning && !(state.kind === "recovering" && state.busy);
  let fallback: keyof typeof labels = "review";
  if (state.kind === "review") fallback = "prepare";
  if (state.kind === "recovering") fallback = "retry";
  return (
    <View style={styles.actions}>
      {actions.canCancel || retainCancel || returning ? (
        <Button
          variant="secondary"
          style={styles.action}
          onPress={onCancel}
          disabled={!canReturn && !actions.canCancel}
          testID="handoff-cancel"
        >
          {returning ? t("common.back") : t("handoff.cancel")}
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
        {busy ? t(`handoff.busy.${busy}`) : labels[actions.primary ?? fallback]}
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
        <Text style={styles.value}>{t(`handoff.${handoffContinuationSummary(state.record)}`)}</Text>
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

function handoffSnapPoints(state: HandoffFormState) {
  if (state.kind === "transfer" || state.kind === "recovering") return TRANSFER_SNAP_POINTS;
  if (state.kind === "review") {
    return REVIEW_SNAP_POINTS;
  }
  return undefined;
}

function RecoveryTransfers({
  state,
  onSelect,
  onMore,
}: {
  state: Extract<HandoffFormState, { kind: "recovering" }>;
  onSelect: (id: string) => void;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const options = useMemo(
    () =>
      state.page.transfers.map((transfer) => ({
        id: transfer.transferId,
        value: transfer.transferId,
        label: t(`handoff.${handoffContinuationSummary(transfer)}`),
        description: shortenPath(transfer.destinationCwd),
        testID: `handoff-recovery-${transfer.transferId}`,
      })),
    [state.page.transfers, t],
  );
  return (
    <>
      <Field label={t("handoff.destination")}>
        <Text style={styles.value}>{state.draft.destination.label}</Text>
      </Field>
      <SelectField
        label={t("handoff.pendingTransfers")}
        placeholder={t("handoff.chooseTransfer")}
        emptyText={t("handoff.loading")}
        options={options}
        value={null}
        selectedDisplay={null}
        loading={state.busy}
        disabled={state.busy}
        onChange={onSelect}
        size={size}
        triggerTestID="handoff-recovery-trigger"
      />
      {state.page.nextCursor ? (
        <Button variant="ghost" disabled={state.busy} onPress={onMore}>
          {t("handoff.loadMoreTransfers")}
        </Button>
      ) : null}
      {state.error ? (
        <Text style={styles.error} accessibilityRole="alert" testID="handoff-error">
          {state.error}
        </Text>
      ) : null}
    </>
  );
}

function ConversationModeField({
  agentId,
  title,
  mode,
  options,
  onMode,
}: {
  agentId: string;
  title: string;
  mode: "native" | "context";
  options: SelectFieldOption<"native" | "context">[];
  onMode: (sourceAgentId: string, mode: "native" | "context") => void;
}) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const display = useMemo(
    () => ({ label: t(`handoff.${mode}`), description: t(`handoff.${mode}Description`) }),
    [mode, t],
  );
  const change = useCallback(
    (value: "native" | "context") => onMode(agentId, value),
    [agentId, onMode],
  );
  return (
    <SelectField
      label={title}
      value={mode}
      selectedDisplay={display}
      options={options}
      onChange={change}
      size={size}
      placeholder={t("handoff.mode")}
      emptyText=""
      triggerTestID={`handoff-conversation-mode-${agentId}`}
    />
  );
}

function ReviewConversations({
  state,
  options,
  onMode,
}: {
  state: Extract<HandoffFormState, { kind: "review" }>;
  options: SelectFieldOption<"native" | "context">[];
  onMode: (sourceAgentId: string, mode: "native" | "context") => void;
}) {
  const { t } = useTranslation();
  const individualChoices = state.preview.conversations.length > 1;
  return (
    <Field label={t("handoff.conversations")}>
      <View style={styles.status} testID="handoff-review">
        {state.preview.conversations.length === 0 ? (
          <Text style={styles.text}>{t("handoff.emptyConversations")}</Text>
        ) : null}
        {state.preview.conversations.map((conversation) => {
          const mode = handoffConversationMode(state.record, conversation.agentId);
          const availability = conversation[mode];
          const reason =
            availability.reason ?? (mode === "context" ? conversation.native.reason : null);
          const integrations = state.preview.integrationReview.find(
            (entry) => entry.agentId === conversation.agentId,
          );
          const omittedMcpServers = integrations?.omittedMcpServers ?? [];
          return (
            <View key={conversation.agentId} style={styles.status}>
              {individualChoices ? (
                <ConversationModeField
                  agentId={conversation.agentId}
                  title={conversation.title ?? t("handoff.untitledConversation")}
                  mode={mode}
                  options={options}
                  onMode={onMode}
                />
              ) : (
                <Text style={styles.value}>
                  {conversation.title ?? t("handoff.untitledConversation")}
                </Text>
              )}
              {reason || !individualChoices ? (
                <Text style={availability.available ? styles.text : styles.error}>
                  {reason ?? t(`handoff.${mode}`)}
                </Text>
              ) : null}
              {omittedMcpServers.length > 0 ? (
                <Text style={styles.text} testID="handoff-omitted-mcp">
                  {t("handoff.omittedMcpServers", { names: omittedMcpServers.join(", ") })}
                </Text>
              ) : null}
            </View>
          );
        })}
        {state.preview.conversations.length > 0 ? (
          <Text style={styles.text}>{t("handoff.integrationScope")}</Text>
        ) : null}
      </View>
    </Field>
  );
}

function ReviewOmissions({
  state,
  onPage,
}: {
  state: Extract<HandoffFormState, { kind: "review" }>;
  onPage: (offset: number) => void;
}) {
  const { t } = useTranslation();
  const { page, run } = state.omissions;
  const busy = run.status === "loading";
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const previous = useCallback(() => onPage(Math.max(0, page.offset - 50)), [onPage, page.offset]);
  const next = useCallback(() => {
    if (page.nextOffset !== null) onPage(page.nextOffset);
  }, [onPage, page.nextOffset]);
  const retry = useCallback(() => {
    if (run.status === "error") onPage(run.offset);
  }, [onPage, run]);
  return (
    <Field label={t("handoff.omittedPaths", { count: page.total })}>
      <View style={styles.status}>
        <View testID="handoff-omissions-review">
          {page.total === 0 ? <Text style={styles.text}>{t("handoff.noOmissions")}</Text> : null}
          {page.paths.map((entry) => (
            <Text key={entry} selectable style={styles.path}>
              {entry}
            </Text>
          ))}
        </View>
        {page.paths.some((entry) => entry.endsWith("/")) ? (
          <Text style={styles.text}>{t("handoff.omittedDirectories")}</Text>
        ) : null}
        {page.total > 50 ? (
          <>
            <Text style={styles.text} testID="handoff-omissions-range">
              {t("handoff.omissionRange", {
                first: page.offset + 1,
                last: page.offset + page.paths.length,
                total: page.total,
              })}
            </Text>
            <View style={styles.pagination}>
              <Button
                variant="ghost"
                size={size}
                disabled={busy || page.offset === 0}
                loading={run.status === "loading" && run.offset < page.offset}
                onPress={previous}
                testID="handoff-omissions-previous"
              >
                {t("handoff.previousOmissions")}
              </Button>
              <Button
                variant="ghost"
                size={size}
                disabled={busy || page.nextOffset === null}
                loading={run.status === "loading" && run.offset > page.offset}
                onPress={next}
                testID="handoff-omissions-next"
              >
                {t("handoff.nextOmissions")}
              </Button>
            </View>
          </>
        ) : null}
        {run.status === "error" ? (
          <>
            <Text style={styles.error} accessibilityRole="alert" testID="handoff-omissions-error">
              {run.message}
            </Text>
            <Button variant="ghost" size={size} onPress={retry} testID="handoff-omissions-retry">
              {t("common.actions.retry")}
            </Button>
          </>
        ) : null}
      </View>
    </Field>
  );
}

function ReviewWorkspace({
  state,
  onOmissionPage,
}: {
  state: Extract<HandoffFormState, { kind: "review" }>;
  onOmissionPage: (offset: number) => void;
}) {
  const { t } = useTranslation();
  const { workspace, stoppedWork, conversationBytes } = state.preview;
  const bytes = workspace.fileBytes + workspace.gitHistoryBytes + conversationBytes;
  const size =
    bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
  return (
    <>
      <Field label={t("handoff.dataEstimate")}>
        <View style={styles.status} testID="handoff-data-review">
          <Text style={styles.value}>{size}</Text>
          <Text style={styles.text}>
            {t("handoff.fileCounts", {
              files: workspace.fileCount,
              directories: workspace.directoryCount,
              links: workspace.symlinkCount,
            })}
          </Text>
          <Text style={styles.text}>{t("handoff.estimateNotice")}</Text>
        </View>
      </Field>
      <ReviewOmissions state={state} onPage={onOmissionPage} />
      {state.preview.unsavedFiles.length > 0 ? (
        <Field label={t("handoff.unsavedFiles")}>
          <View style={styles.status} testID="handoff-unsaved-files">
            {state.preview.unsavedFiles.map((file) => (
              <Text key={file} selectable style={styles.path}>
                {file}
              </Text>
            ))}
            <Text style={styles.text}>{t("handoff.saveBeforePrepare")}</Text>
          </View>
        </Field>
      ) : null}
      <Field label={t("handoff.workToStop")}>
        <View style={styles.status} testID="handoff-stopped-work-review">
          <Text style={styles.text}>
            {t("handoff.activeWork", {
              agents: stoppedWork.agentIds.length,
              setup: stoppedWork.setupOperations,
            })}
          </Text>
          {stoppedWork.terminals.length === 0 ? (
            <Text style={styles.text}>{t("handoff.noTerminals")}</Text>
          ) : null}
          {stoppedWork.terminals.map((terminal) => (
            <Text key={terminal.id} style={styles.value}>
              {terminal.name}
            </Text>
          ))}
          {stoppedWork.queuedMessages ? (
            <Text style={styles.text} testID="handoff-queue-review">
              {t("handoff.queuedMessagesHeld", { count: stoppedWork.queuedMessages })}
            </Text>
          ) : null}
          {stoppedWork.review?.pullRequestWatches?.length ? (
            <View style={styles.status} testID="handoff-pr-watches-review">
              <Text style={styles.text}>{t("handoff.prWatchesStop")}</Text>
              {stoppedWork.review.pullRequestWatches.map((watch) => (
                <Text key={watch.id} selectable style={styles.value}>
                  #{watch.number} · {watch.title}
                </Text>
              ))}
            </View>
          ) : null}
          {stoppedWork.review?.schedules?.length ? (
            <View style={styles.status} testID="handoff-schedules-review">
              <Text style={styles.text}>{t("handoff.automationPaused")}</Text>
              {stoppedWork.review.schedules.map((schedule) => (
                <View key={schedule.id} style={styles.status}>
                  <Text selectable style={styles.value}>
                    {schedule.name ?? schedule.id} · {schedule.cadence}
                  </Text>
                  {schedule.activeRun ? (
                    <Text style={styles.text} testID="handoff-active-heartbeat-review">
                      {t("handoff.activeHeartbeatStops")}
                    </Text>
                  ) : null}
                  {schedule.omittedSettings.length || schedule.omittedMcpServers.length ? (
                    <Text style={styles.text}>{t("handoff.automationSettingsOmitted")}</Text>
                  ) : null}
                  {schedule.omittedMcpServers.length ? (
                    <Text style={styles.text}>
                      {t("handoff.omittedMcpServers", {
                        names: schedule.omittedMcpServers.join(", "),
                      })}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </Field>
    </>
  );
}

function selectedContinuationMode(state: HandoffFormState) {
  if (state.kind === "review" && state.preview.conversations.length === 1)
    return handoffConversationMode(state.record, state.preview.conversations[0].agentId);
  return "draft" in state ? state.draft.continuationMode : "native";
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
  const cancel = useCallback(() => {
    if (state.kind === "review" || state.kind === "recovering") model.edit();
    else void model.cancel();
  }, [model, state.kind]);
  const setHost = useCallback(
    (serverId: string, display: SelectFieldDisplay) =>
      model.setDestination({ serverId, label: display.label }),
    [model],
  );
  const header = useMemo(() => ({ title: t("handoff.title") }), [t]);
  const draft =
    state.kind === "editing" || state.kind === "checking" || state.kind === "review"
      ? state.draft
      : null;
  const selectedMode = selectedContinuationMode(state);
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
      snapPoints={handoffSnapPoints(state)}
    >
      {state.kind === "loading" ? <Text style={styles.text}>{t("handoff.loading")}</Text> : null}
      {state.kind === "load_error" ? (
        <Text style={styles.error} accessibilityRole="alert">
          {state.message}
        </Text>
      ) : null}
      {draft ? (
        <>
          {state.kind === "review" ? (
            <>
              <Field label={t("handoff.destination")}>
                <Text style={styles.value}>{state.record.destinationLabel}</Text>
              </Field>
              <Field label={t("handoff.parent")}>
                <Text style={styles.path} selectable>
                  {state.record.destinationParent}
                </Text>
              </Field>
            </>
          ) : (
            <>
              <SelectField
                label={t("handoff.destination")}
                value={draft.destination?.serverId ?? null}
                selectedDisplay={draft.destination}
                disabled={state.kind !== "editing"}
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
                  editable={state.kind === "editing"}
                  onChangeText={model.setDestinationParent}
                  size={size}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="handoff-parent"
                />
              </Field>
            </>
          )}
          {state.kind !== "review" || state.preview.conversations.length === 1 ? (
            <SelectField
              label={t("handoff.mode")}
              value={selectedMode}
              disabled={state.kind === "checking"}
              selectedDisplay={modeDisplay}
              options={modeOptions}
              onChange={model.setContinuationMode}
              size={size}
              placeholder={t("handoff.mode")}
              emptyText=""
              triggerTestID="handoff-mode-trigger"
            />
          ) : null}
          {state.kind === "review" ? (
            <>
              <ReviewConversations
                state={state}
                options={modeOptions}
                onMode={model.setConversationMode}
              />
              <ReviewWorkspace state={state} onOmissionPage={model.listOmissions} />
            </>
          ) : null}
          <Text style={styles.text} testID="handoff-stop-notice">
            {t("handoff.stopNotice")}
          </Text>
          {state.kind === "editing" && state.error ? (
            <Text style={styles.error} accessibilityRole="alert" testID="handoff-error">
              {state.error}
            </Text>
          ) : null}
        </>
      ) : null}
      {state.kind === "transfer" ? <TransferSummary state={state} /> : null}
      {state.kind === "recovering" ? (
        <RecoveryTransfers
          state={state}
          onSelect={model.recoverTransfer}
          onMore={model.moreTransfers}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4] },
  actions: { flex: 1, flexDirection: "row", gap: theme.spacing[3] },
  action: { flex: 1 },
  pagination: { flexDirection: "row", gap: theme.spacing[3] },
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
