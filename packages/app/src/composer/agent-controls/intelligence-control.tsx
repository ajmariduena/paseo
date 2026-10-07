import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from "react";
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
import {
  MODEL_BROWSER_MIN_WIDTH,
  ModelBrowser,
  useModelBrowser,
  useModelShortcutKeys,
  type ModelBrowserState,
} from "@/components/model-browser";
import { resolveModelBrowserScrolling } from "@/components/model-browser-view";
import { Combobox } from "@/components/ui/combobox";
import { resolveEffortDefaultIndex } from "@/components/ui/effort-stops";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AdvancedPage } from "@/composer/agent-controls/advanced-page";
import {
  resolveEffortSelection,
  type EffortOption,
  type EffortSelection,
  describeIntelligence,
} from "@/composer/agent-controls/effort-selection";
import { IntelligenceOverlay } from "@/composer/agent-controls/intelligence-overlay";
import { IntelligenceTrigger } from "@/composer/agent-controls/intelligence-trigger";
import { QuickCard } from "@/composer/agent-controls/quick-card";
import { getAgentControlHintKey } from "@/composer/agent-controls/utils";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

const ADVANCED_SNAP_POINTS: readonly string[] = ["55%", "90%"];
const MODELS_SNAP_POINTS: readonly string[] = ["85%", "90%"];
const CARD_MIN_WIDTH = 320;
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
  changeModel: string;
  slider: string;
  dismiss: string;
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
      desktopMinWidth: MODEL_BROWSER_MIN_WIDTH,
      desktopFixedHeight: input.browser.desktopFixedHeight,
      mobileSnapPoints: MODELS_SNAP_POINTS,
      // The browser owns its scroller inside the native sheet.
      mobileChildrenScrollEnabled: !isNative,
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
 * Page state for the control. The trigger opens the quick card; its model row goes straight to
 * the model browser, and picking a model comes back to the card.
 */
function useIntelligenceNavigation(input: {
  open: boolean;
  isCompact: boolean;
  browser: ModelBrowserState;
  onOpenChange: (open: boolean) => void;
  onOpen?: () => void;
  onClose?: () => void;
}) {
  const { open, isCompact, browser, onOpenChange, onOpen, onClose } = input;
  const { isActiveComposer } = useComposerKeyboardScope();
  const [page, setPage] = useState<IntelligencePage>("quick");
  const [modelsReturnPage, setModelsReturnPage] = useState<"quick" | "advanced">("quick");

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
  const pageRef = useRef(page);
  pageRef.current = page;
  const toggle = useCallback(() => {
    if (open) {
      close();
      return;
    }
    setPage("quick");
    handleOpenChange(true);
  }, [close, handleOpenChange, open]);

  // The overlay is portal'd, so a pane switch would leave it behind: close with the composer.
  useEffect(() => {
    if (open && !isActiveComposer) close();
  }, [close, isActiveComposer, open]);

  const openAdvanced = useCallback(() => {
    // The overlay keeps the keyboard; the sheet may take it.
    if (isCompact) Keyboard.dismiss();
    setPage("advanced");
  }, [isCompact]);
  const openModelsFrom = useCallback(
    (returnPage: "quick" | "advanced") => {
      if (isCompact) Keyboard.dismiss();
      browser.prepareToOpen();
      setModelsReturnPage(returnPage);
      setPage("models");
    },
    [browser, isCompact],
  );
  const openModels = useCallback(() => openModelsFrom("quick"), [openModelsFrom]);
  const openModelsFromAdvanced = useCallback(() => openModelsFrom("advanced"), [openModelsFrom]);
  const backFromModels = useCallback(() => {
    setPage(modelsReturnPage);
    browser.reset();
  }, [browser, modelsReturnPage]);
  const backToQuick = useCallback(() => setPage("quick"), []);
  /** ⌘⇧M: straight to the model browser, or closed again when it is already showing. */
  const toggleModels = useCallback(() => {
    if (open && pageRef.current === "models") {
      close();
      return;
    }
    if (!open) handleOpenChange(true);
    openModelsFrom("quick");
  }, [close, handleOpenChange, open, openModelsFrom]);
  const returnToQuick = useCallback(() => {
    setPage("quick");
    browser.reset();
  }, [browser]);

  return {
    page,
    modelsReturnPage,
    close,
    handleOpenChange,
    toggle,
    openAdvanced,
    openModels,
    openModelsFromAdvanced,
    backFromModels,
    backToQuick,
    returnToQuick,
    toggleModels,
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
  modelsReturnPage: "quick" | "advanced";
  browser: ModelBrowserState;
  isCompact: boolean;
  lean: boolean;
  backFromModels: () => void;
  backToQuick: () => void;
}): SheetHeader | undefined {
  const { t } = useTranslation();
  const { page, modelsReturnPage, browser, isCompact, lean, backFromModels, backToQuick } = input;
  return useMemo(() => {
    switch (page) {
      case "models": {
        const backLabel =
          modelsReturnPage === "advanced"
            ? t("agentControls.advanced.title")
            : t("agentControls.effort.title");
        return {
          ...browser.header,
          back: { onPress: backFromModels, label: backLabel },
        };
      }
      case "advanced":
        // Lean reaches Advanced from the overlay, which is already gone; roomy steps back.
        return {
          title: t("agentControls.advanced.title"),
          back: lean ? undefined : { onPress: backToQuick },
        };
      case "quick":
        return isCompact ? { title: t("agentControls.intelligence.title") } : undefined;
      default:
        throw new Error("unreachable");
    }
  }, [backFromModels, backToQuick, browser, isCompact, lean, modelsReturnPage, page, t]);
}

/** ⌘⇧M opens the model browser of the composer that has keyboard focus. */
function useModelPickerShortcut({
  enabled,
  onTrigger,
}: {
  enabled: boolean;
  onTrigger: () => void;
}) {
  const { isActiveComposer } = useComposerKeyboardScope();
  const handlerIdRef = useRef(`model-picker:${Math.random().toString(36).slice(2)}`);
  const handle = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (action.id !== "message-input.model-picker" || !isActiveComposer) return false;
      onTrigger();
      return true;
    },
    [isActiveComposer, onTrigger],
  );
  useKeyboardActionHandler({
    handlerId: handlerIdRef.current,
    actions: ["message-input.model-picker"],
    enabled: enabled && isActiveComposer,
    priority: 200,
    handle,
  });
}

/** The fast toggle for the quick chips, or undefined when nothing can flip it. */
function useFastToggle(input: {
  fastFeature: AgentFeatureToggle | null;
  isFast: boolean;
  onSetFeature: ((featureId: string, value: unknown) => void) | undefined;
}): (() => void) | undefined {
  const { fastFeature, isFast, onSetFeature } = input;
  const toggle = useCallback(() => {
    if (fastFeature) onSetFeature?.(fastFeature.id, !isFast);
  }, [fastFeature, isFast, onSetFeature]);
  return fastFeature && onSetFeature ? toggle : undefined;
}

/**
 * The composer's intelligence control: the toolbar trigger, the quick card with the model and the
 * effort slider, the model browser and Advanced behind it. On compact layouts the quick surface is
 * a keyboard-preserving overlay and the rest is a sheet; on wide layouts everything is one popover
 * with pages.
 */
export function IntelligenceControl(props: IntelligenceControlProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const anchorRef = useRef<View>(null);
  const browser = useModelBrowser({
    providers: props.providers,
    selectedProvider: props.provider,
    selectedModel: props.selectedModelId,
    isLoading: props.isModelLoading,
    autoFocusSearch: isWeb && !isCompact,
    profiles: props.profiles,
    serverId: props.serverId,
    lockedProvider: props.canSwitchProvider ? null : props.provider,
  });
  const effort = useMemo(
    () => resolveEffortSelection(props.effortOptions, props.selectedEffortId),
    [props.effortOptions, props.selectedEffortId],
  );
  const navigation = useIntelligenceNavigation({
    open: props.open,
    isCompact,
    browser,
    onOpenChange: props.onOpenChange,
    onOpen: props.onOpen,
    onClose: props.onClose,
  });
  const { page, close } = navigation;
  const profileActions = useProfileActions({ close, ...props });
  const header = usePageHeaders({
    page,
    modelsReturnPage: navigation.modelsReturnPage,
    browser,
    isCompact,
    lean: props.lean,
    backFromModels: navigation.backFromModels,
    backToQuick: navigation.backToQuick,
  });

  const { onSelectModel, onSelectEffort, fastFeature, effortOptions } = props;
  const [highlightToken, bumpHighlight] = useReducer((token: number) => token + 1, 0);
  const handleModelSelect = useCallback(
    (nextProvider: string, modelId: string) => {
      onSelectModel(nextProvider, modelId);
      navigation.returnToQuick();
      bumpHighlight();
    },
    [navigation, onSelectModel],
  );
  const { reset, canReset, isFast } = useResetAction({ effort, ...props });
  const modelShortcutKeys = useModelShortcutKeys(
    browser,
    handleModelSelect,
    props.open && page === "models" && !isCompact,
  );
  useModelPickerShortcut({
    enabled: props.canSelectModel && !props.disabled,
    onTrigger: navigation.toggleModels,
  });
  const toggleFast = useFastToggle({ fastFeature, isFast, onSetFeature: props.onSetFeature });

  const labels = useMemo<IntelligenceLabels>(
    () => ({
      advanced: t("agentControls.advanced.open"),
      changeModel: t("agentControls.quick.changeModel"),
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
  const openModels = props.canSelectModel ? navigation.openModels : undefined;

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
        effortLabel={effortLabel}
        tier={effort.tier}
        isFast={isFast}
        stops={effortOptions}
        value={effort.selectedId}
        onChange={onSelectEffort ?? noop}
        disabled={sliderDisabled}
        onPressLabel={openModels ?? navigation.openAdvanced}
        onOpenAdvanced={navigation.openAdvanced}
        fastFeature={fastFeature}
        onToggleFast={toggleFast}
        contextWindowMaxTokens={browser.selectedRow?.contextWindowMaxTokens}
        onDismiss={close}
        labels={labels}
        labelAccessibility={openModels ? labels.changeModel : labels.advanced}
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
        desktopKeyInterceptor={modelShortcutKeys}
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
          onOpenModels={openModels}
          onOpenModelsFromAdvanced={
            props.canSelectModel ? navigation.openModelsFromAdvanced : undefined
          }
          onOpenAdvanced={navigation.openAdvanced}
          onToggleFast={toggleFast}
          highlightToken={highlightToken}
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
  onOpenModelsFromAdvanced: (() => void) | undefined;
  onOpenAdvanced: () => void;
  onToggleFast: (() => void) | undefined;
  highlightToken: number;
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
          />
        </View>
      );
    case "advanced":
      return (
        <AdvancedPage
          modelLabel={props.browser.selectedModelLabel}
          onOpenModels={props.onOpenModelsFromAdvanced}
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
        <QuickCard
          provider={props.provider}
          providerLabel={
            props.providers.find((entry) => entry.id === props.provider)?.label ?? null
          }
          serverId={props.serverId}
          modelLabel={props.modelLabel || props.browser.selectedModelLabel}
          highlightToken={props.highlightToken}
          onChangeModel={props.onOpenModels}
          effort={props.effort}
          effortOptions={props.effortOptions}
          onSelectEffort={props.onSelectEffort ?? noop}
          sliderDisabled={props.sliderDisabled}
          sliderLabel={props.labels.slider}
          fastFeature={props.fastFeature}
          isFast={props.isFast}
          onToggleFast={props.onToggleFast}
          contextWindowMaxTokens={props.browser.selectedRow?.contextWindowMaxTokens}
          onOpenAdvanced={props.onOpenAdvanced}
          disabled={props.disabled}
        />
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
  modelsPage: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
}));
