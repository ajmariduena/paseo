import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useFetchQuery } from "@/data/query";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { mapRenderTheme, type RenderTheme } from "./document";
import { RenderExpandControl } from "./card";
import { HtmlRenderFrame } from "./frame";
import { HtmlRenderViewer } from "./viewer";
import { followUpConfirmationMessage, performVisualizationFollowUp } from "./follow-up";
import type { CodexVisualizeReference } from "./visualize-directive";
import { VISUALIZATION_MIN_HEIGHT, type VisualizationFrameOptions } from "./visualize-bridge";

interface CardProps {
  client: DaemonClient | null;
  clientGeneration: number;
  serverId: string;
  agentId: string;
  reference: CodexVisualizeReference;
  messageKey: string;
  featureAvailable: boolean;
  theme?: RenderTheme;
}

const fragmentCache = new Map<string, string>();
const hoverTargetStyle = { position: "relative" as const };
type VisualData = Awaited<ReturnType<DaemonClient["getVisualization"]>>;

function CodexVisualizeCardContent(props: {
  data?: VisualData;
  visualization?: VisualizationFrameOptions;
  theme: RenderTheme;
  title: string;
  expanded: boolean;
  loadingMessage: string;
  clientAvailable: boolean;
  fetchFailed: boolean;
  actionError: string | null;
  canRetryAction: boolean;
  actionPending: boolean;
  reloadToken: number;
  inlineHeight: number;
  onHeightChange: (height: number) => void;
  onHoverChange: (hovered: boolean) => void;
  cardStyle: StyleProp<ViewStyle>;
  hintStyle: StyleProp<TextStyle>;
  retryFetch: () => void;
  retryAction: () => void;
  close: () => void;
}) {
  const { data, visualization } = props;
  const placeholderStyle = useMemo(() => ({ height: props.inlineHeight }), [props.inlineHeight]);
  return (
    <View style={props.cardStyle}>
      {!data ? <Text style={props.hintStyle}>{props.loadingMessage}</Text> : null}
      {props.fetchFailed && props.clientAvailable ? (
        <Button variant="ghost" size="xs" onPress={props.retryFetch}>
          Retry
        </Button>
      ) : null}
      {data && visualization && !props.expanded ? (
        <HtmlRenderFrame
          key={`${data.revision}:${props.reloadToken}`}
          html={data.html}
          renderId={data.revision}
          title={props.title}
          height={VISUALIZATION_MIN_HEIGHT}
          theme={props.theme}
          visualization={visualization}
          onHeightChange={props.onHeightChange}
          onHoverChange={props.onHoverChange}
        />
      ) : null}
      {data && props.expanded ? <View style={placeholderStyle} /> : null}
      {props.actionError ? (
        <View>
          <Text style={props.hintStyle}>{props.actionError}</Text>
          {props.canRetryAction ? (
            <Button
              variant="ghost"
              size="xs"
              onPress={props.retryAction}
              disabled={props.actionPending}
            >
              Retry action
            </Button>
          ) : null}
        </View>
      ) : null}
      {props.expanded && data && visualization ? (
        <HtmlRenderViewer
          key={`${data.revision}:${props.reloadToken}`}
          html={data.html}
          renderId={data.revision}
          title={props.title}
          height={VISUALIZATION_MIN_HEIGHT}
          theme={props.theme}
          visualization={visualization}
          onClose={props.close}
        />
      ) : null}
    </View>
  );
}

function useVisualizationActions(input: {
  client: DaemonClient | null;
  agentId: string;
  canonicalPath: string | null;
  revision?: string;
  initialState?: unknown;
}) {
  const { client, agentId, canonicalPath, revision, initialState } = input;
  const [actionError, setActionError] = useState<string | null>(null);
  const [failedState, setFailedState] = useState<unknown>(null);
  const [failedFollowUp, setFailedFollowUp] = useState<{ prompt: string; title?: string } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [currentState, setCurrentState] = useState<unknown>(undefined);
  const [reloadToken, setReloadToken] = useState(0);
  const followUpPending = useRef(false);
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    setCurrentState(initialState);
  }, [canonicalPath, initialState, revision]);
  const saveState = useCallback(
    async (state: unknown) => {
      if (!client || !canonicalPath) throw new Error("Host disconnected");
      setSaving(true);
      const execute = saveTail.current.then(() =>
        client.setVisualizationState(agentId, canonicalPath, state),
      );
      saveTail.current = execute.then(
        () => undefined,
        () => undefined,
      );
      try {
        const saved = await execute;
        setCurrentState(saved);
        setActionError(null);
        setFailedState(null);
        return saved;
      } catch (error) {
        setFailedState(state);
        setActionError(error instanceof Error ? error.message : "State was not saved");
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [agentId, canonicalPath, client],
  );
  const sendFollowUp = useCallback(
    async (prompt: string, title?: string): Promise<boolean> => {
      if (!client || followUpPending.current) throw new Error("Follow-up unavailable");
      followUpPending.current = true;
      setSending(true);
      try {
        const sent = await performVisualizationFollowUp({
          prompt,
          title,
          confirm: (message, heading) =>
            confirmDialog({
              title: "Send follow-up to agent?",
              message: followUpConfirmationMessage(message, heading),
              confirmLabel: "Send",
            }),
          send: (message) => client.sendAgentMessage(agentId, message),
        });
        if (!sent) return false;
        setActionError(null);
        setFailedFollowUp(null);
        return true;
      } catch (error) {
        setFailedFollowUp({ prompt, ...(title ? { title } : {}) });
        setActionError(error instanceof Error ? error.message : "Follow-up failed");
        throw error;
      } finally {
        followUpPending.current = false;
        setSending(false);
      }
    },
    [agentId, client],
  );
  const onError = useCallback((message: string) => setActionError(message), []);
  const retryAction = useCallback(() => {
    if (failedState !== null) {
      void saveState(failedState).then(
        () => setReloadToken((token) => token + 1),
        () => undefined,
      );
    } else if (failedFollowUp) {
      void sendFollowUp(failedFollowUp.prompt, failedFollowUp.title).catch(() => undefined);
    }
  }, [failedFollowUp, failedState, saveState, sendFollowUp]);
  return {
    actionError,
    currentState,
    reloadToken,
    failedState,
    failedFollowUp,
    saving,
    sending,
    saveState,
    sendFollowUp,
    onError,
    retryAction,
  };
}

function CodexVisualizeCardImpl({
  client,
  clientGeneration,
  serverId,
  agentId,
  reference,
  messageKey,
  featureAvailable,
  theme,
}: CardProps) {
  const activeTheme = theme!;
  const isCompact = useIsCompactFormFactor();
  const [expanded, setExpanded] = useState(false);
  const [inlineHeight, setInlineHeight] = useState(VISUALIZATION_MIN_HEIGHT);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const fetched = useFetchQuery({
    queryKey: [
      "codex-visualization",
      serverId,
      clientGeneration,
      agentId,
      reference.path,
      messageKey,
      reference.occurrenceId,
    ],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const result = await client.getVisualization(agentId, reference.path);
      const cacheKey = `${serverId}:${agentId}:${result.canonicalPath}:${result.revision}`;
      const cached = fragmentCache.get(cacheKey);
      if (cached === undefined) {
        if (fragmentCache.size >= 64) fragmentCache.delete(fragmentCache.keys().next().value!);
        fragmentCache.set(cacheKey, result.html);
      }
      return { ...result, html: cached ?? result.html };
    },
    enabled: client !== null && featureAvailable,
    gcTime: 5 * 60 * 1000,
    retry: false,
  });
  const canonicalPath = fetched.data?.canonicalPath ?? null;
  const actions = useVisualizationActions({
    client,
    agentId,
    canonicalPath,
    revision: fetched.data?.revision,
    initialState: fetched.data?.state,
  });
  const visualization = useMemo<VisualizationFrameOptions | undefined>(
    () =>
      fetched.data && canonicalPath
        ? {
            canonicalPath,
            revision: fetched.data.revision,
            state: actions.currentState === undefined ? fetched.data.state : actions.currentState,
            mode: reference.mode === "wide" ? "wide" : "inline",
            onSetState: actions.saveState,
            onFollowUp: actions.sendFollowUp,
            onError: actions.onError,
          }
        : undefined,
    [
      canonicalPath,
      actions.currentState,
      actions.saveState,
      actions.sendFollowUp,
      actions.onError,
      fetched.data,
      reference.mode,
    ],
  );
  const controlsVisible = isHovered || isFocused || isNative || isCompact;
  const cardStyle = useMemo(
    () => ({
      width: "100%" as const,
      minHeight: fetched.data ? undefined : VISUALIZATION_MIN_HEIGHT,
      backgroundColor: activeTheme.variables["--background"],
    }),
    [activeTheme, fetched.data],
  );
  const hintStyle = useMemo(
    () => ({ color: activeTheme.variables["--muted-foreground"], paddingVertical: 12 }),
    [activeTheme],
  );
  const title = reference.title || "Visualization";
  const { refetch } = fetched;
  const retryFetch = useCallback(() => {
    void refetch();
  }, [refetch]);
  let loadingMessage = "Loading visualization…";
  if (!featureAvailable) loadingMessage = "Update host to display this visualization";
  else if (!client) loadingMessage = "Host disconnected";
  else if (fetched.error) loadingMessage = "Visualization unavailable";
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => setExpanded(false), []);
  const hoverIn = useCallback(() => setIsHovered(true), []);
  const hoverOut = useCallback(() => setIsHovered(false), []);
  const focusIn = useCallback(() => setIsFocused(true), []);
  const focusOut = useCallback(() => setIsFocused(false), []);
  return (
    <View
      style={hoverTargetStyle}
      onPointerEnter={hoverIn}
      onPointerLeave={hoverOut}
      onFocus={focusIn}
      onBlur={focusOut}
    >
      <CodexVisualizeCardContent
        data={fetched.data}
        visualization={visualization}
        theme={activeTheme}
        title={title}
        expanded={expanded}
        loadingMessage={loadingMessage}
        clientAvailable={client !== null}
        fetchFailed={Boolean(fetched.error)}
        actionError={actions.actionError}
        canRetryAction={actions.failedState !== null || actions.failedFollowUp !== null}
        actionPending={actions.saving || actions.sending}
        reloadToken={actions.reloadToken}
        inlineHeight={inlineHeight}
        onHeightChange={setInlineHeight}
        onHoverChange={setIsHovered}
        cardStyle={cardStyle}
        hintStyle={hintStyle}
        retryFetch={retryFetch}
        retryAction={actions.retryAction}
        close={close}
      />
      {fetched.data && visualization ? (
        <RenderExpandControl
          visible={controlsVisible}
          compact={isCompact}
          label="Expand visualization"
          onPress={open}
        />
      ) : null}
    </View>
  );
}

const ThemedCodexVisualizeCard = withUnistyles(CodexVisualizeCardImpl);
const mapTheme = (theme: Theme) => ({ theme: mapRenderTheme(theme) });

export function CodexVisualizeCard(props: Omit<CardProps, "theme">) {
  return <ThemedCodexVisualizeCard {...props} uniProps={mapTheme} />;
}
