import { createContext, useCallback, useContext, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  FlatList as SheetFlatList,
  ScrollView as SheetScrollView,
} from "@/components/ui/scroll-view";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  AlertTriangle,
  Check,
  Info,
  Pencil,
  Plus,
  Search,
  Settings,
  Star,
  UserRound,
} from "lucide-react-native";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  AgentProfileGlyph,
  type AgentProfilePicker,
  type AgentProfilePickerRow as AgentProfilePickerRowModel,
  type AgentProfileSeed,
} from "@/agent-profiles";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProviderIcon } from "@/components/provider-icons";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import {
  buildProviderQualifiedDescription,
  buildSelectedTriggerLabel,
  getProviderModelRows,
  resolveSelectedModelLabel,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { useModelFavoritesStore } from "@/stores/model-favorites-store";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { useCurrentOverlayLayer } from "@/lib/overlay-root";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  groupProfilesByProviderModel,
  resolveFavoriteRows,
  resolveInitialModelBrowserView,
  resolveModelBrowserSearch,
  resolveModelShortcutIndex,
  resolveSelectableProviders,
  resolveVisibleModelRows,
  type ModelBrowserSearch,
  type ModelBrowserView,
} from "@/components/model-browser-view";
import { isMacUserAgent } from "@/utils/mac-user-agent";

const DESKTOP_MIN_HEIGHT = 260;
const DESKTOP_MAX_HEIGHT = 440;
// The search row above the list and the provider footer below it.
const DESKTOP_CHROME_HEIGHT = 96;
const DESKTOP_MODEL_ROW_HEIGHT = 36;
const RAIL_TAB_SIZE = 36;
/** Rail plus a list wide enough for a model name and its description. */
export const MODEL_BROWSER_MIN_WIDTH = 400;
/** ⌘1–⌘9 pick the first nine rows of the list on screen. */
export const MODEL_SHORTCUT_COUNT = 9;

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedCheck = withUnistyles(Check);
const ThemedInfo = withUnistyles(Info);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedPencil = withUnistyles(Pencil);
const ThemedPlus = withUnistyles(Plus);
const ThemedSearch = withUnistyles(Search);
const ThemedSettings = withUnistyles(Settings);
const ThemedStar = withUnistyles(Star);
const ThemedUserRound = withUnistyles(UserRound);

function AgentProfilesEditAction({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={onPress}
          hitSlop={8}
          style={iconButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={t("modelSelector.editProfilesLabel")}
          testID="model-profiles-edit"
        >
          <ThemedPencil size={ICON_SIZE.xs} uniProps={foregroundExtraMutedMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("modelSelector.editProfilesLabel")}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const IndependentScrollGestureContext = createContext<ReturnType<typeof Gesture.Native> | null>(
  null,
);

const foregroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const foregroundMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});

const foregroundExtraMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});

const favoriteOnMapping = (theme: Theme) => ({
  color: theme.colors.statusWarning,
  fill: theme.colors.statusWarning,
});

interface ModelBrowserInput {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  isLoading: boolean;
  autoFocusSearch?: boolean;
  /** The Profiles tab's rows. `null` hides the tab. */
  profiles?: AgentProfilePicker | null;
  serverId?: string | null;
  /**
   * A started chat keeps its provider: the others stay on the rail, dimmed, instead of vanishing.
   * `null` lets the user pick any provider.
   */
  lockedProvider?: string | null;
}

export interface ModelBrowserState {
  serverId: string | null;
  /** Every provider on the host, locked ones included, in rail order. */
  providers: ProviderSelectorProvider[];
  /** The providers this pick may use. */
  selectableProviders: ProviderSelectorProvider[];
  lockedProvider: string | null;
  selectedProvider: string;
  selectedModel: string;
  profiles: AgentProfilePicker | null;
  favoriteRows: ProviderSelectionModelRow[];
  view: ModelBrowserView;
  selectView: (view: ModelBrowserView) => void;
  searchQuery: string;
  search: ModelBrowserSearch;
  /** The rows on screen, in order; ⌘1–⌘9 index into these. */
  visibleRows: ProviderSelectionModelRow[];
  header: SheetHeader;
  selectedModelLabel: string;
  triggerLabel: string;
  /** The selected model's row, when the catalog lists it. */
  selectedRow: ProviderSelectionModelRow | null;
  desktopFixedHeight: number;
  prepareToOpen: () => void;
  reset: () => void;
}

interface ModelBrowserProps {
  state: ModelBrowserState;
  onSelect: (provider: string, modelId: string) => void;
  /** Applying a profile resolves the pick and dismisses, exactly like a model row. */
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  scrolling?: "sheet" | "independent";
}

type ProviderGlyphTone = "muted" | "foreground";

export function ModelProviderGlyph({
  provider,
  serverId,
  size,
  tone = "muted",
}: {
  provider: string;
  serverId: string | null;
  size: number;
  tone?: ProviderGlyphTone;
}) {
  const Icon = useProviderIcon(provider, serverId);
  const color =
    tone === "foreground" ? styles.providerIconForeground.color : styles.providerIconMuted.color;
  return <Icon size={size} color={color} />;
}

function iconButtonStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.rowIconButton,
    Boolean(hovered) && styles.rowIconButtonHovered,
    pressed && styles.rowIconButtonPressed,
  ];
}

function viewKey(view: ModelBrowserView): string {
  return view.kind === "provider" ? `provider:${view.providerId}` : view.kind;
}

/**
 * One height for every tab, sized to the longest list, so switching tabs never resizes the
 * popover under the pointer.
 */
function resolveDesktopFixedHeight(input: {
  selectableProviders: ProviderSelectorProvider[];
  favoriteCount: number;
  tabCount: number;
}): number {
  const longest = Math.max(
    input.favoriteCount,
    ...input.selectableProviders.map((provider) => getProviderModelRows(provider).length),
  );
  const listHeight = DESKTOP_CHROME_HEIGHT + longest * DESKTOP_MODEL_ROW_HEIGHT;
  const railHeight = DESKTOP_CHROME_HEIGHT + input.tabCount * (RAIL_TAB_SIZE + 4);
  return Math.min(Math.max(DESKTOP_MIN_HEIGHT, listHeight, railHeight), DESKTOP_MAX_HEIGHT);
}

/** Desktop ⌘1–⌘9: pick the matching row of the open picker. Hand the result to the Combobox. */
export function useModelShortcutKeys(
  state: ModelBrowserState,
  onSelect: (provider: string, modelId: string) => void,
  enabled: boolean,
): ((event: KeyboardEvent) => boolean) | undefined {
  const { visibleRows } = state;
  const handle = useCallback(
    (event: KeyboardEvent) => {
      const index = resolveModelShortcutIndex(event, isMacUserAgent());
      if (index === null) return false;
      const row = visibleRows[index];
      if (!row) return false;
      onSelect(row.provider, row.modelId);
      return true;
    },
    [onSelect, visibleRows],
  );
  return enabled && isWeb ? handle : undefined;
}

export function useModelBrowser({
  providers,
  selectedProvider,
  selectedModel,
  isLoading,
  autoFocusSearch = isWeb,
  profiles = null,
  serverId = null,
  lockedProvider = null,
}: ModelBrowserInput): ModelBrowserState {
  const { t } = useTranslation();
  const [view, setView] = useState<ModelBrowserView>({ kind: "favorites" });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResetKey, bumpSearchResetKey] = useReducer((key: number) => key + 1, 0);
  const favoriteKeys = useModelFavoritesStore((state) => state.keys);
  const selectableProviders = useMemo(
    () => resolveSelectableProviders(providers, lockedProvider),
    [lockedProvider, providers],
  );
  const favoriteRows = useMemo(
    () => resolveFavoriteRows({ providers: selectableProviders, favoriteKeys }),
    [favoriteKeys, selectableProviders],
  );
  const hasProfiles = (profiles?.rows.length ?? 0) > 0;

  const reset = useCallback(() => {
    setSearchQuery("");
    bumpSearchResetKey();
  }, []);

  const prepareToOpen = useCallback(() => {
    setView(
      resolveInitialModelBrowserView({
        providers: selectableProviders,
        selectedProvider,
        favoriteCount: favoriteRows.length,
        hasProfiles,
      }),
    );
    reset();
  }, [favoriteRows.length, hasProfiles, reset, selectableProviders, selectedProvider]);

  const selectView = useCallback((next: ModelBrowserView) => setView(next), []);
  const search = useMemo(
    () =>
      resolveModelBrowserSearch({
        providers: selectableProviders,
        normalizedQuery: normalizeSearchQuery(searchQuery),
      }),
    [searchQuery, selectableProviders],
  );
  const visibleRows = useMemo(
    () => resolveVisibleModelRows({ view, search, selectableProviders, favoriteRows }),
    [favoriteRows, search, selectableProviders, view],
  );

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("modelSelector.selectModel"),
      search: {
        onChange: setSearchQuery,
        resetKey: searchResetKey,
        placeholder: t("modelSelector.searchPlaceholder"),
        autoFocus: autoFocusSearch,
        testID: "model-search-all-input",
      },
    }),
    [autoFocusSearch, searchResetKey, t],
  );

  const selectedModelLabel = useMemo(
    () =>
      resolveSelectedModelLabel({
        providers,
        selectedProvider,
        selectedModel,
        isLoading,
      }),
    [isLoading, providers, selectedModel, selectedProvider],
  );

  const triggerLabel = useMemo(() => {
    const isPlaceholder =
      selectedModelLabel === t("modelSelector.loading") ||
      selectedModelLabel === t("modelSelector.selectModel");
    return isPlaceholder ? selectedModelLabel : buildSelectedTriggerLabel(selectedModelLabel);
  }, [selectedModelLabel, t]);

  const selectedRow = useMemo(() => {
    const provider = providers.find((entry) => entry.id === selectedProvider);
    if (!provider) return null;
    return getProviderModelRows(provider).find((row) => row.modelId === selectedModel) ?? null;
  }, [providers, selectedModel, selectedProvider]);

  const desktopFixedHeight = useMemo(
    () =>
      resolveDesktopFixedHeight({
        selectableProviders,
        favoriteCount: favoriteRows.length,
        tabCount: providers.length + (profiles ? 2 : 1),
      }),
    [favoriteRows.length, profiles, providers.length, selectableProviders],
  );

  return {
    serverId,
    providers,
    selectableProviders,
    lockedProvider,
    selectedProvider,
    selectedModel,
    profiles,
    favoriteRows,
    view,
    selectView,
    searchQuery,
    search,
    visibleRows,
    header,
    selectedModelLabel,
    triggerLabel,
    selectedRow,
    desktopFixedHeight,
    prepareToOpen,
    reset,
  };
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

interface ModelBrowserPressableProps {
  children: React.ReactNode | ((state: PressableStateCallbackType) => React.ReactNode);
  style?:
    | StyleProp<ViewStyle>
    | ((state: PressableStateCallbackType & { hovered?: boolean }) => StyleProp<ViewStyle>);
  onPress: () => void;
  hitSlop?: number;
  accessibilityLabel?: string;
  /** Only rows that can express selection pass this; the rest stay unannotated. */
  accessibilitySelected?: boolean;
  testID?: string;
}

function ModelBrowserPressable({
  children,
  style,
  onPress,
  hitSlop,
  accessibilityLabel,
  accessibilitySelected,
  testID,
}: ModelBrowserPressableProps) {
  const independentScrollGesture = useContext(IndependentScrollGestureContext);
  const [pressed, setPressed] = useState(false);
  // Android's scroll handler must keep the pointer stream until release so a
  // fling survives leaving the short viewport. A simultaneous Tap keeps rows
  // interactive, while maxDistance makes a real scroll fail instead of select.
  const tapGesture = useMemo(() => {
    const gesture = Gesture.Tap()
      .maxDistance(8)
      .shouldCancelWhenOutside(true)
      .runOnJS(true)
      .onBegin(() => setPressed(true))
      .onEnd((_event, success) => {
        if (success) onPress();
      })
      .onFinalize(() => setPressed(false));
    if (hitSlop !== undefined) gesture.hitSlop(hitSlop);
    if (independentScrollGesture) {
      gesture.simultaneousWithExternalGesture(independentScrollGesture);
    }
    return gesture;
  }, [hitSlop, independentScrollGesture, onPress]);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "activate") onPress();
    },
    [onPress],
  );
  const accessibilityState = useMemo(
    () => (accessibilitySelected === undefined ? undefined : { selected: accessibilitySelected }),
    [accessibilitySelected],
  );

  if (!independentScrollGesture) {
    return (
      <Pressable
        onPress={handlePress}
        hitSlop={hitSlop}
        style={style}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        aria-selected={accessibilitySelected}
        testID={testID}
      >
        {children}
      </Pressable>
    );
  }

  const state = { pressed };
  const resolvedStyle = typeof style === "function" ? style(state) : style;
  const resolvedChildren = typeof children === "function" ? children(state) : children;
  return (
    <GestureDetector gesture={tapGesture}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        aria-selected={accessibilitySelected}
        accessibilityActions={[{ name: "activate" }]}
        onAccessibilityAction={handleAccessibilityAction}
        style={resolvedStyle}
        testID={testID}
      >
        {resolvedChildren}
      </View>
    </GestureDetector>
  );
}

type ModelBrowserRowTone = "default" | "elevated" | "drillDown";

function ModelBrowserRow({
  label,
  description,
  leadingSlot,
  trailingSlot,
  selected = false,
  selectionIndicator = false,
  tone = "default",
  labelMuted = false,
  spacing = "model",
  onPress,
  testID,
}: {
  label: string;
  description?: string;
  leadingSlot: React.ReactNode;
  trailingSlot?: React.ReactNode;
  selected?: boolean;
  selectionIndicator?: boolean;
  tone?: ModelBrowserRowTone;
  /** For rows that offer an action rather than name a thing you can pick. */
  labelMuted?: boolean;
  spacing?: "model" | "provider";
  onPress: () => void;
  testID?: string;
}) {
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.browserRow,
      spacing === "model" && styles.browserModelRow,
      Boolean(hovered) &&
        (tone === "elevated" ? styles.browserRowHoveredElevated : styles.browserRowHovered),
      pressed && (tone === "default" ? styles.browserRowPressed : styles.browserRowPressedElevated),
    ],
    [spacing, tone],
  );
  const contentStyle = useMemo(
    () => [styles.browserRowText, description && styles.browserRowTextInline],
    [description],
  );
  const hasTrailing = selected || trailingSlot;

  return (
    <ModelBrowserPressable
      onPress={onPress}
      style={pressableStyle}
      // A profile row is an action, not a selection, so it carries no selection
      // state at all — only rows that draw the checkmark claim one.
      accessibilitySelected={selectionIndicator ? selected : undefined}
      testID={testID}
    >
      <View style={styles.browserRowContent}>
        <View style={styles.browserRowLeading}>{leadingSlot}</View>
        <View style={contentStyle}>
          <Text
            numberOfLines={1}
            style={labelMuted ? styles.browserRowLabelMuted : styles.browserRowLabel}
          >
            {label}
          </Text>
          {description ? (
            <Text numberOfLines={1} style={styles.browserRowDescription}>
              {description}
            </Text>
          ) : null}
        </View>
        {hasTrailing ? (
          <View style={styles.browserRowTrailing}>
            {selectionIndicator ? (
              <View style={styles.browserRowSelection}>
                {selected ? (
                  <ThemedCheck size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
                ) : null}
              </View>
            ) : null}
            {trailingSlot}
          </View>
        ) : null}
      </View>
    </ModelBrowserPressable>
  );
}

function RowActionButton({
  visible,
  onPress,
  label,
  testID,
  children,
}: {
  visible: boolean;
  onPress: () => void;
  label: string;
  testID: string;
  children: React.ReactNode;
}) {
  const pressableStyle = useCallback(
    ({ hovered: buttonHovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.rowIconButton,
      Boolean(buttonHovered) && styles.rowIconButtonHovered,
      pressed && styles.rowIconButtonPressed,
      !visible && styles.rowActionHidden,
    ],
    [visible],
  );
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={onPress}
          hitSlop={8}
          style={pressableStyle}
          pointerEvents={visible ? "auto" : "none"}
          accessibilityRole="button"
          accessibilityLabel={label}
          testID={testID}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function ModelRowProfileAction({
  row,
  visible,
  profiledRows,
  onCreateProfile,
  onEditProfile,
  onEditProfiles,
}: {
  row: ProviderSelectionModelRow;
  visible: boolean;
  profiledRows: AgentProfilePickerRowModel[];
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  const { t } = useTranslation();
  const primary = profiledRows[profiledRows.length - 1];
  const handleCreateProfile = useCallback(() => {
    onCreateProfile?.({ provider: row.provider, modelId: row.modelId, name: row.modelLabel });
  }, [onCreateProfile, row.modelId, row.modelLabel, row.provider]);
  const handleEditProfile = useCallback(() => {
    if (primary) onEditProfile?.(primary.id);
  }, [onEditProfile, primary]);
  const handleEditProfiles = useCallback(() => onEditProfiles?.(), [onEditProfiles]);

  if (!primary) {
    return (
      <RowActionButton
        visible={visible}
        onPress={handleCreateProfile}
        label={t("modelSelector.createProfileFromModel")}
        testID={`model-create-profile-${row.provider}-${row.modelId}`}
      >
        <ThemedPlus size={ICON_SIZE.xs} uniProps={foregroundMutedMapping} />
      </RowActionButton>
    );
  }
  const single = profiledRows.length === 1;
  return (
    <RowActionButton
      visible={visible}
      onPress={single ? handleEditProfile : handleEditProfiles}
      label={
        single
          ? t("modelSelector.editProfileLabel", { name: primary.name })
          : t("modelSelector.editProfilesCount", { count: profiledRows.length })
      }
      testID={
        single
          ? `model-edit-profile-${row.provider}-${row.modelId}`
          : `model-edit-profiles-${row.provider}-${row.modelId}`
      }
    >
      <AgentProfileGlyph icon={primary.icon} color={primary.color} size={ICON_SIZE.xs} />
    </RowActionButton>
  );
}

function hasProfileAction(input: {
  row: ProviderSelectionModelRow;
  profiledRows: AgentProfilePickerRowModel[];
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}): boolean {
  if (input.row.modelId.length === 0) return false;
  if (input.profiledRows.length === 0) return Boolean(input.onCreateProfile);
  if (input.profiledRows.length === 1) return Boolean(input.onEditProfile);
  return Boolean(input.onEditProfiles);
}

interface ModelRowProps {
  row: ProviderSelectionModelRow;
  serverId: string | null;
  isSelected: boolean;
  showProviderLabel: boolean;
  onSelect: (provider: string, modelId: string) => void;
  profiledRows: AgentProfilePickerRowModel[];
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  isFavorite: boolean;
  onToggleFavorite: (key: string) => void;
  /** 1-based ⌘ shortcut shown on desktop, or null past the ninth row. */
  shortcut: number | null;
}

function ModelRow({
  row,
  serverId,
  isSelected,
  showProviderLabel,
  onSelect,
  profiledRows,
  onCreateProfile,
  onEditProfile,
  onEditProfiles,
  isFavorite,
  onToggleFavorite,
  shortcut,
}: ModelRowProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const actionsVisible = isHovered || isNative || isCompact;
  const description = showProviderLabel ? buildProviderQualifiedDescription(row) : row.description;
  const showProfileAction = hasProfileAction({
    row,
    profiledRows,
    onCreateProfile,
    onEditProfile,
    onEditProfiles,
  });
  const canFavorite = row.modelId.length > 0;
  const handlePress = useCallback(() => onSelect(row.provider, row.modelId), [onSelect, row]);
  const handleToggleFavorite = useCallback(
    () => onToggleFavorite(row.favoriteKey),
    [onToggleFavorite, row.favoriteKey],
  );
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.browserRow,
      isCompact && styles.browserRowCompact,
      Boolean(hovered) && styles.browserRowHovered,
      pressed && styles.browserRowPressed,
    ],
    [isCompact],
  );

  return (
    <View
      style={[styles.modelRowHoverBoundary, styles.browserModelRow]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <ModelBrowserPressable
        onPress={handlePress}
        style={pressableStyle}
        accessibilitySelected={isSelected}
        testID={`model-row-${row.provider}-${row.modelId}`}
      >
        <View style={styles.browserRowContent}>
          <View style={styles.browserRowLeading}>
            <ModelProviderGlyph provider={row.provider} serverId={serverId} size={ICON_SIZE.sm} />
          </View>
          <View style={[styles.browserRowText, description && styles.browserRowTextInline]}>
            <Text numberOfLines={1} style={styles.browserRowLabel}>
              {row.modelLabel}
            </Text>
            {description ? (
              <Text numberOfLines={1} style={styles.browserRowDescription}>
                {description}
              </Text>
            ) : null}
          </View>
          <View style={styles.browserRowTrailing}>
            {shortcut !== null && isWeb && !isCompact ? (
              <Text style={styles.shortcutHint}>{`⌘${shortcut}`}</Text>
            ) : null}
            <View style={styles.browserRowSelection}>
              {isSelected ? (
                <ThemedCheck size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
              ) : null}
            </View>
            {showProfileAction ? <View style={styles.rowIconButton} /> : null}
            {canFavorite ? <View style={styles.rowIconButton} /> : null}
          </View>
        </View>
      </ModelBrowserPressable>
      {/* The row renders a <button> on web, so its actions sit beside it, over the slots
          reserved above, rather than inside it. */}
      {showProfileAction || canFavorite ? (
        <View style={styles.modelRowActionSlot} pointerEvents="box-none">
          {showProfileAction ? (
            <ModelRowProfileAction
              row={row}
              visible={actionsVisible}
              profiledRows={profiledRows}
              onCreateProfile={onCreateProfile}
              onEditProfile={onEditProfile}
              onEditProfiles={onEditProfiles}
            />
          ) : null}
          {canFavorite ? (
            <RowActionButton
              visible={actionsVisible || isFavorite}
              onPress={handleToggleFavorite}
              label={t(isFavorite ? "modelSelector.unfavorite" : "modelSelector.favorite")}
              testID={`model-favorite-${row.provider}-${row.modelId}`}
            >
              <ThemedStar
                size={ICON_SIZE.xs}
                uniProps={isFavorite ? favoriteOnMapping : foregroundMutedMapping}
              />
            </RowActionButton>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function AgentProfilePickerRowView({
  row,
  onApply,
}: {
  row: AgentProfilePickerRowModel;
  onApply: (profileId: string) => void;
}) {
  const handlePress = useCallback(() => onApply(row.id), [onApply, row.id]);
  const leadingSlot = useMemo(
    () => <AgentProfileGlyph icon={row.icon} color={row.color} size={ICON_SIZE.sm} />,
    [row.color, row.icon],
  );
  return (
    <ModelBrowserRow
      label={row.name}
      description={row.summary}
      tone="elevated"
      onPress={handlePress}
      leadingSlot={leadingSlot}
      testID={`model-profile-row-${row.id}`}
    />
  );
}

/**
 * The Profiles tab. Rows are actions, not selections: applying a profile writes its values into
 * the composer and nothing stays bound to it, so there is no checkmark and no active row to show.
 */
function AgentProfilesPickerSection({
  rows,
  onApplyProfile,
  onEditProfiles,
}: {
  rows: AgentProfilePickerRowModel[];
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  const { t } = useTranslation();
  const handleApply = useCallback(
    (profileId: string) => onApplyProfile?.(profileId),
    [onApplyProfile],
  );
  return (
    <View style={styles.profilesContainer}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionHeadingText}>{t("modelSelector.profiles")}</Text>
        {onEditProfiles ? (
          <View style={styles.sectionHeadingAction}>
            <AgentProfilesEditAction onPress={onEditProfiles} />
          </View>
        ) : null}
      </View>
      {rows.map((row) => (
        <AgentProfilePickerRowView key={row.id} row={row} onApply={handleApply} />
      ))}
    </View>
  );
}

function CreateAgentProfileRow({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const leadingSlot = useMemo(
    () => (
      <View testID="model-profiles-create-icon">
        <ThemedPlus size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      </View>
    ),
    [],
  );
  return (
    <ModelBrowserRow
      label={t("modelSelector.createProfile")}
      labelMuted
      leadingSlot={leadingSlot}
      onPress={onPress}
      testID="model-profiles-empty"
    />
  );
}

function AgentProfilesPickerContent({
  rows,
  onApplyProfile,
  onEditProfiles,
}: {
  rows: AgentProfilePickerRowModel[];
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
}) {
  if (rows.length === 0) {
    return onEditProfiles ? <CreateAgentProfileRow onPress={onEditProfiles} /> : null;
  }
  return (
    <AgentProfilesPickerSection
      rows={rows}
      onApplyProfile={onApplyProfile}
      onEditProfiles={onEditProfiles}
    />
  );
}

interface RailTab {
  key: string;
  view: ModelBrowserView;
  label: string;
  locked: boolean;
  testID: string;
}

function useRailTabs(state: ModelBrowserState): RailTab[] {
  const { t } = useTranslation();
  return useMemo(() => {
    const tabs: RailTab[] = [
      {
        key: "favorites",
        view: { kind: "favorites" },
        label: t("modelSelector.favorites"),
        locked: false,
        testID: "model-tab-favorites",
      },
    ];
    for (const provider of state.providers) {
      tabs.push({
        key: `provider:${provider.id}`,
        view: { kind: "provider", providerId: provider.id, providerLabel: provider.label },
        label: provider.label,
        locked: state.lockedProvider !== null && provider.id !== state.lockedProvider,
        testID: `model-provider-${provider.id}`,
      });
    }
    if (state.profiles) {
      tabs.push({
        key: "profiles",
        view: { kind: "profiles" },
        label: t("modelSelector.profiles"),
        locked: false,
        testID: "model-tab-profiles",
      });
    }
    return tabs;
  }, [state.lockedProvider, state.profiles, state.providers, t]);
}

function RailTabIcon({
  tab,
  serverId,
  active,
  size,
}: {
  tab: RailTab;
  serverId: string | null;
  active: boolean;
  size: number;
}) {
  const mapping = active ? foregroundMapping : foregroundMutedMapping;
  switch (tab.view.kind) {
    case "favorites":
      return <ThemedStar size={size} uniProps={mapping} />;
    case "profiles":
      return <ThemedUserRound size={size} uniProps={mapping} />;
    case "provider":
      return (
        <ModelProviderGlyph
          provider={tab.view.providerId}
          serverId={serverId}
          size={size}
          tone={active ? "foreground" : "muted"}
        />
      );
    default:
      throw new Error("unreachable");
  }
}

function RailTabButton({
  tab,
  serverId,
  active,
  compact,
  onSelect,
}: {
  tab: RailTab;
  serverId: string | null;
  active: boolean;
  compact: boolean;
  onSelect: (view: ModelBrowserView) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (!tab.locked) onSelect(tab.view);
  }, [onSelect, tab.locked, tab.view]);
  const tooltip = tab.locked
    ? t("modelSelector.providerLocked", { provider: tab.label })
    : tab.label;
  const accessibilityState = useMemo(
    () => ({ selected: active, disabled: tab.locked }),
    [active, tab.locked],
  );
  const style = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) =>
      compact
        ? [
            styles.chip,
            active && styles.chipActive,
            !tab.locked && Boolean(hovered) && styles.chipHovered,
            !tab.locked && pressed && styles.chipHovered,
            tab.locked && styles.tabLocked,
          ]
        : [
            styles.railTab,
            active && styles.railTabActive,
            !tab.locked && Boolean(hovered) && styles.railTabHovered,
            !tab.locked && pressed && styles.railTabHovered,
            tab.locked && styles.tabLocked,
          ],
    [active, compact, tab.locked],
  );
  return (
    <Tooltip delayDuration={150} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={handlePress}
          style={style}
          accessibilityRole="tab"
          accessibilityLabel={tooltip}
          accessibilityState={accessibilityState}
          aria-selected={active}
          aria-disabled={tab.locked}
          testID={tab.testID}
        >
          <RailTabIcon
            tab={tab}
            serverId={serverId}
            active={active}
            size={compact ? ICON_SIZE.sm : ICON_SIZE.md}
          />
          {compact ? (
            <Text style={active ? styles.chipLabelActive : styles.chipLabel} numberOfLines={1}>
              {tab.label}
            </Text>
          ) : null}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

/** Desktop and tablet: a column of icons. Compact: a scrolling row of labelled chips. */
function ModelBrowserTabs({
  tabs,
  activeKey,
  serverId,
  compact,
  onSelect,
}: {
  tabs: RailTab[];
  activeKey: string;
  serverId: string | null;
  compact: boolean;
  onSelect: (view: ModelBrowserView) => void;
}) {
  const buttons = tabs.map((tab, index) => {
    const previous = tabs[index - 1];
    const startsGroup =
      !compact && previous !== undefined && (index === 1 || tab.view.kind === "profiles");
    return (
      <View key={tab.key} style={styles.railTabSlot}>
        {startsGroup ? <View style={styles.railSeparator} /> : null}
        <RailTabButton
          tab={tab}
          serverId={serverId}
          active={tab.key === activeKey}
          compact={compact}
          onSelect={onSelect}
        />
      </View>
    );
  });
  if (compact) {
    return (
      <SheetScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.chipsScroll}
        testID="model-browser-tabs"
      >
        {/* Padding on a real View: Unistyles styles do not resolve through contentContainerStyle on web. */}
        <View style={styles.chipsContent}>{buttons}</View>
      </SheetScrollView>
    );
  }
  return (
    <ScrollView
      style={styles.rail}
      showsVerticalScrollIndicator={false}
      accessibilityRole="tablist"
      testID="model-browser-tabs"
    >
      <View style={styles.railContent}>{buttons}</View>
    </ScrollView>
  );
}

function ProviderFooter({
  provider,
  serverId,
  lockedProvider,
}: {
  provider: ProviderSelectorProvider;
  serverId: string | null;
  lockedProvider: string | null;
}) {
  const { t } = useTranslation();
  const overlayParentLayer = useCurrentOverlayLayer();
  const handleManage = useCallback(() => {
    if (!serverId) return;
    useProviderSettingsStore
      .getState()
      .open({ serverId, provider: provider.id, overlayParentLayer });
  }, [overlayParentLayer, provider.id, serverId]);
  const manageStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.footerAction,
      (Boolean(hovered) || pressed) && styles.footerActionHovered,
    ],
    [],
  );
  return (
    <View>
      {lockedProvider !== null ? (
        <View style={styles.lockedNote} testID="model-provider-locked-note">
          <ThemedInfo size={ICON_SIZE.xs} uniProps={foregroundMutedMapping} />
          <Text style={styles.lockedNoteText}>
            {t("modelSelector.providerLockedNote", { provider: provider.label })}
          </Text>
        </View>
      ) : null}
      <View style={styles.footer}>
        <ModelProviderGlyph provider={provider.id} serverId={serverId} size={ICON_SIZE.xs} />
        <Text style={styles.footerLabel} numberOfLines={1}>
          {provider.label}
        </Text>
        <Pressable
          onPress={handleManage}
          disabled={!serverId}
          style={manageStyle}
          accessibilityRole="button"
          accessibilityLabel={t("modelSelector.openProviderSettings", {
            provider: provider.label,
          })}
          testID={`selector-header-settings-${provider.id}`}
        >
          <ThemedSettings size={ICON_SIZE.xs} uniProps={foregroundMutedMapping} />
          <Text style={styles.footerActionText}>{t("modelSelector.manageModels")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function IndependentScrollBoundary({ children }: { children: React.ReactElement }) {
  // Prevent the parent sheet from cancelling Android's native scroll when the
  // finger crosses this viewport; receiving ACTION_UP is what preserves fling.
  const nativeScrollGesture = useMemo(
    () =>
      Gesture.Native()
        .shouldActivateOnStart(true)
        .shouldCancelWhenOutside(false)
        .disallowInterruption(true),
    [],
  );

  if (Platform.OS !== "android") {
    return children;
  }

  return (
    <IndependentScrollGestureContext.Provider value={nativeScrollGesture}>
      <GestureDetector gesture={nativeScrollGesture}>{children}</GestureDetector>
    </IndependentScrollGestureContext.Provider>
  );
}

function IndependentModelList({
  rows,
  renderItem,
  header,
  footer,
}: {
  rows: ProviderSelectionModelRow[];
  renderItem: ({
    item,
    index,
  }: {
    item: ProviderSelectionModelRow;
    index: number;
  }) => React.ReactElement;
  header?: React.ReactElement | null;
  footer?: React.ReactElement | null;
}) {
  return (
    <IndependentScrollBoundary>
      <FlatList
        data={rows}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        keyExtractor={getModelRowKey}
        style={styles.virtualizedModelList}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.virtualizedModelListContent}
        nestedScrollEnabled
        testID="compact-model-list"
      />
    </IndependentScrollBoundary>
  );
}

function getModelRowKey(row: ProviderSelectionModelRow): string {
  return row.favoriteKey;
}

function ProviderErrorEmptyState({
  providerId,
  message,
  onRetryProvider,
  isRetryingProvider,
}: {
  providerId: string;
  message: string;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}) {
  const { t } = useTranslation();
  const handleRetry = useCallback(() => {
    onRetryProvider?.(providerId);
  }, [onRetryProvider, providerId]);
  return (
    <View style={styles.emptyState}>
      <ThemedAlertTriangle size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
      <Text style={styles.emptyStateText}>{message}</Text>
      {onRetryProvider ? (
        <Button variant="default" size="sm" onPress={handleRetry} disabled={isRetryingProvider}>
          {isRetryingProvider ? t("modelSelector.retrying") : t("modelSelector.retry")}
        </Button>
      ) : null}
    </View>
  );
}

function ModelSearchEmptyState() {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState}>
      <ThemedSearch size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
      <Text style={styles.emptyStateText}>{t("modelSelector.noMatches")}</Text>
    </View>
  );
}

function ModelRowList({
  rows,
  serverId,
  selectedProvider,
  selectedModel,
  onSelect,
  showProviderLabel,
  header,
  footer,
  scrolling,
  profiledLookup,
  onCreateProfile,
  onEditProfile,
  onEditProfiles,
  favoriteKeys,
  onToggleFavorite,
}: {
  rows: ProviderSelectionModelRow[];
  serverId: string | null;
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: string, modelId: string) => void;
  showProviderLabel: boolean;
  header?: React.ReactElement | null;
  footer?: React.ReactElement | null;
  scrolling: "sheet" | "independent";
  profiledLookup: Map<string, AgentProfilePickerRowModel[]>;
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  favoriteKeys: ReadonlySet<string>;
  onToggleFavorite: (key: string) => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const renderItem = useCallback(
    ({ item, index }: { item: ProviderSelectionModelRow; index: number }) => (
      <ModelRow
        row={item}
        serverId={serverId}
        isSelected={item.provider === selectedProvider && item.modelId === selectedModel}
        showProviderLabel={showProviderLabel}
        onSelect={onSelect}
        profiledRows={profiledLookup.get(`${item.provider}:${item.modelId}`) ?? []}
        onCreateProfile={onCreateProfile}
        onEditProfile={onEditProfile}
        onEditProfiles={onEditProfiles}
        isFavorite={favoriteKeys.has(item.favoriteKey)}
        onToggleFavorite={onToggleFavorite}
        shortcut={index < MODEL_SHORTCUT_COUNT ? index + 1 : null}
      />
    ),
    [
      favoriteKeys,
      onCreateProfile,
      onEditProfile,
      onEditProfiles,
      onSelect,
      onToggleFavorite,
      profiledLookup,
      selectedModel,
      selectedProvider,
      serverId,
      showProviderLabel,
    ],
  );

  if (scrolling === "independent") {
    return (
      <IndependentModelList rows={rows} renderItem={renderItem} header={header} footer={footer} />
    );
  }

  if (isCompact && isNative) {
    return (
      <SheetFlatList
        data={rows}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        keyExtractor={getModelRowKey}
        style={styles.virtualizedModelList}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.virtualizedModelListContent}
        testID="compact-model-list"
      />
    );
  }

  return (
    <View>
      {header}
      {rows.map((row, index) => (
        <View key={row.favoriteKey}>{renderItem({ item: row, index })}</View>
      ))}
      {footer}
    </View>
  );
}

/** Loading, error, empty and Profiles bodies scroll like the list they stand in for. */
function StaticBody({
  scrolling,
  header,
  footer,
  children,
}: {
  scrolling: "sheet" | "independent";
  header?: React.ReactElement | null;
  footer?: React.ReactElement | null;
  children: React.ReactNode;
}) {
  const content = (
    <View style={styles.staticBodyContent}>
      {header}
      {children}
      {footer}
    </View>
  );
  if (scrolling === "independent") {
    return (
      <IndependentScrollBoundary>
        <ScrollView
          style={styles.virtualizedModelList}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
          testID="compact-provider-list"
        >
          {content}
        </ScrollView>
      </IndependentScrollBoundary>
    );
  }
  return (
    <SheetScrollView
      style={styles.virtualizedModelList}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator={false}
      testID="compact-provider-list"
    >
      {content}
    </SheetScrollView>
  );
}

function ProviderLoadingState() {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState}>
      <View style={styles.rowSpinner}>
        <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      </View>
      <Text style={styles.emptyStateText}>{t("modelSelector.loadingShort")}</Text>
    </View>
  );
}

function FavoritesEmptyState() {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState} testID="model-favorites-empty">
      <ThemedStar size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
      <Text style={styles.emptyStateText}>{t("modelSelector.favoritesEmpty")}</Text>
    </View>
  );
}

function SearchNoMatches({ query }: { query: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState} testID="model-search-empty">
      <ThemedSearch size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
      <Text style={styles.emptyStateText}>
        {t("modelSelector.noMatchesForQuery", { query: query.trim() })}
      </Text>
    </View>
  );
}

function ProviderTabBody({
  provider,
  listProps,
  header,
  scrolling,
  serverId,
  lockedProvider,
  onRetryProvider,
  isRetryingProvider,
}: {
  provider: ProviderSelectorProvider | null;
  listProps: Omit<ModelRowListProps, "rows" | "showProviderLabel" | "header" | "footer">;
  header: React.ReactElement | null;
  scrolling: "sheet" | "independent";
  serverId: string | null;
  lockedProvider: string | null;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}) {
  const footer = useMemo(
    () =>
      provider ? (
        <ProviderFooter provider={provider} serverId={serverId} lockedProvider={lockedProvider} />
      ) : null,
    [lockedProvider, provider, serverId],
  );
  if (!provider) {
    return (
      <StaticBody scrolling={scrolling} header={header}>
        <ModelSearchEmptyState />
      </StaticBody>
    );
  }
  const selection = provider.modelSelection;
  if (selection.kind === "loading") {
    return (
      <StaticBody scrolling={scrolling} header={header} footer={footer}>
        <ProviderLoadingState />
      </StaticBody>
    );
  }
  if (selection.kind === "error") {
    return (
      <StaticBody scrolling={scrolling} header={header} footer={footer}>
        <ProviderErrorEmptyState
          providerId={provider.id}
          message={selection.message}
          onRetryProvider={onRetryProvider}
          isRetryingProvider={isRetryingProvider}
        />
      </StaticBody>
    );
  }
  return (
    <ModelRowList
      {...listProps}
      rows={selection.rows}
      showProviderLabel={false}
      header={header}
      footer={footer}
    />
  );
}

type ModelRowListProps = Parameters<typeof ModelRowList>[0];

function ModelBrowserBody({
  state,
  header,
  scrolling,
  onSelect,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  onRetryProvider,
  isRetryingProvider,
}: {
  state: ModelBrowserState;
  header: React.ReactElement | null;
  scrolling: "sheet" | "independent";
  onSelect: (provider: string, modelId: string) => void;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}) {
  const search = state.search;
  const profiledLookup = useMemo(
    () => groupProfilesByProviderModel(state.profiles?.rows ?? []),
    [state.profiles],
  );
  const favoriteKeyList = useModelFavoritesStore((store) => store.keys);
  const favoriteKeys = useMemo(() => new Set(favoriteKeyList), [favoriteKeyList]);
  const toggleFavorite = useModelFavoritesStore((store) => store.toggle);
  const listProps = useMemo(
    () => ({
      serverId: state.serverId,
      selectedProvider: state.selectedProvider,
      selectedModel: state.selectedModel,
      onSelect,
      scrolling,
      profiledLookup,
      onCreateProfile,
      onEditProfile,
      onEditProfiles,
      favoriteKeys,
      onToggleFavorite: toggleFavorite,
    }),
    [
      favoriteKeys,
      onCreateProfile,
      onEditProfile,
      onEditProfiles,
      onSelect,
      profiledLookup,
      scrolling,
      state.selectedModel,
      state.selectedProvider,
      state.serverId,
      toggleFavorite,
    ],
  );

  if (search.kind === "noMatches") {
    return (
      <StaticBody scrolling={scrolling}>
        <SearchNoMatches query={state.searchQuery} />
      </StaticBody>
    );
  }
  if (search.kind === "results") {
    return <ModelRowList {...listProps} rows={search.rows} showProviderLabel />;
  }

  const view = state.view;
  switch (view.kind) {
    case "favorites":
      if (state.favoriteRows.length === 0) {
        return (
          <StaticBody scrolling={scrolling} header={header}>
            <FavoritesEmptyState />
          </StaticBody>
        );
      }
      return (
        <ModelRowList {...listProps} rows={state.favoriteRows} showProviderLabel header={header} />
      );
    case "profiles": {
      const selectable = new Set(state.selectableProviders.map((provider) => provider.id));
      const rows = (state.profiles?.rows ?? []).filter((row) => selectable.has(row.provider));
      return (
        <StaticBody scrolling={scrolling} header={header}>
          <AgentProfilesPickerContent
            rows={rows}
            onApplyProfile={onApplyProfile}
            onEditProfiles={onEditProfiles}
          />
        </StaticBody>
      );
    }
    case "provider":
      return (
        <ProviderTabBody
          provider={state.providers.find((entry) => entry.id === view.providerId) ?? null}
          listProps={listProps}
          header={header}
          scrolling={scrolling}
          serverId={state.serverId}
          lockedProvider={state.providers.length > 1 ? state.lockedProvider : null}
          onRetryProvider={onRetryProvider}
          isRetryingProvider={isRetryingProvider}
        />
      );
    default:
      throw new Error("unreachable");
  }
}

/**
 * T3-style picker: a rail of Favorites, one tab per provider, and Profiles beside the list;
 * typing searches every provider the pick may use and hides the rail. Compact layouts turn the
 * rail into a row of chips above the list.
 */
export function ModelBrowser({
  state,
  onSelect,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  onRetryProvider,
  isRetryingProvider = false,
  scrolling = "sheet",
}: ModelBrowserProps) {
  const isCompact = useIsCompactFormFactor();
  const tabs = useRailTabs(state);
  const searching = state.search.kind !== "idle";
  const tabsNode =
    !searching && tabs.length > 1 ? (
      <ModelBrowserTabs
        tabs={tabs}
        activeKey={viewKey(state.view)}
        serverId={state.serverId}
        compact={isCompact}
        onSelect={state.selectView}
      />
    ) : null;
  const body = (
    <ModelBrowserBody
      state={state}
      header={isCompact ? tabsNode : null}
      scrolling={scrolling}
      onSelect={onSelect}
      onApplyProfile={onApplyProfile}
      onEditProfiles={onEditProfiles}
      onCreateProfile={onCreateProfile}
      onEditProfile={onEditProfile}
      onRetryProvider={onRetryProvider}
      isRetryingProvider={isRetryingProvider}
    />
  );
  if (isCompact) return body;
  return (
    <View style={styles.railLayout}>
      {tabsNode}
      <View style={styles.railBody}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  profilesContainer: {
    paddingBottom: theme.spacing[1],
  },
  railLayout: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  railBody: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  rail: {
    width: 48,
    flexGrow: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  railContent: {
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  railTabSlot: {
    alignItems: "center",
    gap: theme.spacing[1],
  },
  railSeparator: {
    width: 20,
    height: 1,
    marginVertical: theme.spacing[1],
    backgroundColor: theme.colors.border,
  },
  railTab: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  railTabActive: {
    backgroundColor: theme.colors.surface3,
  },
  railTabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tabLocked: {
    opacity: 0.35,
  },
  chipsScroll: {
    flexGrow: 0,
  },
  chipsContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
    paddingVertical: theme.spacing[2],
  },
  chip: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipActive: {
    backgroundColor: theme.colors.surface3,
    borderColor: "transparent",
  },
  chipHovered: {
    backgroundColor: theme.colors.surface2,
  },
  chipLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  chipLabelActive: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  shortcutHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
    fontVariant: ["tabular-nums"],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
    paddingHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  footerAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  footerActionHovered: {
    backgroundColor: theme.colors.surface2,
  },
  footerActionText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  lockedNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
    marginHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  lockedNoteText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    color: theme.colors.foregroundMuted,
  },
  staticBodyContent: {
    paddingBottom: theme.spacing[2],
  },
  sectionHeading: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  sectionHeadingAction: {
    position: "absolute",
    top: theme.spacing[1],
    right: isWeb ? theme.spacing[3] : theme.spacing[6],
  },
  sectionHeadingText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  browserRow: {
    flexDirection: "row",
    paddingVertical: theme.spacing[2],
    minHeight: 36,
  },
  modelRowHoverBoundary: {
    position: "relative",
  },
  modelRowActionSlot: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: isWeb ? theme.spacing[3] : theme.spacing[6],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  browserModelRow: isWeb ? {} : { marginBottom: theme.spacing[1] },
  browserRowCompact: {
    minHeight: 52,
  },
  browserRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  browserRowHoveredElevated: {
    backgroundColor: theme.colors.surface2,
  },
  browserRowPressed: {
    backgroundColor: theme.colors.surface1,
  },
  browserRowPressedElevated: {
    backgroundColor: theme.colors.surface2,
  },
  browserRowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
  },
  browserRowLeading: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  browserRowText: {
    flex: 1,
    flexShrink: 1,
  },
  browserRowTextInline: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  browserRowLabel: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  browserRowLabelMuted: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  browserRowDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  browserRowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: "auto",
  },
  browserRowSelection: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  rowStateInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
    minWidth: 0,
  },
  rowIconButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  rowSpinner: {
    transform: [{ scale: 0.7 }],
  },
  rowIconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowIconButtonPressed: {
    backgroundColor: theme.colors.surface1,
  },
  rowActionHidden: {
    opacity: 0,
  },
  emptyState: {
    paddingVertical: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyStateText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  virtualizedModelList: {
    flex: 1,
  },
  virtualizedModelListContent: {
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[8],
  },

  providerIconMuted: {
    color: theme.colors.foregroundMuted,
  },
  providerIconForeground: {
    color: theme.colors.foreground,
  },
}));
