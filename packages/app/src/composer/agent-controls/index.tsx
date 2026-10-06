import { hasModelEffortControl } from "@/components/ui/effort-stops";
import {
  useComposerLayoutMode,
  usePublishQuickPromptControls,
  useQuickPromptControlDensity,
} from "@/quick-prompts/capacity";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import {
  View,
  Text,
  Pressable,
  Keyboard,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { Settings2 } from "lucide-react-native";
import { getAgentFeatureIcon } from "@/agent-controls/icons";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { FAST_MODE_FEATURE_ID } from "@/agent-controls/policy";
import {
  buildProviderSelectorProviders,
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { useSessionStore } from "@/stores/session-store";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveProviderDefinition } from "@/utils/provider-definitions";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import {
  AgentModeControl,
  useLiveAgentModeControl,
  type AgentModeControlValue,
} from "@/composer/agent-controls/mode-control";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  AgentFeature,
  AgentFeatureToggle,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import {
  getFeatureTooltip,
  resolveAgentModelSelection,
  resolveFeatureIconTint,
} from "@/composer/agent-controls/utils";
import { resolveEffortAfterModelSwitch } from "@/components/ui/effort-stops";
import { useControlDensity, useIsCompactFormFactor } from "@/constants/layout";
import { readMeasuredWidth } from "@/hooks/use-container-width";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import {
  useAgentControlCommandCenterActions,
  type AgentControlCommandCenterSource,
} from "@/command-center/agent-control-registration";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { isNative } from "@/constants/platform";
import {
  COMPOSER_TOOLBAR_GEOMETRY,
  COMPOSER_TOOLBAR_TOUCH_HIT_SLOP,
  resolveComposerControlDensity,
  resolveComposerControlPresentation,
  resolveComposerToolbarGlyphSize,
  type ComposerControlDensity,
  type ComposerControlPresence,
} from "@/composer/agent-controls/layout";
import {
  ComposerControlLayoutProvider,
  useComposerControlLayout,
  type ComposerControlLayoutValue,
} from "@/composer/agent-controls/layout-context";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import { AgentControlRowGroup, AgentControlTrigger } from "@/composer/agent-controls/control";
import {
  IntelligenceControl,
  type IntelligenceControlProps,
} from "@/composer/agent-controls/intelligence-control";
import type { EffortOption } from "@/composer/agent-controls/effort-selection";
import { SheetFeatureItem } from "@/composer/agent-controls/advanced-page";
import {
  useAgentProfileEditor,
  useAgentProfilePicker,
  type AgentProfileApplyTarget,
  type AgentProfileEditorControls,
  type AgentProfilePicker,
  type AgentProfileSeed,
  type DraftAgentProfileControls,
} from "@/agent-profiles";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

interface AgentControlOption {
  id: string;
  label: string;
}

type AgentControlSelector = "model" | `feature-${string}`;
/** The Advanced page's rows report their own ids, so the open selector is any row id. */
type OpenSelector = string;

const EMPTY_AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [];
const EMPTY_EFFORT_OPTIONS: EffortOption[] = [];

interface ControlledAgentControlsProps {
  provider: string;
  modelOptions?: AgentControlOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
  effortOptions?: EffortOption[];
  selectedEffortId?: string;
  onSelectEffort?: (effortId: string) => void;
  disabled?: boolean;
  isModelLoading?: boolean;
  modelSelectorProviders?: ProviderSelectorProvider[];
  agentProfiles?: AgentProfilePicker | null;
  onApplyAgentProfile?: (profileId: string) => void;
  onEditAgentProfiles?: () => void;
  onCreateAgentProfile?: (seed: AgentProfileSeed) => void;
  onEditAgentProfile?: (profileId: string) => void;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider?: boolean;
  modeControl?: AgentModeControlValue | null;
  modelSelectorServerId?: string | null;
  isCompactLayout?: boolean;
  children: ReactNode;
}

export interface DraftAgentControlsProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider | null;
  modeOptions: AgentMode[];
  selectedMode: string;
  onSelectMode: (modeId: string) => void;
  models: AgentModelDefinition[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  isModelLoading: boolean;
  modelSelectorProviders: ProviderSelectorProvider[];
  isAllModelsLoading: boolean;
  onSelectProviderAndModel: (provider: AgentProvider, modelId: string) => void;
  thinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  selectedThinkingOptionId: string;
  onSelectThinkingOption: (thinkingOptionId: string) => void;
  onApplyAgentProfile: DraftAgentProfileControls["applyProfile"];
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider?: boolean;
  disabled?: boolean;
  modelSelectorServerId?: string | null;
  isCompactLayout?: boolean;
}

interface AgentControlsProps {
  agentId: string;
  serverId: string;
  onDropdownClose?: () => void;
  isCompactLayout?: boolean;
}

/**
 * The controls live in two toolbar clusters — the permission mode starts the row, the
 * intelligence trigger ends it — but share one density, one open selector and one set of
 * sheets. The host component owns that state and publishes each cluster's content here;
 * `AgentControlsStart` and `AgentControlsEnd` render it from inside the composer's toolbar.
 */
interface AgentControlsSlots {
  layout: ComposerControlLayoutValue;
  start: StartClusterProps;
  end: IntelligenceControlProps | null;
  onStartLayout: (event: LayoutChangeEvent) => void;
  onEndLayout: (event: LayoutChangeEvent) => void;
  isTouchDensity: boolean;
}

const AgentControlsSlotContext = createContext<AgentControlsSlots | null>(null);

/** The toolbar's shared glyph size and hit slop, for controls that sit beside the clusters. */
export function useAgentControlsLayout(): ComposerControlLayoutValue | null {
  return useContext(AgentControlsSlotContext)?.layout ?? null;
}

export function AgentControlsStart() {
  const slots = useContext(AgentControlsSlotContext);
  if (!slots) return null;
  return (
    <View
      style={[styles.startCluster, slots.isTouchDensity && styles.clusterTouch]}
      onLayout={slots.onStartLayout}
      testID="agent-controls-start"
    >
      <ComposerControlLayoutProvider value={slots.layout}>
        <StartCluster {...slots.start} />
      </ComposerControlLayoutProvider>
    </View>
  );
}

export function AgentControlsEnd() {
  const slots = useContext(AgentControlsSlotContext);
  if (!slots?.end) return null;
  return (
    <View
      style={[styles.endCluster, slots.isTouchDensity && styles.clusterTouch]}
      onLayout={slots.onEndLayout}
      testID="agent-controls-end"
    >
      <ComposerControlLayoutProvider value={slots.layout}>
        <IntelligenceControl {...slots.end} />
      </ComposerControlLayoutProvider>
    </View>
  );
}

function AgentControlCommandCenterRegistration({
  sourceId,
  enabled,
  controls,
}: {
  sourceId: string;
  enabled: boolean;
  controls: AgentControlCommandCenterSource;
}) {
  const { isActiveComposer } = useComposerKeyboardScope();
  useAgentControlCommandCenterActions({
    sourceId,
    enabled: enabled && isActiveComposer,
    controls,
  });
  return null;
}

function toCommandCenterModes(modeControl: AgentModeControlValue | null) {
  if (!modeControl) return undefined;
  return {
    options: modeControl.modeOptions,
    selectedId: modeControl.selectedModeId,
    select: modeControl.onSelectMode,
  };
}

function getModeProviderDefinitions(modeControl: AgentModeControlValue | null) {
  return modeControl?.providerDefinitions ?? EMPTY_AGENT_PROVIDER_DEFINITIONS;
}

function toEffortOptions(
  options:
    | readonly NonNullable<AgentModelDefinition["thinkingOptions"]>[number][]
    | null
    | undefined,
): EffortOption[] {
  return (options ?? []).map((option) => ({
    id: option.id,
    label: formatThinkingOptionLabel(option),
    description: option.description,
    isDefault: option.isDefault,
  }));
}

/** Fast is the Speed row; every other feature is an Advanced row, or a toolbar control at full density. */
function splitFeatures(features: AgentFeature[] | undefined): {
  fastFeature: AgentFeatureToggle | null;
  toolbarFeatures: AgentFeature[];
} {
  const fastFeature =
    features?.find(
      (feature): feature is AgentFeatureToggle =>
        feature.type === "toggle" && feature.id === FAST_MODE_FEATURE_ID,
    ) ?? null;
  const toolbarFeatures = (features ?? []).filter((feature) => feature !== fastFeature);
  return { fastFeature, toolbarFeatures };
}

/**
 * The picker's edit shortcut. Agent profiles are host config, so it lands on the
 * host settings section that owns the list.
 */
function useEditAgentProfilesNavigation(
  serverId: string | null,
  isSupported: boolean,
): (() => void) | undefined {
  const handleEdit = useCallback(() => {
    if (!serverId) return;
    router.push(buildSettingsHostSectionRoute(serverId, "agents"));
  }, [serverId]);
  return serverId && isSupported ? handleEdit : undefined;
}

function resolveAgentProfileEditorActions(
  isSupported: boolean,
  editor: AgentProfileEditorControls,
): {
  create?: (seed: AgentProfileSeed) => void;
  edit?: (profileId: string) => void;
} {
  if (!isSupported) {
    return {};
  }
  return {
    create: editor.openCreateFromModel,
    edit: editor.openEdit,
  };
}

function buildFallbackModelSelectorProviders(
  provider: string,
  modelOptions: AgentControlOption[] | undefined,
): ProviderSelectorProvider[] {
  if (!modelOptions || modelOptions.length === 0) {
    return [];
  }
  return [
    {
      id: provider,
      label: provider,
      modelSelection: {
        kind: "models",
        rows: modelOptions.map((option) => ({
          favoriteKey: `${provider}:${option.id}`,
          provider,
          providerLabel: provider,
          modelId: option.id,
          modelLabel: option.label,
        })),
      },
    },
  ];
}

function pickModel({
  nextProviderId,
  modelId,
  currentProvider,
  onSelectProviderAndModel,
  onSelectModel,
}: {
  nextProviderId: string;
  modelId: string;
  currentProvider: string;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
  onSelectModel?: (modelId: string) => void;
}) {
  if (onSelectProviderAndModel) {
    onSelectProviderAndModel(nextProviderId, modelId);
    return;
  }
  if (nextProviderId === currentProvider) {
    onSelectModel?.(modelId);
  }
}

type AgentControlsSlice = {
  provider: string;
  cwd: string | null;
  runtimeModelId: string | null;
  model: string | null | undefined;
  features: AgentFeature[] | undefined;
  runtimeThinkingOptionId: string | null;
  thinkingOptionId: string | null | undefined;
  lastUsage: unknown;
} | null;

function selectAgentControlsSlice(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string,
): AgentControlsSlice {
  const currentAgent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
  if (!currentAgent) {
    return null;
  }
  return {
    provider: currentAgent.provider,
    cwd: currentAgent.cwd,
    runtimeModelId: currentAgent.runtimeInfo?.model ?? null,
    model: currentAgent.model,
    features: currentAgent.features,
    runtimeThinkingOptionId: currentAgent.runtimeInfo?.thinkingOptionId ?? null,
    thinkingOptionId: currentAgent.thinkingOptionId,
    lastUsage: currentAgent.lastUsage,
  };
}

function resolveSnapshotSelectedEntry(
  snapshotEntries: ReturnType<typeof useProvidersSnapshot>["entries"],
  agentProvider: string | undefined,
) {
  if (!snapshotEntries || !agentProvider) {
    return null;
  }
  return snapshotEntries.find((e) => e.provider === agentProvider) ?? null;
}

function resolveSnapshotModeIds(
  entry: ReturnType<typeof resolveSnapshotSelectedEntry>,
): string[] | null {
  if (entry?.status !== "ready" || !entry.modes) {
    return null;
  }
  return entry.modes.map((mode) => mode.id);
}

function buildAgentProviderDefinitions(
  agentProvider: string | undefined,
  snapshotEntries: ReturnType<typeof useProvidersSnapshot>["entries"],
): AgentProviderDefinition[] {
  const definition = agentProvider
    ? resolveProviderDefinition(agentProvider, snapshotEntries)
    : undefined;
  return definition ? [definition] : [];
}

function buildAgentProviderModels(
  agentProvider: string | undefined,
  models: AgentModelDefinition[] | null,
): Map<string, AgentModelDefinition[]> {
  const map = new Map<string, AgentModelDefinition[]>();
  if (agentProvider && models) {
    map.set(agentProvider, models);
  }
  return map;
}

function buildOpenChangeHandler(
  selector: AgentControlSelector,
  setOpenSelector: (next: AgentControlSelector | null) => void,
  onDropdownClose?: () => void,
) {
  return (nextOpen: boolean) => {
    setOpenSelector(nextOpen ? selector : null);
    if (!nextOpen) {
      onDropdownClose?.();
    }
  };
}

/**
 * The start cluster grows into the toolbar's slack and the end cluster sits at its natural
 * width, so together they measure everything the controls could occupy.
 */
function useAgentControlsDensity({
  initialDensity,
  controlPresence,
  controlGap,
}: {
  initialDensity: ComposerControlDensity;
  controlPresence: ComposerControlPresence;
  controlGap: number;
}) {
  const [density, setDensity] = useState<ComposerControlDensity>(initialDensity);
  const densityRef = useRef<ComposerControlDensity>(initialDensity);
  const startWidthRef = useRef(0);
  const endWidthRef = useRef(0);

  const updateDensity = useCallback(() => {
    const availableWidth = startWidthRef.current + endWidthRef.current;
    if (availableWidth <= 0) return;
    const nextDensity = resolveComposerControlDensity({
      availableWidth,
      currentDensity: densityRef.current,
      controls: controlPresence,
      controlGap,
    });
    if (nextDensity === densityRef.current) return;
    densityRef.current = nextDensity;
    setDensity(nextDensity);
  }, [controlGap, controlPresence]);

  const handleStartLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const width = readMeasuredWidth(event);
      if (width === null) return;
      startWidthRef.current = width;
      updateDensity();
    },
    [updateDensity],
  );
  const handleEndLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const width = readMeasuredWidth(event);
      if (width === null) return;
      endWidthRef.current = width;
      updateDensity();
    },
    [updateDensity],
  );

  useEffect(() => {
    updateDensity();
  }, [updateDensity]);

  return { density, handleStartLayout, handleEndLayout };
}

function resolveComposerDensity(input: {
  isLean: boolean;
  quickPromptDensity: ComposerControlDensity | null;
  measuredDensity: ComposerControlDensity;
}): ComposerControlDensity {
  if (input.isLean) return "icons";
  return input.quickPromptDensity ?? input.measuredDensity;
}

function resolveControlPresence(input: {
  hasPill: boolean;
  hasMode: boolean;
  effortOptions: readonly EffortOption[];
  selectedEffortId: string | undefined;
  modelOptions: AgentControlOption[] | undefined;
  selectedModelId: string | undefined;
  modeControl: AgentModeControlValue | null | undefined;
  toolbarFeatures: AgentFeature[];
  fontScale: number;
}): ComposerControlPresence {
  const selectedEffort = input.effortOptions.find((option) => option.id === input.selectedEffortId);
  const selectedModel = input.modelOptions?.find((option) => option.id === input.selectedModelId);
  const selectedMode = input.modeControl?.modeOptions.find(
    (mode) => mode.id === input.modeControl?.selectedModeId,
  );
  const features = input.toolbarFeatures.map((feature) => {
    if (feature.type === "toggle") return { type: "toggle" as const };
    const selectedOption = feature.options.find((option) => option.id === feature.value);
    return { type: "select" as const, label: selectedOption?.label ?? feature.label };
  });
  return {
    hasModel: input.hasPill,
    hasEffort: input.effortOptions.length > 1,
    hasMode: input.hasMode,
    features,
    fontScale: input.fontScale,
    modelLabel: selectedModel?.label ?? input.selectedModelId ?? "",
    effortLabel: selectedEffort?.label ?? "",
    modeLabel: selectedMode?.label ?? "",
  };
}

function ControlledAgentControls({
  provider,
  modelOptions,
  selectedModelId,
  onSelectModel,
  onSelectProviderAndModel,
  effortOptions = EMPTY_EFFORT_OPTIONS,
  selectedEffortId,
  onSelectEffort,
  disabled = false,
  isModelLoading = false,
  modelSelectorProviders,
  agentProfiles = null,
  onApplyAgentProfile,
  onEditAgentProfiles,
  onCreateAgentProfile,
  onEditAgentProfile,
  features,
  onSetFeature,
  onDropdownClose,
  onModelSelectorOpen,
  onRetryModelProvider,
  isRetryingModelProvider = false,
  modeControl,
  modelSelectorServerId = null,
  isCompactLayout,
  children,
}: ControlledAgentControlsProps) {
  const isCompactFormFactor = useIsCompactFormFactor();
  const isCompact = isCompactLayout ?? isCompactFormFactor;
  const isLean = useComposerLayoutMode(isCompact) === "lean";
  const isTouchDensity = useControlDensity() === "touch";
  const controlGap = isTouchDensity
    ? COMPOSER_TOOLBAR_GEOMETRY.touchControlGap
    : COMPOSER_TOOLBAR_GEOMETRY.controlGap;
  const { fontScale } = useWindowDimensions();
  const [isFeaturesSheetOpen, setIsFeaturesSheetOpen] = useState(false);
  const [openSelector, setOpenSelector] = useState<OpenSelector | null>(null);

  const canSelectModel = Boolean(onSelectModel || onSelectProviderAndModel);
  const canSwitchProvider = Boolean(onSelectProviderAndModel);
  const hasMode = Boolean(modeControl);
  const { fastFeature, toolbarFeatures } = useMemo(() => splitFeatures(features), [features]);
  const hasPill = hasModelEffortControl({
    canSelectModel,
    effortCount: effortOptions.length,
    hasFast: fastFeature !== null,
  });
  const hasAnyControl = hasPill || toolbarFeatures.length > 0 || hasMode;

  const controlPresence = useMemo(
    () =>
      resolveControlPresence({
        hasPill,
        hasMode,
        effortOptions,
        selectedEffortId,
        modelOptions,
        selectedModelId,
        modeControl,
        toolbarFeatures,
        fontScale,
      }),
    [
      hasPill,
      effortOptions,
      fontScale,
      hasMode,
      modeControl,
      modelOptions,
      selectedEffortId,
      selectedModelId,
      toolbarFeatures,
    ],
  );
  const {
    density: measuredDensity,
    handleStartLayout,
    handleEndLayout,
  } = useAgentControlsDensity({
    initialDensity: isLean ? "icons" : "full",
    controlPresence,
    controlGap,
  });
  usePublishQuickPromptControls(controlPresence);
  const quickPromptDensity = useQuickPromptControlDensity();
  // Lean is the phone row outright; only roomy layouts measure their way down the ladder.
  const density = resolveComposerDensity({ isLean, quickPromptDensity, measuredDensity });
  const presentation = useMemo(() => resolveComposerControlPresentation(density), [density]);
  const layout = useMemo(
    () => ({
      glyphSize: resolveComposerToolbarGlyphSize(isNative ? "native" : "web"),
      presentation,
      hitSlop: isTouchDensity ? COMPOSER_TOOLBAR_TOUCH_HIT_SLOP : undefined,
    }),
    [isTouchDensity, presentation],
  );

  const fallbackModelSelectorProviders = useMemo(
    () => buildFallbackModelSelectorProviders(provider, modelOptions),
    [modelOptions, provider],
  );
  const providers = modelSelectorProviders ?? fallbackModelSelectorProviders;

  const handleOpenChange = useCallback(
    (selector: AgentControlSelector) =>
      buildOpenChangeHandler(selector, setOpenSelector, onDropdownClose),
    [onDropdownClose],
  );
  const handleModelOpenChange = useMemo(() => handleOpenChange("model"), [handleOpenChange]);
  const handleSheetOpenChange = useCallback(
    (selector: string) => (nextOpen: boolean) => {
      setOpenSelector(nextOpen ? selector : null);
    },
    [],
  );

  const handleModelSelect = useCallback(
    (nextProviderId: string, modelId: string) => {
      pickModel({
        nextProviderId,
        modelId,
        currentProvider: provider,
        onSelectProviderAndModel,
        onSelectModel,
      });
    },
    [onSelectModel, onSelectProviderAndModel, provider],
  );

  const handleOpenFeatures = useCallback(() => {
    Keyboard.dismiss();
    setIsFeaturesSheetOpen(true);
  }, []);
  const handleCloseFeatures = useCallback(() => {
    setIsFeaturesSheetOpen(false);
    if (!isCompact) onDropdownClose?.();
  }, [isCompact, onDropdownClose]);

  const start = useMemo<StartClusterProps>(
    () => ({
      modeControl,
      toolbarFeatures,
      aggregateFeatures: presentation.aggregateFeatures,
      // With a trigger the aggregated features live on its Advanced page instead of a badge.
      showFeaturesBadge: !hasPill,
      disabled,
      openSelector,
      onOpenChange: handleOpenChange,
      onSheetOpenChange: handleSheetOpenChange,
      onSetFeature,
      onDropdownClose,
      isFeaturesSheetOpen,
      onOpenFeatures: handleOpenFeatures,
      onCloseFeatures: handleCloseFeatures,
    }),
    [
      disabled,
      handleCloseFeatures,
      handleOpenChange,
      handleOpenFeatures,
      handleSheetOpenChange,
      hasPill,
      isFeaturesSheetOpen,
      modeControl,
      onDropdownClose,
      onSetFeature,
      openSelector,
      presentation.aggregateFeatures,
      toolbarFeatures,
    ],
  );

  const end = useMemo<IntelligenceControlProps | null>(
    () =>
      hasPill
        ? {
            canSelectModel,
            provider,
            serverId: modelSelectorServerId,
            providers,
            selectedModelId: selectedModelId ?? "",
            onSelectModel: handleModelSelect,
            canSwitchProvider,
            isModelLoading,
            disabled,
            effortOptions,
            selectedEffortId,
            onSelectEffort,
            fastFeature,
            features: toolbarFeatures,
            onSetFeature,
            lean: isLean,
            profiles: agentProfiles,
            onApplyProfile: onApplyAgentProfile,
            onEditProfiles: onEditAgentProfiles,
            onCreateProfile: onCreateAgentProfile,
            onEditProfile: onEditAgentProfile,
            onRetryProvider: onRetryModelProvider,
            isRetryingProvider: isRetryingModelProvider,
            open: openSelector === "model",
            onOpenChange: handleModelOpenChange,
            onOpen: onModelSelectorOpen,
          }
        : null,
    [
      agentProfiles,
      hasPill,
      canSelectModel,
      canSwitchProvider,
      disabled,
      effortOptions,
      fastFeature,
      handleModelOpenChange,
      handleModelSelect,
      isModelLoading,
      isRetryingModelProvider,
      modelSelectorServerId,
      onApplyAgentProfile,
      onCreateAgentProfile,
      onEditAgentProfile,
      onEditAgentProfiles,
      onModelSelectorOpen,
      onRetryModelProvider,
      onSelectEffort,
      onSetFeature,
      openSelector,
      provider,
      providers,
      selectedEffortId,
      selectedModelId,
      toolbarFeatures,
      isLean,
    ],
  );

  const slots = useMemo<AgentControlsSlots | null>(
    () =>
      hasAnyControl
        ? {
            layout,
            start,
            end,
            onStartLayout: handleStartLayout,
            onEndLayout: handleEndLayout,
            isTouchDensity,
          }
        : null,
    [end, handleEndLayout, handleStartLayout, hasAnyControl, isTouchDensity, layout, start],
  );

  return (
    <AgentControlsSlotContext.Provider value={slots}>{children}</AgentControlsSlotContext.Provider>
  );
}

interface StartClusterProps {
  modeControl: AgentModeControlValue | null | undefined;
  toolbarFeatures: AgentFeature[];
  aggregateFeatures: boolean;
  showFeaturesBadge: boolean;
  disabled: boolean;
  openSelector: OpenSelector | null;
  onOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  onSheetOpenChange: (selector: string) => (nextOpen: boolean) => void;
  onSetFeature: ((featureId: string, value: unknown) => void) | undefined;
  onDropdownClose: (() => void) | undefined;
  isFeaturesSheetOpen: boolean;
  onOpenFeatures: () => void;
  onCloseFeatures: () => void;
}

/** Inline at full density; a badge only while no trigger offers an Advanced page; else nothing. */
function resolveStartFeaturesPlacement(input: {
  aggregateFeatures: boolean;
  showFeaturesBadge: boolean;
  hasFeatures: boolean;
}): "inline" | "badge" | "none" {
  if (!input.hasFeatures) return "none";
  if (!input.aggregateFeatures) return "inline";
  return input.showFeaturesBadge ? "badge" : "none";
}

function StartCluster({
  modeControl,
  toolbarFeatures,
  aggregateFeatures,
  showFeaturesBadge,
  disabled,
  openSelector,
  onOpenChange,
  onSheetOpenChange,
  onSetFeature,
  onDropdownClose,
  isFeaturesSheetOpen,
  onOpenFeatures,
  onCloseFeatures,
}: StartClusterProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const { glyphSize, hitSlop } = useComposerControlLayout();
  const featuresSheetHeader = useMemo<SheetHeader>(
    () => ({ title: t("agentControls.features.title") }),
    [t],
  );
  const featuresPlacement = resolveStartFeaturesPlacement({
    aggregateFeatures,
    showFeaturesBadge,
    hasFeatures: toolbarFeatures.length > 0,
  });

  return (
    <>
      {modeControl ? <AgentModeControl {...modeControl} onClose={onDropdownClose} /> : null}
      {featuresPlacement === "badge" ? (
        <>
          <Pressable
            onPress={onOpenFeatures}
            disabled={disabled}
            hitSlop={hitSlop}
            style={styles.featuresBadge}
            accessibilityRole="button"
            accessibilityLabel={t("agentControls.features.open")}
            testID="agent-controls-features"
          >
            <ComposerToolbarGlyph size={glyphSize}>
              <Settings2 size={glyphSize} color={theme.colors.foregroundMuted} />
            </ComposerToolbarGlyph>
          </Pressable>
          <AdaptiveModalSheet
            header={featuresSheetHeader}
            visible={isFeaturesSheetOpen}
            onClose={onCloseFeatures}
            testID="agent-features-sheet"
          >
            <AgentControlRowGroup>
              {toolbarFeatures.map((feature) => (
                <SheetFeatureItem
                  key={`feature-${feature.id}`}
                  feature={feature}
                  disabled={disabled}
                  openSelector={openSelector}
                  handleOpenChange={onSheetOpenChange}
                  onSetFeature={onSetFeature}
                />
              ))}
            </AgentControlRowGroup>
          </AdaptiveModalSheet>
        </>
      ) : null}
      {featuresPlacement === "inline"
        ? toolbarFeatures.map((feature) => (
            <DesktopFeatureItem
              key={`feature-${feature.id}`}
              feature={feature}
              disabled={disabled}
              openSelector={openSelector}
              handleOpenChange={onOpenChange}
              onSetFeature={onSetFeature}
              onActionComplete={onDropdownClose}
            />
          ))
        : null}
    </>
  );
}

function DesktopFeatureItem({
  feature,
  disabled,
  openSelector,
  handleOpenChange,
  onSetFeature,
  onActionComplete,
}: {
  feature: AgentFeature;
  disabled: boolean;
  openSelector: OpenSelector | null;
  handleOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  onSetFeature?: (featureId: string, value: unknown) => void;
  onActionComplete?: () => void;
}) {
  const featureSelector: AgentControlSelector = `feature-${feature.id}`;
  const featureAnchorRef = useRef<View>(null);

  const handleFeatureOpenChange = useMemo(
    () => handleOpenChange(featureSelector),
    [handleOpenChange, featureSelector],
  );
  const handleSelectPress = useCallback(
    () => handleFeatureOpenChange(openSelector !== featureSelector),
    [featureSelector, handleFeatureOpenChange, openSelector],
  );

  const handleTogglePress = useCallback(() => {
    if (feature.type === "toggle") {
      onSetFeature?.(feature.id, !feature.value);
      onActionComplete?.();
    }
  }, [feature, onActionComplete, onSetFeature]);

  const handleSelectOption = useCallback(
    (optionId: string) => {
      onSetFeature?.(feature.id, optionId);
    },
    [feature.id, onSetFeature],
  );
  const comboboxOptions = useMemo<ComboboxOption[]>(
    () =>
      feature.type === "select"
        ? feature.options.map((option) => ({ id: option.id, label: option.label }))
        : [],
    [feature],
  );

  if (feature.type === "toggle") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    return (
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            icon={FeatureIcon}
            iconTint={resolveFeatureIconTint(feature.id, feature.value)}
            surface="toolbar"
            label={feature.label}
            showToolbarLabel={false}
            disabled={disabled}
            onPress={handleTogglePress}
            accessibilityLabel={getFeatureTooltip(feature)}
            testID={`agent-feature-${feature.id}`}
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{getFeatureTooltip(feature)}</Text>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (feature.type === "select") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    const selectedOption = feature.options.find((o) => o.id === feature.value);
    const iconOnly = feature.desktopTrigger === "icon";
    const tooltip = iconOnly
      ? `${feature.label}: ${selectedOption?.label ?? feature.label}`
      : getFeatureTooltip(feature);
    return (
      <>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="ref">
            <AgentControlTrigger
              ref={featureAnchorRef}
              icon={FeatureIcon}
              surface="toolbar"
              label={feature.label}
              value={selectedOption?.label ?? feature.label}
              showToolbarLabel={!iconOnly}
              open={openSelector === featureSelector}
              disabled={disabled}
              onPress={handleSelectPress}
              accessibilityLabel={tooltip}
              testID={`agent-feature-${feature.id}`}
            />
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{tooltip}</Text>
          </TooltipContent>
        </Tooltip>
        <Combobox
          options={comboboxOptions}
          value={String(feature.value)}
          onSelect={handleSelectOption}
          open={openSelector === featureSelector}
          onOpenChange={handleFeatureOpenChange}
          anchorRef={featureAnchorRef}
          desktopPlacement="top-start"
        />
      </>
    );
  }

  return null;
}

export const AgentControls = memo(function AgentControls({
  agentId,
  serverId,
  onDropdownClose,
  isCompactLayout,
  children,
}: AgentControlsProps & { children: ReactNode }) {
  const { updatePreferences } = useFormPreferences();
  const agent = useSessionStore(
    useShallow((state) => selectAgentControlsSlice(state, serverId, agentId)),
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const toast = useToast();
  const modeControl = useLiveAgentModeControl(serverId, agentId);
  const commandCenterModes = toCommandCenterModes(modeControl);
  const modeProviderDefinitions = getModeProviderDefinitions(modeControl);

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    isRefreshing: snapshotIsRefreshing,
    refresh: refreshSnapshot,
    refetchIfStale: refetchSnapshotIfStale,
  } = useProvidersSnapshot(serverId, { cwd: agent?.cwd });

  const snapshotSelectedEntry = useMemo(
    () => resolveSnapshotSelectedEntry(snapshotEntries, agent?.provider),
    [snapshotEntries, agent?.provider],
  );

  const snapshotModels = snapshotSelectedEntry?.models ?? null;
  const models = useMemo(() => filterSelectableModels(snapshotModels), [snapshotModels]);
  const selectedProviderIsLoading = snapshotSelectedEntry?.status === "loading";

  const agentProviderDefinitions = useMemo(
    () => buildAgentProviderDefinitions(agent?.provider, snapshotEntries),
    [agent?.provider, snapshotEntries],
  );

  const agentProviderModels = useMemo(
    () => buildAgentProviderModels(agent?.provider, models),
    [agent?.provider, models],
  );
  const agentModelSelectorProviders = useMemo(() => {
    if (snapshotSelectedEntry) {
      return buildSelectableProviderSelectorProviders([snapshotSelectedEntry]);
    }
    return buildProviderSelectorProviders({
      providerDefinitions: agentProviderDefinitions,
      modelsByProvider: agentProviderModels,
    });
  }, [agentProviderDefinitions, agentProviderModels, snapshotSelectedEntry]);

  const modelSelection = resolveAgentModelSelection({
    models,
    runtimeModelId: agent?.runtimeModelId,
    configuredModelId: agent?.model,
    runtimeThinkingOptionId: agent?.runtimeThinkingOptionId,
    explicitThinkingOptionId: agent?.thinkingOptionId,
  });

  const modelOptions = useMemo<AgentControlOption[]>(() => {
    return (models ?? []).map((model) => ({ id: model.id, label: model.label }));
  }, [models]);

  const effortOptions = useMemo(
    () => toEffortOptions(modelSelection.thinkingOptions),
    [modelSelection.thinkingOptions],
  );

  const agentProvider = agent?.provider;
  const activeModelId = modelSelection.activeModelId;
  const selectedThinkingId = modelSelection.selectedThinkingId;

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      // The daemon keeps the agent's effort as-is across a model switch, so the card settles it
      // here: the same level when the new model offers it, its default otherwise.
      const nextModel =
        models?.find((model) => model.id === modelId || model.aliases?.includes(modelId)) ?? null;
      const nextThinkingId = resolveEffortAfterModelSwitch({
        thinkingOptions: nextModel?.thinkingOptions,
        currentThinkingOptionId: selectedThinkingId,
      });
      try {
        await client.setAgentModel(agentId, modelId);
        if (nextThinkingId !== null && nextThinkingId !== selectedThinkingId) {
          const notice = await client.setAgentThinkingOption(agentId, nextThinkingId);
          showProviderNoticeToast(toast, notice);
        }
        await updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: {
              model: modelId,
              ...(nextThinkingId !== null
                ? { thinkingByModel: { [modelId]: nextThinkingId } }
                : {}),
            },
          }),
        );
      } catch (error) {
        console.warn("[AgentControls] setAgentModel or persist preference failed", error);
        toast.error(toErrorMessage(error));
      }
    },
    [agentId, agentProvider, client, models, selectedThinkingId, toast, updatePreferences],
  );
  const handleSelectCommandCenterModel = useCallback(
    (_provider: AgentProvider, modelId: string) => handleSelectModel(modelId),
    [handleSelectModel],
  );

  // A running agent is one provider's process, so only that provider's profiles
  // can apply to it.
  const profileProviders = useMemo(() => (agentProvider ? [agentProvider] : []), [agentProvider]);
  const profileModeIds = useMemo(
    () => resolveSnapshotModeIds(snapshotSelectedEntry),
    [snapshotSelectedEntry],
  );
  const profileTarget = useMemo<AgentProfileApplyTarget>(
    () => ({ kind: "agent", agentId, availableModeIds: profileModeIds }),
    [agentId, profileModeIds],
  );
  const agentProfiles = useAgentProfilePicker({
    serverId,
    availableProviders: profileProviders,
    target: profileTarget,
  });
  const handleEditAgentProfiles = useEditAgentProfilesNavigation(serverId, agentProfiles !== null);
  const profileEditor = useAgentProfileEditor(serverId);
  const profileActions = resolveAgentProfileEditorActions(agentProfiles !== null, profileEditor);

  const handleSelectThinkingOption = useCallback(
    (thinkingOptionId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      if (activeModelId) {
        void updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: {
              model: activeModelId,
              thinkingByModel: {
                [activeModelId]: thinkingOptionId,
              },
            },
          }),
        ).catch((error) => {
          console.warn("[AgentControls] persist thinking preference failed", error);
        });
      }
      void client
        .setAgentThinkingOption(agentId, thinkingOptionId)
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.warn("[AgentControls] setAgentThinkingOption failed", error);
          toast.error(toErrorMessage(error));
        });
    },
    [activeModelId, agentId, agentProvider, client, toast, updatePreferences],
  );

  const handleSetFeature = useCallback(
    (featureId: string, value: unknown) => {
      if (!client || !agentProvider) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider: agentProvider,
          updates: {
            featureValues: {
              [featureId]: value,
            },
          },
        }),
      ).catch((error) => {
        console.warn("[AgentControls] persist feature preference failed", error);
      });
      void client.setAgentFeature(agentId, featureId, value).catch((error) => {
        console.warn("[AgentControls] setAgentFeature failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, agentProvider, client, toast, updatePreferences],
  );

  const commandCenterControls = useMemo<AgentControlCommandCenterSource>(
    () => ({
      serverId,
      ownerKey: agentId,
      provider: agentProvider,
      providerDefinitions: modeProviderDefinitions,
      models: {
        providers: agentModelSelectorProviders,
        selectedProvider: agentProvider,
        selectedModelId: activeModelId,
        select: handleSelectCommandCenterModel,
      },
      thinking: {
        options: modelSelection.thinkingOptions,
        selectedId: modelSelection.selectedThinkingId,
        select: handleSelectThinkingOption,
      },
      modes: commandCenterModes,
      features: {
        list: agent?.features,
        set: handleSetFeature,
      },
    }),
    [
      activeModelId,
      agent?.features,
      agentId,
      agentModelSelectorProviders,
      agentProvider,
      commandCenterModes,
      handleSelectCommandCenterModel,
      handleSelectThinkingOption,
      handleSetFeature,
      modeProviderDefinitions,
      modelSelection.selectedThinkingId,
      modelSelection.thinkingOptions,
      serverId,
    ],
  );

  const commandCenterRegistration = (
    <AgentControlCommandCenterRegistration
      sourceId={`agent:${serverId}:${agentId}`}
      enabled={Boolean(client)}
      controls={commandCenterControls}
    />
  );

  const handleModelSelectorOpen = useCallback(() => {
    refetchSnapshotIfStale(agentProvider);
  }, [agentProvider, refetchSnapshotIfStale]);

  const handleRetryModelProvider = useCallback(
    (provider: AgentProvider) => {
      void refreshSnapshot([provider]);
    },
    [refreshSnapshot],
  );

  if (!agent) {
    return children;
  }

  return (
    <>
      {commandCenterRegistration}
      {profileEditor.element}
      <ControlledAgentControls
        provider={agent.provider}
        modelSelectorProviders={agentModelSelectorProviders}
        modelOptions={modelOptions}
        selectedModelId={modelSelection.activeModelId ?? undefined}
        onSelectModel={handleSelectModel}
        agentProfiles={agentProfiles}
        onApplyAgentProfile={agentProfiles?.applyProfile}
        onEditAgentProfiles={handleEditAgentProfiles}
        onCreateAgentProfile={profileActions.create}
        onEditAgentProfile={profileActions.edit}
        effortOptions={effortOptions}
        selectedEffortId={modelSelection.selectedThinkingId ?? undefined}
        onSelectEffort={handleSelectThinkingOption}
        features={agent.features}
        onSetFeature={handleSetFeature}
        isModelLoading={snapshotIsLoading || selectedProviderIsLoading}
        onModelSelectorOpen={handleModelSelectorOpen}
        onRetryModelProvider={handleRetryModelProvider}
        isRetryingModelProvider={snapshotIsRefreshing}
        onDropdownClose={onDropdownClose}
        disabled={!client}
        modeControl={modeControl}
        modelSelectorServerId={serverId}
        isCompactLayout={isCompactLayout}
      >
        {children}
      </ControlledAgentControls>
    </>
  );
});

export function DraftAgentControls({
  providerDefinitions,
  selectedProvider,
  modeOptions,
  selectedMode,
  onSelectMode,
  models,
  selectedModel,
  onSelectModel,
  isModelLoading: _isModelLoading,
  modelSelectorProviders,
  isAllModelsLoading,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  onApplyAgentProfile,
  features,
  onSetFeature,
  onDropdownClose,
  onModelSelectorOpen,
  onRetryModelProvider,
  isRetryingModelProvider = false,
  disabled = false,
  modelSelectorServerId = null,
  isCompactLayout,
  children,
}: DraftAgentControlsProps & { children: ReactNode }) {
  const effortOptions = useMemo(() => toEffortOptions(thinkingOptions), [thinkingOptions]);

  const effectiveSelectedEffort = selectedThinkingOptionId || effortOptions[0]?.id || undefined;

  const modelOptions = useMemo<AgentControlOption[]>(
    () =>
      models.map((model) => ({
        id: model.id,
        label: model.label,
      })),
    [models],
  );

  // The draft form is the one surface that can switch provider, so every profile
  // the host can actually run is offered here.
  const profileProviders = useMemo(
    () => modelSelectorProviders.map((entry) => entry.id),
    [modelSelectorProviders],
  );
  const profileTarget = useMemo<AgentProfileApplyTarget>(
    () => ({
      kind: "draft",
      controls: {
        applyProfile: onApplyAgentProfile,
      },
    }),
    [onApplyAgentProfile],
  );
  const agentProfiles = useAgentProfilePicker({
    serverId: modelSelectorServerId,
    availableProviders: profileProviders,
    target: profileTarget,
  });
  const handleEditAgentProfiles = useEditAgentProfilesNavigation(
    modelSelectorServerId,
    agentProfiles !== null,
  );
  const profileEditor = useAgentProfileEditor(modelSelectorServerId);
  const profileActions = resolveAgentProfileEditorActions(agentProfiles !== null, profileEditor);

  const modeControl = useMemo<AgentModeControlValue | null>(
    () =>
      selectedProvider && modeOptions.length > 0
        ? {
            provider: selectedProvider,
            providerDefinitions,
            modeOptions,
            selectedModeId: selectedMode,
            onSelectMode,
            disabled,
          }
        : null,
    [selectedProvider, providerDefinitions, modeOptions, selectedMode, onSelectMode, disabled],
  );

  return (
    <>
      {profileEditor.element}
      <ControlledAgentControls
        provider={selectedProvider ?? ""}
        modelSelectorProviders={modelSelectorProviders}
        modelOptions={modelOptions}
        selectedModelId={selectedModel}
        onSelectModel={onSelectModel}
        onSelectProviderAndModel={onSelectProviderAndModel}
        isModelLoading={isAllModelsLoading}
        agentProfiles={agentProfiles}
        onApplyAgentProfile={agentProfiles?.applyProfile}
        onEditAgentProfiles={handleEditAgentProfiles}
        onCreateAgentProfile={profileActions.create}
        onEditAgentProfile={profileActions.edit}
        effortOptions={effortOptions}
        selectedEffortId={effectiveSelectedEffort}
        onSelectEffort={onSelectThinkingOption}
        features={features}
        onSetFeature={onSetFeature}
        onDropdownClose={onDropdownClose}
        onModelSelectorOpen={onModelSelectorOpen}
        onRetryModelProvider={onRetryModelProvider}
        isRetryingModelProvider={isRetryingModelProvider}
        disabled={disabled}
        modeControl={modeControl}
        modelSelectorServerId={modelSelectorServerId}
        isCompactLayout={isCompactLayout}
      >
        {children}
      </ControlledAgentControls>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  startCluster: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    overflow: "hidden",
  },
  endCluster: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  // Clusters clip, so they carry the triggers' vertical hit slop inside their own frame
  // without taking more height in the composer.
  clusterTouch: {
    gap: COMPOSER_TOOLBAR_GEOMETRY.touchControlGap,
    paddingVertical: COMPOSER_TOOLBAR_TOUCH_HIT_SLOP.top,
    marginVertical: -COMPOSER_TOOLBAR_TOUCH_HIT_SLOP.top,
  },
  featuresBadge: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 0,
    flexShrink: 0,
    backgroundColor: "transparent",
    borderRadius: theme.borderRadius.full,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
