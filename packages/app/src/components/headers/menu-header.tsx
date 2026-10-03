import { useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PanelLeft } from "lucide-react-native";
import { ScreenHeader } from "./screen-header";
import { ScreenTitle } from "./screen-title";
import { HeaderToggleButton, headerIconSlotStyle } from "./header-toggle-button";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { useHasWindowChromeObstruction, useOwnsWindowChromeCorner } from "@/utils/desktop-window";
import { iconButtonChromeGlyphSize } from "@/components/ui/icon-button-chrome";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import {
  useSidebarToggleAttentionBucket,
  type SidebarToggleAttentionBucket,
} from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_DOT_SIZE } from "@/utils/status-indicator-geometry";

interface MenuHeaderProps {
  title?: string;
  rightContent?: ReactNode;
  borderless?: boolean;
}

interface SidebarMenuToggleProps {
  style?: StyleProp<ViewStyle>;
  tooltipSide?: "left" | "right" | "top" | "bottom";
  testID?: string;
  nativeID?: string;
}

const MOBILE_MENU_LINE_WIDTH = 16;
const MOBILE_MENU_LINE_SHORT_WIDTH = 8;
const MOBILE_MENU_LINE_HEIGHT = 1.5;
const ATTENTION_DOT_INSET = 1 - STATUS_INDICATOR_DOT_SIZE / 2;

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundExtraMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});
const ThemedPanelLeft = withUnistyles(PanelLeft);

function MobileMenuIcon({ extraMuted }: { extraMuted: boolean }) {
  const colorStyle = extraMuted ? styles.mobileMenuLineExtraMuted : styles.mobileMenuLineMuted;
  return (
    <View style={styles.mobileMenuIcon} pointerEvents="none">
      <View style={[styles.mobileMenuLine, colorStyle]} />
      <View style={[styles.mobileMenuLine, colorStyle]} />
      <View style={[styles.mobileMenuLine, styles.mobileMenuLineShort, colorStyle]} />
    </View>
  );
}

function AttentionDot({
  bucket,
  testID,
}: {
  bucket: SidebarToggleAttentionBucket;
  testID: string;
}) {
  const colorStyle =
    bucket === "needs_input" ? styles.attentionDotNeedsInput : styles.attentionDotFailed;
  return (
    <View
      pointerEvents="none"
      testID={`${testID}-attention-${bucket}`}
      style={[styles.attentionDot, colorStyle]}
    />
  );
}

function SidebarMenuToggleButton({
  isMobile,
  extraMutedIdleIcon = false,
  resolvedStyle,
  tooltipSide = "right",
  testID = "menu-button",
  nativeID = "menu-button",
}: Omit<SidebarMenuToggleProps, "style"> & {
  isMobile: boolean;
  extraMutedIdleIcon?: boolean;
  resolvedStyle: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const isOpen = usePanelStore((state) => selectIsAgentListOpen(state, { isCompact: isMobile }));
  const activeWorkspace = useActiveWorkspaceSelection();
  const attentionBucket = useSidebarToggleAttentionBucket({
    activeServerId: activeWorkspace?.serverId ?? null,
    activeWorkspaceId: activeWorkspace?.workspaceId ?? null,
    isSidebarOpen: isOpen,
  });
  const toggleAgentListForLayout = usePanelStore((state) => state.toggleAgentListForLayout);
  const toggleShortcutKeys = useMemo(
    () => (getShortcutOs() === "mac" ? ["mod", "B"] : ["mod", "."]),
    [],
  );

  const handlePress = useCallback(() => {
    toggleAgentListForLayout({ isCompact: isMobile });
  }, [toggleAgentListForLayout, isMobile]);

  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);

  return (
    <HeaderToggleButton
      onPress={handlePress}
      tooltipLabel={t("shell.menu.toggleSidebar")}
      tooltipKeys={toggleShortcutKeys}
      tooltipSide={tooltipSide}
      testID={testID}
      nativeID={nativeID}
      style={resolvedStyle}
      accessible
      accessibilityRole="button"
      accessibilityLabel={isOpen ? t("shell.menu.close") : t("shell.menu.open")}
      accessibilityState={accessibilityState}
    >
      <View style={styles.glyphFrame} pointerEvents="none">
        {isMobile ? (
          <MobileMenuIcon extraMuted={extraMutedIdleIcon} />
        ) : (
          <ThemedPanelLeft
            size={iconButtonChromeGlyphSize("large")}
            strokeWidth={1.5}
            uniProps={
              extraMutedIdleIcon ? foregroundExtraMutedColorMapping : foregroundMutedColorMapping
            }
          />
        )}
        {attentionBucket ? <AttentionDot bucket={attentionBucket} testID={testID} /> : null}
      </View>
    </HeaderToggleButton>
  );
}

export function SidebarMenuToggle({ style, ...props }: SidebarMenuToggleProps = {}) {
  const isMobile = useIsCompactFormFactor();
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasTopLeftWindowControls = useHasWindowChromeObstruction("top-left");
  const resolvedStyle = useMemo(() => [styles.leadingToggle, style], [style]);
  const placeholderStyle = useMemo(
    () => [headerIconSlotStyle.slot, resolvedStyle],
    [resolvedStyle],
  );

  if (!isMobile && !ownsTopLeft) {
    return null;
  }

  if (!isMobile && hasTopLeftWindowControls) {
    return (
      <View pointerEvents="none" style={placeholderStyle}>
        <View style={styles.desktopMenuIconSpace} />
      </View>
    );
  }

  return <SidebarMenuToggleButton {...props} isMobile={isMobile} resolvedStyle={resolvedStyle} />;
}

export function WindowSidebarMenuToggle({ style, ...props }: SidebarMenuToggleProps = {}) {
  const resolvedStyle = useMemo(() => [styles.leadingToggle, style], [style]);
  return (
    <SidebarMenuToggleButton
      {...props}
      isMobile={false}
      extraMutedIdleIcon
      resolvedStyle={resolvedStyle}
    />
  );
}

export function MenuHeader({ title, rightContent, borderless }: MenuHeaderProps) {
  return (
    <ScreenHeader
      left={
        <>
          <SidebarMenuToggle />
          {title && <ScreenTitle>{title}</ScreenTitle>}
        </>
      }
      right={rightContent}
      leftStyle={styles.left}
      borderless={borderless}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  leadingToggle: {
    marginLeft: {
      xs: 0,
      md: -theme.spacing[2],
    },
  },
  left: {
    gap: theme.spacing[2],
  },
  mobileMenuIcon: {
    width: MOBILE_MENU_LINE_WIDTH,
    height: 12,
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  desktopMenuIconSpace: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
  },
  mobileMenuLine: {
    width: MOBILE_MENU_LINE_WIDTH,
    height: MOBILE_MENU_LINE_HEIGHT,
    borderRadius: theme.borderRadius.full,
  },
  mobileMenuLineShort: {
    width: MOBILE_MENU_LINE_SHORT_WIDTH,
  },
  mobileMenuLineMuted: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  mobileMenuLineExtraMuted: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  glyphFrame: {
    position: "relative",
  },
  attentionDot: {
    position: "absolute",
    top: ATTENTION_DOT_INSET,
    right: ATTENTION_DOT_INSET,
    width: STATUS_INDICATOR_DOT_SIZE,
    height: STATUS_INDICATOR_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.surface0,
  },
  attentionDotNeedsInput: {
    backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
  },
  attentionDotFailed: {
    backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
  },
}));
