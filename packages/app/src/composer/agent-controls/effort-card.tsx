import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight, RotateCcw, Zap } from "lucide-react-native";
import type { AgentFeatureToggle, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentControlIcon, AgentControlIconProps } from "@/agent-controls/icons";
import type { AgentProfilePicker, AgentProfileSeed } from "@/agent-profiles";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import {
  ModelBrowser,
  ModelProviderGlyph,
  useModelBrowser,
  type ModelBrowserState,
} from "@/components/model-browser";
import { resolveModelBrowserScrolling } from "@/components/model-browser-view";
import { Combobox } from "@/components/ui/combobox";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { EFFORT_ARRIVAL_PULSE_MS, EffortSlider } from "@/components/ui/effort-slider";
import {
  resolveEffortDefaultIndex,
  resolveEffortStopIndex,
  resolveEffortTier,
  type EffortTier,
} from "@/components/ui/effort-stops";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { resolveModelSheetOpening } from "@/composer/agent-controls/model-sheet-flow";
import { getAgentControlHintKey, getFeatureTooltip } from "@/composer/agent-controls/utils";
import { useIsCompactFormFactor, useControlDensity } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedZap = withUnistyles(Zap);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const fastOnMapping = (theme: Theme) => ({ color: theme.colors.accentBright });
const fastTopMapping = (theme: Theme) => ({ color: theme.colors.statusMerged });

const CARD_SNAP_POINTS: readonly string[] = ["40%", "90%"];
const MODELS_SNAP_POINTS: readonly string[] = ["85%", "90%"];
const CARD_MIN_WIDTH = 320;
const MODELS_MIN_WIDTH = 360;
const ARRIVAL_RISE_MS = 300;
const EMPTY_OPTIONS: never[] = [];
const FAST_STATES = { on: { selected: true }, off: { selected: false } } as const;

function noop() {}

export interface EffortOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

type EffortCardPage = "card" | "models";

export interface ModelEffortControlProps {
  canSelectModel: boolean;
  provider: string;
  serverId: string | null;
  providers: ProviderSelectorProvider[];
  selectedModelId: string;
  onSelectModel: (provider: AgentProvider, modelId: string) => void;
  canSwitchProvider: boolean;
  isModelLoading: boolean;
  disabled: boolean;
  effortOptions: readonly EffortOption[];
  selectedEffortId: string | undefined;
  onSelectEffort: ((effortId: string) => void) | undefined;
  fastFeature: AgentFeatureToggle | null;
  onSetFeature: ((featureId: string, value: unknown) => void) | undefined;
  profiles: AgentProfilePicker | null;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

interface EffortSelection {
  hasEffort: boolean;
  index: number;
  tier: EffortTier;
  isTop: boolean;
  isDefault: boolean;
  selected: EffortOption | null;
}

function resolveEffortSelection(
  options: readonly EffortOption[],
  selectedId: string | undefined,
): EffortSelection {
  const hasEffort = options.length > 1;
  const index = resolveEffortStopIndex(options, selectedId);
  const tier = resolveEffortTier(index, options.length);
  return {
    hasEffort,
    index,
    tier,
    isTop: hasEffort && tier === "top",
    isDefault: index === resolveEffortDefaultIndex(options),
    selected: options[index] ?? null,
  };
}

// The bolt reads its tint from the theme, not from the trigger's `color`: off is muted, on takes
// the accent, and on at the top stop joins the top stop's family.
function FastOffIcon({ size }: AgentControlIconProps) {
  return <ThemedZap size={size} uniProps={mutedIconMapping} />;
}
function FastOnIcon({ size }: AgentControlIconProps) {
  return <ThemedZap size={size} uniProps={fastOnMapping} />;
}
function FastTopIcon({ size }: AgentControlIconProps) {
  return <ThemedZap size={size} uniProps={fastTopMapping} />;
}

function resolveFastIcon(enabled: boolean, tier: EffortTier): AgentControlIcon {
  if (!enabled) return FastOffIcon;
  return tier === "top" ? FastTopIcon : FastOnIcon;
}

function effortNameTierStyle(tier: EffortTier) {
  switch (tier) {
    case "low":
      return styles.effortNameLow;
    case "mid":
      return styles.effortNameMid;
    case "high":
      return styles.effortNameHigh;
    case "top":
      return styles.effortNameTop;
    default:
      throw new Error("unreachable");
  }
}

function modelRowStyle({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.modelRow,
    Boolean(hovered) && styles.modelRowHovered,
    pressed && styles.modelRowPressed,
  ];
}

function resolveModelAccess(
  canSelectModel: boolean,
  page: EffortCardPage,
  label: string,
  openModels: () => void,
) {
  return {
    isModelsPage: canSelectModel && page === "models",
    modelLabel: canSelectModel ? label : "",
    onOpenModels: canSelectModel ? openModels : undefined,
  };
}

/**
 * The composer's model · effort pill and the card it opens. The card is the effort slider first;
 * the model list is a page behind it, reached from the model row and left by picking a model.
 */
export function ModelEffortControl({
  canSelectModel,
  provider,
  serverId,
  providers,
  selectedModelId,
  onSelectModel,
  canSwitchProvider,
  isModelLoading,
  disabled,
  effortOptions,
  selectedEffortId,
  onSelectEffort,
  fastFeature,
  onSetFeature,
  profiles,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  onRetryProvider,
  isRetryingProvider,
  open,
  onOpenChange,
  onOpen,
  onClose,
}: ModelEffortControlProps) {
  const { t } = useTranslation();
  const { hitSlop, presentation } = useComposerControlLayout();
  const isCompact = useIsCompactFormFactor();
  const anchorRef = useRef<View>(null);
  const [page, setPage] = useState<EffortCardPage>("card");

  const availableProviders = useMemo(() => {
    if (canSwitchProvider) return providers;
    const fixedProvider = providers.find((entry) => entry.id === provider) ?? providers[0] ?? null;
    return fixedProvider ? [fixedProvider] : [];
  }, [canSwitchProvider, provider, providers]);
  const browser = useModelBrowser({
    providers: availableProviders,
    selectedProvider: provider,
    selectedModel: selectedModelId,
    isLoading: isModelLoading,
    autoFocusSearch: isWeb && !isCompact,
    profiles,
    serverId,
  });

  const effort = useMemo(
    () => resolveEffortSelection(effortOptions, selectedEffortId),
    [effortOptions, selectedEffortId],
  );

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        onOpen?.();
      } else {
        setPage("card");
        browser.reset();
        onClose?.();
      }
      onOpenChange(nextOpen);
    },
    [browser, onClose, onOpen, onOpenChange],
  );

  const handleTriggerPress = useCallback(() => handleOpenChange(!open), [handleOpenChange, open]);

  const openModels = useCallback(() => {
    const destination = resolveModelSheetOpening({
      canSwitchProvider,
      providers: availableProviders,
      selectedProvider: provider,
    });
    if (destination.kind === "all") {
      browser.showAll();
    } else {
      browser.drillDown(destination.providerId, destination.providerLabel);
    }
    setPage("models");
  }, [availableProviders, browser, canSwitchProvider, provider]);

  const backToCard = useCallback(() => {
    setPage("card");
    browser.reset();
  }, [browser]);

  const handleModelSelect = useCallback(
    (nextProvider: string, modelId: string) => {
      onSelectModel(nextProvider, modelId);
      backToCard();
    },
    [backToCard, onSelectModel],
  );

  const handleApplyProfile = useCallback(
    (profileId: string) => {
      onApplyProfile?.(profileId);
      close();
    },
    [close, onApplyProfile],
  );
  const handleEditProfiles = useCallback(() => {
    close();
    onEditProfiles?.();
  }, [close, onEditProfiles]);
  const handleCreateProfile = useCallback(
    (seed: AgentProfileSeed) => {
      close();
      onCreateProfile?.(seed);
    },
    [close, onCreateProfile],
  );
  const handleEditProfile = useCallback(
    (profileId: string) => {
      close();
      onEditProfile?.(profileId);
    },
    [close, onEditProfile],
  );

  const modelsHeader = useMemo<SheetHeader>(() => {
    const header = browser.header;
    return {
      ...header,
      title: browser.isProviderView ? header.title : t("modelSelector.selectModel"),
      back: header.back ?? { onPress: backToCard },
    };
  }, [backToCard, browser.header, browser.isProviderView, t]);
  const cardHeader = useMemo<SheetHeader | undefined>(
    () => (isCompact ? { title: t("agentControls.effort.title") } : undefined),
    [isCompact, t],
  );
  const { isModelsPage, modelLabel, onOpenModels } = resolveModelAccess(
    canSelectModel,
    page,
    browser.triggerLabel,
    openModels,
  );

  const openLabel = isModelsPage
    ? t("modelSelector.selectModel")
    : t("agentControls.effort.choose");
  const effortLabel = effort.selected?.label ?? "";
  const pillValue = [modelLabel, effortLabel, fastFeature?.label].filter(Boolean).join(" · ");

  const triggerStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      effort.isTop && !open && styles.triggerTop,
      Boolean(hovered) && styles.triggerHovered,
      (pressed || open) && styles.triggerPressed,
      disabled && styles.triggerDisabled,
    ],
    [disabled, effort.isTop, open],
  );

  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <ComboboxTrigger
            ref={anchorRef}
            collapsable={false}
            disabled={disabled}
            onPress={handleTriggerPress}
            hitSlop={hitSlop}
            style={triggerStyle}
            accessibilityRole="button"
            accessibilityLabel={t("agentControls.effort.openWithValue", { value: pillValue })}
            testID="combined-model-selector"
            chevron={presentation.showCarets ? undefined : null}
          >
            <PillLabel
              provider={provider}
              serverId={serverId}
              modelLabel={modelLabel}
              effortLabel={effort.hasEffort ? effortLabel : null}
              isTop={effort.isTop}
              openLabel={open ? openLabel : null}
            />
          </ComboboxTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t(getAgentControlHintKey("effort"))}</Text>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={EMPTY_OPTIONS}
        value=""
        onSelect={noop}
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={isModelsPage ? MODELS_MIN_WIDTH : CARD_MIN_WIDTH}
        desktopLockWidth
        desktopFixedHeight={isModelsPage ? browser.desktopFixedHeight : undefined}
        desktopChildrenScrollEnabled={false}
        header={isModelsPage ? modelsHeader : cardHeader}
        mobileChildrenScrollEnabled={!isModelsPage || !browser.isProviderView || !isNative}
        mobileChildrenContentContainerStyle={styles.mobileContent}
        mobileSnapPoints={isModelsPage ? MODELS_SNAP_POINTS : CARD_SNAP_POINTS}
      >
        {isModelsPage ? (
          <ModelsPage
            browser={browser}
            isCompact={isCompact}
            onSelect={handleModelSelect}
            onApplyProfile={handleApplyProfile}
            onEditProfiles={onEditProfiles ? handleEditProfiles : undefined}
            onCreateProfile={onCreateProfile ? handleCreateProfile : undefined}
            onEditProfile={onEditProfile ? handleEditProfile : undefined}
            onRetryProvider={onRetryProvider}
            isRetryingProvider={isRetryingProvider}
          />
        ) : (
          <EffortCard
            effort={effort}
            effortOptions={effortOptions}
            onSelectEffort={onSelectEffort}
            fastFeature={fastFeature}
            onSetFeature={onSetFeature}
            modelLabel={modelLabel}
            selectedModelLabel={browser.selectedModelLabel}
            onOpenModels={onOpenModels}
            disabled={disabled}
          />
        )}
      </Combobox>
    </>
  );
}

function PillLabel({
  provider,
  serverId,
  modelLabel,
  effortLabel,
  isTop,
  openLabel,
}: {
  provider: string;
  serverId: string | null;
  modelLabel: string;
  effortLabel: string | null;
  isTop: boolean;
  openLabel: string | null;
}): ReactElement {
  const { glyphSize, presentation } = useComposerControlLayout();
  const glyph =
    provider.trim().length > 0 ? (
      <ComposerToolbarGlyph size={glyphSize}>
        <ModelProviderGlyph provider={provider} serverId={serverId} size={glyphSize} />
      </ComposerToolbarGlyph>
    ) : null;

  if (openLabel !== null) {
    return (
      <>
        {glyph}
        <Text style={styles.triggerOpenText} numberOfLines={1}>
          {openLabel}
        </Text>
      </>
    );
  }

  return (
    <>
      {glyph}
      {presentation.showModelLabel ? (
        <Text style={styles.triggerModelText} numberOfLines={1} ellipsizeMode="tail">
          {modelLabel}
        </Text>
      ) : null}
      {effortLabel !== null && presentation.showEffortSuffix ? (
        <Text
          style={[styles.triggerEffortText, isTop && styles.triggerEffortTopText]}
          numberOfLines={1}
          testID="agent-effort-suffix"
        >
          {effortLabel}
        </Text>
      ) : null}
    </>
  );
}

function ModelsPage({
  browser,
  isCompact,
  onSelect,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  onRetryProvider,
  isRetryingProvider,
}: {
  browser: ModelBrowserState;
  isCompact: boolean;
  onSelect: (provider: string, modelId: string) => void;
  onApplyProfile: (profileId: string) => void;
  onEditProfiles: (() => void) | undefined;
  onCreateProfile: ((seed: AgentProfileSeed) => void) | undefined;
  onEditProfile: ((profileId: string) => void) | undefined;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}): ReactElement {
  return (
    <View style={styles.modelsPage} testID="agent-model-browser">
      <ModelBrowser
        state={browser}
        onSelect={onSelect}
        onApplyProfile={onApplyProfile}
        onEditProfiles={onEditProfiles}
        onCreateProfile={onCreateProfile}
        onEditProfile={onEditProfile}
        onRetryProvider={onRetryProvider}
        isRetryingProvider={isRetryingProvider}
        scrolling={resolveModelBrowserScrolling({ isNative, isCompact })}
        searchAllOnFocus={isCompact}
      />
    </View>
  );
}

function EffortCard({
  effort,
  effortOptions,
  onSelectEffort,
  fastFeature,
  onSetFeature,
  modelLabel,
  selectedModelLabel,
  onOpenModels,
  disabled,
}: {
  effort: EffortSelection;
  effortOptions: readonly EffortOption[];
  onSelectEffort: ((effortId: string) => void) | undefined;
  fastFeature: AgentFeatureToggle | null;
  onSetFeature: ((featureId: string, value: unknown) => void) | undefined;
  modelLabel: string;
  selectedModelLabel: string;
  onOpenModels: (() => void) | undefined;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const touch = useControlDensity() === "touch";
  const modelTargetStyle = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) => [
      modelRowStyle(state),
      touch && styles.modelRowTouch,
    ],
    [touch],
  );

  const handleReset = useCallback(() => {
    const defaultOption = effortOptions[resolveEffortDefaultIndex(effortOptions)];
    if (defaultOption) onSelectEffort?.(defaultOption.id);
  }, [effortOptions, onSelectEffort]);

  const handleToggleFast = useCallback(() => {
    if (fastFeature) onSetFeature?.(fastFeature.id, !fastFeature.value);
  }, [fastFeature, onSetFeature]);

  const modelChevron = useMemo(
    () => (
      <View style={styles.modelRowChevron}>
        <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
      </View>
    ),
    [],
  );

  const description = effort.hasEffort ? effort.selected?.description : undefined;

  return (
    <View style={styles.card} testID="agent-effort-card">
      <View style={styles.cardRow}>
        <View style={styles.cardCorner}>
          {fastFeature ? (
            <AgentControlTrigger
              icon={resolveFastIcon(fastFeature.value, effort.tier)}
              surface="toolbar"
              label={fastFeature.label}
              showToolbarLabel={false}
              disabled={disabled}
              onPress={handleToggleFast}
              accessibilityLabel={getFeatureTooltip(fastFeature)}
              accessibilityState={FAST_STATES[fastFeature.value ? "on" : "off"]}
              testID="agent-effort-fast"
            />
          ) : null}
        </View>
        <View style={styles.cardCenter}>
          {effort.hasEffort ? (
            <EffortName label={effort.selected?.label ?? ""} tier={effort.tier} />
          ) : null}
          {description ? (
            <Text style={styles.effortDescription} numberOfLines={2}>
              {description}
            </Text>
          ) : null}
          {onOpenModels ? (
            <ComboboxTrigger
              disabled={disabled}
              onPress={onOpenModels}
              style={modelTargetStyle}
              accessibilityRole="button"
              accessibilityLabel={t("modelSelector.selectedModel", { model: selectedModelLabel })}
              testID="agent-effort-model"
              chevron={modelChevron}
            >
              <Text style={styles.modelRowText} numberOfLines={1}>
                {modelLabel}
              </Text>
            </ComboboxTrigger>
          ) : null}
        </View>
        <View style={styles.cardCorner}>
          {effort.hasEffort ? (
            <AgentControlTrigger
              icon={RotateCcw}
              surface="toolbar"
              label={t("agentControls.effort.reset")}
              showToolbarLabel={false}
              disabled={disabled || effort.isDefault}
              onPress={handleReset}
              accessibilityLabel={t("agentControls.effort.reset")}
              testID="agent-effort-reset"
            />
          ) : null}
        </View>
      </View>
      {effort.hasEffort ? (
        <EffortSlider
          stops={effortOptions}
          value={effort.selected?.id ?? ""}
          onChange={onSelectEffort ?? noop}
          disabled={disabled || !onSelectEffort}
          accessibilityLabel={t("agentControls.effort.slider")}
          testID="agent-effort-slider"
        />
      ) : null}
    </View>
  );
}

/** The level's name, tinted by tier, with a glow that swells when the thumb lands on the top stop. */
function EffortName({ label, tier }: { label: string; tier: EffortTier }) {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(0);
  const previousTierRef = useRef(tier);

  useEffect(() => {
    const arrived = tier === "top" && previousTierRef.current !== "top";
    previousTierRef.current = tier;
    if (!arrived || reduceMotion) return;
    pulse.value = withSequence(
      withTiming(1, { duration: ARRIVAL_RISE_MS }),
      withTiming(0, { duration: EFFORT_ARRIVAL_PULSE_MS - ARRIVAL_RISE_MS }),
    );
  }, [pulse, reduceMotion, tier]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * 0.06 }],
    textShadowRadius: pulse.value * 14,
  }));

  return (
    <Animated.Text
      style={[styles.effortName, effortNameTierStyle(tier), pulseStyle]}
      numberOfLines={1}
      testID="agent-effort-name"
    >
      {label}
    </Animated.Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    backgroundColor: "transparent",
  },
  triggerTop: {
    backgroundColor: theme.colors.statusMergedTint,
    borderColor: theme.colors.statusMergedTint,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface0,
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  triggerModelText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  triggerEffortText: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  triggerEffortTopText: {
    color: theme.colors.statusMerged,
  },
  triggerOpenText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  mobileContent: {
    paddingHorizontal: 0,
  },
  card: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[3],
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  cardCorner: {
    width: 28,
    height: 28,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  cardCenter: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    gap: theme.spacing[1],
  },
  effortName: {
    fontSize: theme.fontSize["2xl"],
    lineHeight: theme.fontSize["2xl"] * 1.4,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
    textShadowColor: theme.colors.statusMerged,
    textShadowOffset: { width: 0, height: 0 },
  },
  effortNameLow: {
    color: theme.colors.foregroundMuted,
  },
  effortNameMid: {
    color: theme.colors.accentBright,
  },
  effortNameHigh: {
    color: theme.colors.statusWarning,
  },
  effortNameTop: {
    color: theme.colors.statusMerged,
  },
  effortDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  modelsPage: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
  modelRow: {
    height: 28,
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: "transparent",
  },
  modelRowTouch: { height: "auto", minHeight: 44 },
  modelRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  modelRowPressed: {
    backgroundColor: theme.colors.surface0,
  },
  modelRowText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  modelRowChevron: {
    flexShrink: 0,
  },
}));
