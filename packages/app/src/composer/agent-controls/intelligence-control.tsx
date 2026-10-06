import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  AgentFeature,
  AgentFeatureToggle,
  AgentProvider,
} from "@getpaseo/protocol/agent-types";
import type { AgentProfilePicker, AgentProfileSeed } from "@/agent-profiles";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import { ModelBrowser, useModelBrowser, type ModelBrowserState } from "@/components/model-browser";
import { resolveModelBrowserScrolling } from "@/components/model-browser-view";
import { Combobox } from "@/components/ui/combobox";
import { EffortSlider } from "@/components/ui/effort-slider";
import { resolveEffortDefaultIndex } from "@/components/ui/effort-stops";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AdvancedPage } from "@/composer/agent-controls/advanced-page";
import {
  resolveEffortSelection,
  resolveIntelligenceOpeningPage,
  type EffortOption,
  type EffortSelection,
  describeIntelligence,
} from "@/composer/agent-controls/effort-selection";
import { IntelligenceLabel } from "@/composer/agent-controls/intelligence-label";
import { IntelligenceOverlay } from "@/composer/agent-controls/intelligence-overlay";
import { IntelligenceTrigger } from "@/composer/agent-controls/intelligence-trigger";
import { resolveModelSheetOpening } from "@/composer/agent-controls/model-sheet-flow";
import { getAgentControlHintKey } from "@/composer/agent-controls/utils";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

const ADVANCED_SNAP_POINTS: readonly string[] = ["55%", "90%"];
const MODELS_SNAP_POINTS: readonly string[] = ["85%", "90%"];
const CARD_MIN_WIDTH = 320;
const MODELS_MIN_WIDTH = 360;
const EMPTY_OPTIONS: never[] = [];

function noop() {}

type IntelligencePage = "quick" | "advanced" | "models";

export interface IntelligenceControlProps {
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
  /** Every other provider feature, listed on the Advanced page. */
  features: readonly AgentFeature[];
  onSetFeature: ((featureId: string, value: unknown) => void) | undefined;
  /** The lean row opens the overlay; a roomy one opens the popover. */
  lean: boolean;
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

interface IntelligenceLabels {
  advanced: string;
  slider: string;
  dismiss: string;
}

function resolveAvailableProviders(input: {
  canSwitchProvider: boolean;
  providers: ProviderSelectorProvider[];
  provider: string;
}): ProviderSelectorProvider[] {
  if (input.canSwitchProvider) return input.providers;
  const fixedProvider =
    input.providers.find((entry) => entry.id === input.provider) ?? input.providers[0] ?? null;
  return fixedProvider ? [fixedProvider] : [];
}

/** Reset returns the effort to the model's default and switches Fast off. */
function useResetAction(input: {
  effort: EffortSelection;
  effortOptions: readonly EffortOption[];
  fastFeature: AgentFeatureToggle | null;
  onSelectEffort: ((effortId: string) => void) | undefined;
  onSetFeature: ((featureId: string, value: unknown) => void) | undefined;
}): { reset: () => void; canReset: boolean; isFast: boolean } {
  const { effort, effortOptions, fastFeature, onSelectEffort, onSetFeature } = input;
  const defaultOption = effortOptions[resolveEffortDefaultIndex(effortOptions)];
  const effortId = effort.hasEffort && !effort.isDefault && defaultOption ? defaultOption.id : null;
  const isFast = fastFeature?.value === true;
  const reset = useCallback(() => {
    if (effortId !== null) onSelectEffort?.(effortId);
    if (isFast && fastFeature) onSetFeature?.(fastFeature.id, false);
  }, [effortId, fastFeature, isFast, onSelectEffort, onSetFeature]);
  return { reset, canReset: effortId !== null || isFast, isFast };
}

/** The popover and sheet sizes differ only for the model browser's page. */
function resolveSurfaceLayout(input: { isModelsPage: boolean; browser: ModelBrowserState }) {
  if (input.isModelsPage) {
    return {
      desktopMinWidth: MODELS_MIN_WIDTH,
      desktopFixedHeight: input.browser.desktopFixedHeight,
      mobileSnapPoints: MODELS_SNAP_POINTS,
      mobileChildrenScrollEnabled: !input.browser.isProviderView || !isNative,
    };
  }
  return {
    desktopMinWidth: CARD_MIN_WIDTH,
    desktopFixedHeight: undefined,
    mobileSnapPoints: ADVANCED_SNAP_POINTS,
    mobileChildrenScrollEnabled: true,
  };
}

function resolveOpenLabel(page: IntelligencePage, t: (key: string) => string): string {
  switch (page) {
    case "quick":
      return t("agentControls.effort.choose");
    case "advanced":
      return t("agentControls.advanced.title");
    case "models":
      return t("modelSelector.selectModel");
    default:
      throw new Error("unreachable");
  }
}

/**
 * Page state for the control. The trigger opens the slider, or Advanced straight away when the
 * model has no effort scale; Advanced leads to the model browser and back.
 */
function useIntelligenceNavigation(input: {
  open: boolean;
  hasEffort: boolean;
  isCompact: boolean;
  browser: ModelBrowserState;
  availableProviders: ProviderSelectorProvider[];
  canSwitchProvider: boolean;
  provider: string;
  onOpenChange: (open: boolean) => void;
  onOpen?: () => void;
  onClose?: () => void;
}) {
  const { open, hasEffort, isCompact, browser, onOpenChange, onOpen, onClose } = input;
  const { isActiveComposer } = useComposerKeyboardScope();
  const [page, setPage] = useState<IntelligencePage>("quick");

  // The page stays put while the surface animates out; the next open picks its own page.
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        onOpen?.();
      } else {
        browser.reset();
        onClose?.();
      }
      onOpenChange(nextOpen);
    },
    [browser, onClose, onOpen, onOpenChange],
  );
  const close = useCallback(() => handleOpenChange(false), [handleOpenChange]);
  const toggle = useCallback(() => {
    if (open) {
      close();
      return;
    }
    setPage(resolveIntelligenceOpeningPage(hasEffort));
    handleOpenChange(true);
  }, [close, hasEffort, handleOpenChange, open]);

  // The overlay is portal'd, so a pane switch would leave it behind: close with the composer.
  useEffect(() => {
    if (open && !isActiveComposer) close();
  }, [close, isActiveComposer, open]);

  const openAdvanced = useCallback(() => {
    // The overlay keeps the keyboard; the sheet may take it.
    if (isCompact) Keyboard.dismiss();
    setPage("advanced");
  }, [isCompact]);
  const openModels = useCallback(() => {
    const destination = resolveModelSheetOpening({
      canSwitchProvider: input.canSwitchProvider,
      providers: input.availableProviders,
      selectedProvider: input.provider,
    });
    if (destination.kind === "all") {
      browser.showAll();
    } else {
      browser.drillDown(destination.providerId, destination.providerLabel);
    }
    setPage("models");
  }, [browser, input.availableProviders, input.canSwitchProvider, input.provider]);
  const backToAdvanced = useCallback(() => {
    setPage("advanced");
    browser.reset();
  }, [browser]);
  const backToQuick = useCallback(() => setPage("quick"), []);

  return {
    page,
    close,
    handleOpenChange,
    toggle,
    openAdvanced,
    openModels,
    backToAdvanced,
    backToQuick,
  };
}

/** Profile actions leave the control, so each one closes it first. */
function useProfileActions(input: {
  close: () => void;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
}) {
  const { close, onApplyProfile, onEditProfiles, onCreateProfile, onEditProfile } = input;
  const applyProfile = useCallback(
    (profileId: string) => {
      onApplyProfile?.(profileId);
      close();
    },
    [close, onApplyProfile],
  );
  const editProfiles = useCallback(() => {
    close();
    onEditProfiles?.();
  }, [close, onEditProfiles]);
  const createProfile = useCallback(
    (seed: AgentProfileSeed) => {
      close();
      onCreateProfile?.(seed);
    },
    [close, onCreateProfile],
  );
  const editProfile = useCallback(
    (profileId: string) => {
      close();
      onEditProfile?.(profileId);
    },
    [close, onEditProfile],
  );
  return {
    applyProfile,
    editProfiles: onEditProfiles ? editProfiles : undefined,
    createProfile: onCreateProfile ? createProfile : undefined,
    editProfile: onEditProfile ? editProfile : undefined,
  };
}

function usePageHeaders(input: {
  page: IntelligencePage;
  browser: ModelBrowserState;
  isCompact: boolean;
  lean: boolean;
  hasEffort: boolean;
  backToAdvanced: () => void;
  backToQuick: () => void;
}): SheetHeader | undefined {
  const { t } = useTranslation();
  const { page, browser, isCompact, lean, hasEffort, backToAdvanced, backToQuick } = input;
  return useMemo(() => {
    switch (page) {
      case "models":
        return {
          ...browser.header,
          title: browser.isProviderView ? browser.header.title : t("modelSelector.selectModel"),
          back: browser.header.back ?? { onPress: backToAdvanced },
        };
      case "advanced":
        // Lean reaches Advanced from the overlay, which is already gone; roomy steps back.
        return {
          title: t("agentControls.advanced.title"),
          back: lean || !hasEffort ? undefined : { onPress: backToQuick },
        };
      case "quick":
        return isCompact ? { title: t("agentControls.intelligence.title") } : undefined;
      default:
        throw new Error("unreachable");
    }
  }, [backToAdvanced, backToQuick, browser, hasEffort, isCompact, lean, page, t]);
}

/**
 * The composer's intelligence control: the toolbar trigger, the one-gesture effort surface, and
 * the Advanced page behind it. On compact layouts the effort surface is a keyboard-preserving
 * overlay and Advanced is a sheet; on wide layouts everything is one popover with pages.
 */
export function IntelligenceControl(props: IntelligenceControlProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const anchorRef = useRef<View>(null);
  const availableProviders = useMemo(() => resolveAvailableProviders(props), [props]);
  const browser = useModelBrowser({
    providers: availableProviders,
    selectedProvider: props.provider,
    selectedModel: props.selectedModelId,
    isLoading: props.isModelLoading,
    autoFocusSearch: isWeb && !isCompact,
    profiles: props.profiles,
    serverId: props.serverId,
  });
  const effort = useMemo(
    () => resolveEffortSelection(props.effortOptions, props.selectedEffortId),
    [props.effortOptions, props.selectedEffortId],
  );
  const navigation = useIntelligenceNavigation({
    open: props.open,
    hasEffort: effort.hasEffort,
    isCompact,
    browser,
    availableProviders,
    canSwitchProvider: props.canSwitchProvider,
    provider: props.provider,
    onOpenChange: props.onOpenChange,
    onOpen: props.onOpen,
    onClose: props.onClose,
  });
  const { page, close } = navigation;
  const profileActions = useProfileActions({ close, ...props });
  const header = usePageHeaders({
    page,
    browser,
    isCompact,
    lean: props.lean,
    hasEffort: effort.hasEffort,
    backToAdvanced: navigation.backToAdvanced,
    backToQuick: navigation.backToQuick,
  });

  const { onSelectModel, onSelectEffort, fastFeature, effortOptions } = props;
  const handleModelSelect = useCallback(
    (nextProvider: string, modelId: string) => {
      onSelectModel(nextProvider, modelId);
      navigation.backToAdvanced();
    },
    [navigation, onSelectModel],
  );
  const { reset, canReset, isFast } = useResetAction({ effort, ...props });

  const labels = useMemo<IntelligenceLabels>(
    () => ({
      advanced: t("agentControls.advanced.open"),
      slider: t("agentControls.effort.slider"),
      dismiss: t("agentControls.intelligence.dismiss"),
    }),
    [t],
  );
  const modelLabel = props.canSelectModel ? browser.triggerLabel : "";
  const effortLabel = effort.hasEffort ? effort.selectedLabel : null;
  const sliderDisabled = props.disabled || onSelectEffort === undefined;
  const overlayVisible = props.lean && props.open && page === "quick";
  const surface = resolveSurfaceLayout({ isModelsPage: page === "models", browser });

  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <IntelligenceTrigger
            ref={anchorRef}
            provider={props.provider}
            serverId={props.serverId}
            modelLabel={modelLabel}
            effortLabel={effortLabel}
            tier={effort.tier}
            isTop={effort.isTop}
            isFast={isFast}
            open={props.open}
            openLabel={props.open ? resolveOpenLabel(page, t) : null}
            disabled={props.disabled}
            onPress={navigation.toggle}
            accessibilityLabel={t("agentControls.effort.openWithValue", {
              value: describeIntelligence({
                modelLabel,
                effortLabel,
                fastLabel: fastFeature?.label,
                isFast,
              }),
            })}
            testID="combined-model-selector"
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t(getAgentControlHintKey("effort"))}</Text>
        </TooltipContent>
      </Tooltip>
      <IntelligenceOverlay
        visible={overlayVisible}
        modelLabel={modelLabel}
        effortLabel={effort.selectedLabel}
        tier={effort.tier}
        isFast={isFast}
        stops={effortOptions}
        value={effort.selectedId}
        onChange={onSelectEffort ?? noop}
        disabled={sliderDisabled}
        onOpenAdvanced={navigation.openAdvanced}
        onDismiss={close}
        labels={labels}
      />
      <Combobox
        options={EMPTY_OPTIONS}
        value=""
        onSelect={noop}
        open={props.open && !overlayVisible}
        onOpenChange={navigation.handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={surface.desktopMinWidth}
        desktopLockWidth
        desktopFixedHeight={surface.desktopFixedHeight}
        desktopChildrenScrollEnabled={false}
        header={header}
        mobileChildrenScrollEnabled={surface.mobileChildrenScrollEnabled}
        mobileChildrenContentContainerStyle={styles.mobileContent}
        mobileSnapPoints={surface.mobileSnapPoints}
      >
        <IntelligencePages
          page={page}
          browser={browser}
          isCompact={isCompact}
          effort={effort}
          modelLabel={modelLabel}
          isFast={isFast}
          sliderDisabled={sliderDisabled}
          labels={labels}
          canReset={canReset}
          onReset={reset}
          onModelSelect={handleModelSelect}
          onOpenModels={props.canSelectModel ? navigation.openModels : undefined}
          onOpenAdvanced={navigation.openAdvanced}
          profileActions={profileActions}
          {...props}
        />
      </Combobox>
    </>
  );
}

interface IntelligencePagesProps extends IntelligenceControlProps {
  page: IntelligencePage;
  browser: ModelBrowserState;
  isCompact: boolean;
  effort: EffortSelection;
  modelLabel: string;
  isFast: boolean;
  sliderDisabled: boolean;
  labels: IntelligenceLabels;
  canReset: boolean;
  onReset: () => void;
  onModelSelect: (provider: string, modelId: string) => void;
  onOpenModels: (() => void) | undefined;
  onOpenAdvanced: () => void;
  profileActions: ReturnType<typeof useProfileActions>;
}

function IntelligencePages(props: IntelligencePagesProps): ReactElement {
  switch (props.page) {
    case "models":
      return (
        <View style={styles.modelsPage} testID="agent-model-browser">
          <ModelBrowser
            state={props.browser}
            onSelect={props.onModelSelect}
            onApplyProfile={props.profileActions.applyProfile}
            onEditProfiles={props.profileActions.editProfiles}
            onCreateProfile={props.profileActions.createProfile}
            onEditProfile={props.profileActions.editProfile}
            onRetryProvider={props.onRetryProvider}
            isRetryingProvider={props.isRetryingProvider}
            scrolling={resolveModelBrowserScrolling({ isNative, isCompact: props.isCompact })}
            searchAllOnFocus={props.isCompact}
          />
        </View>
      );
    case "advanced":
      return (
        <AdvancedPage
          modelLabel={props.browser.selectedModelLabel}
          onOpenModels={props.onOpenModels}
          effort={props.effort}
          effortOptions={props.effortOptions}
          onSelectEffort={props.onSelectEffort}
          fastFeature={props.fastFeature}
          features={props.features}
          onSetFeature={props.onSetFeature}
          onReset={props.onReset}
          canReset={props.canReset}
          disabled={props.disabled}
        />
      );
    case "quick":
      return (
        <View style={styles.quick} testID="agent-effort-card">
          <IntelligenceLabel
            modelLabel={props.modelLabel}
            effortLabel={props.effort.selectedLabel}
            tier={props.effort.tier}
            isFast={props.isFast}
            size="card"
            disabled={props.disabled}
            onPress={props.onOpenAdvanced}
            accessibilityLabel={props.labels.advanced}
            testID="agent-effort-advanced"
          />
          <EffortSlider
            stops={props.effortOptions}
            value={props.effort.selectedId}
            onChange={props.onSelectEffort ?? noop}
            disabled={props.sliderDisabled}
            accessibilityLabel={props.labels.slider}
            testID="agent-effort-slider"
          />
        </View>
      );
    default:
      throw new Error("unreachable");
  }
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  mobileContent: {
    paddingHorizontal: 0,
  },
  quick: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  modelsPage: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
}));
