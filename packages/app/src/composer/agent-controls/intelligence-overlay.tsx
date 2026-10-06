import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { StyleSheet as RNStyleSheet, View, useWindowDimensions } from "react-native";
import { Portal } from "@gorhom/portal";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeOut, useAnimatedStyle } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import {
  measureFloatingPanelPortalHost,
  useFloatingPanelPortalHostName,
} from "@/components/ui/floating-panel-portal";
import { EffortSlider, type EffortSliderStop } from "@/components/ui/effort-slider";
import type { EffortTier } from "@/components/ui/effort-stops";
import { IntelligenceBackdrop } from "@/composer/agent-controls/intelligence-backdrop";
import { IntelligenceLabel } from "@/composer/agent-controls/intelligence-label";
import { isWeb } from "@/constants/platform";
import { useKeyboardShift } from "@/keyboard/shift";
import { useOverlayLayer, useWebOverlayRegistration } from "@/lib/overlay-root";
import { useBlockMobilePanelOpenGestures } from "@/mobile-panels/provider";
import { SPACING } from "@/styles/theme";

const KEYBOARD_GAP = SPACING[4];
const DISMISS_DISTANCE = 48;
const CONTENT_FADE_MS = 160;
// A phone's width: wider rows (an iPad in portrait) center the label and slider at this width.
const SHEET_MAX_WIDTH = 420;

export interface IntelligenceOverlayProps {
  visible: boolean;
  modelLabel: string;
  effortLabel: string;
  tier: EffortTier;
  isFast: boolean;
  stops: readonly EffortSliderStop[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
  onOpenAdvanced: () => void;
  onDismiss: () => void;
  labels: {
    advanced: string;
    slider: string;
    dismiss: string;
  };
}

/**
 * The Codex-style effort control for compact layouts: a Portal (never a Modal, so the IME stays
 * attached to the composer) that blurs the chat and floats one label and the large slider just
 * above the keyboard. Tap outside, swipe down, or Escape closes it; changing the level does not.
 */
export function IntelligenceOverlay(props: IntelligenceOverlayProps): ReactElement | null {
  "use no memo";
  // React Compiler memoizes effect captures by reading SharedValue.value during render.
  const { visible, onDismiss } = props;
  const portalHostName = useFloatingPanelPortalHostName();
  const { shift, bottomInset } = useKeyboardShift();
  const windowDimensions = useWindowDimensions();
  const [hostBottomOffset, setHostBottomOffset] = useState<number | null>(null);
  const contentRef = useRef<View>(null);

  useBlockMobilePanelOpenGestures(visible);

  useEffect(() => {
    if (!visible) {
      setHostBottomOffset(null);
      return;
    }
    let cancelled = false;
    void measureFloatingPanelPortalHost(portalHostName).then((hostRect) => {
      if (cancelled || !hostRect) return undefined;
      setHostBottomOffset(Math.max(0, windowDimensions.height - (hostRect.y + hostRect.height)));
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [portalHostName, visible, windowDimensions.height]);

  const handleWebKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      onDismiss();
      return true;
    },
    [onDismiss],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb && visible,
    layer: useOverlayLayer("floating"),
    onKeyDown: handleWebKeyDown,
  });
  const setContentRef = useCallback(
    (node: View | null) => {
      contentRef.current = node;
      setWebOverlayScope(node);
    },
    [setWebOverlayScope],
  );

  const dismissGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        // A downward drag closes; the slider keeps horizontal drags for itself.
        .activeOffsetY(16)
        .failOffsetX([-12, 12])
        .onEnd((event) => {
          if (event.translationY > DISMISS_DISTANCE) onDismiss();
        }),
    [onDismiss],
  );

  const offset = hostBottomOffset ?? 0;
  const bottomStyle = useAnimatedStyle(
    () => ({
      bottom: Math.max(0, shift.value + bottomInset.value + KEYBOARD_GAP - offset),
    }),
    [offset],
  );

  if (!visible || hostBottomOffset === null) return null;

  return (
    <Portal hostName={portalHostName}>
      <View style={RNStyleSheet.absoluteFill} testID="agent-intelligence-overlay">
        <IntelligenceBackdrop onPress={onDismiss} accessibilityLabel={props.labels.dismiss} />
        <Animated.View
          ref={setContentRef}
          collapsable={false}
          style={[positionStyles.content, bottomStyle]}
          entering={FadeIn.duration(CONTENT_FADE_MS)}
          exiting={FadeOut.duration(CONTENT_FADE_MS)}
        >
          <GestureDetector gesture={dismissGesture}>
            <View style={styles.sheet} collapsable={false}>
              <IntelligenceLabel
                modelLabel={props.modelLabel}
                effortLabel={props.effortLabel}
                tier={props.tier}
                isFast={props.isFast}
                size="overlay"
                disabled={props.disabled}
                onPress={props.onOpenAdvanced}
                accessibilityLabel={props.labels.advanced}
                testID="agent-effort-advanced"
              />
              <EffortSlider
                stops={props.stops}
                value={props.value}
                onChange={props.onChange}
                disabled={props.disabled}
                size="large"
                accessibilityLabel={props.labels.slider}
                testID="agent-effort-slider"
              />
            </View>
          </GestureDetector>
        </Animated.View>
      </View>
    </Portal>
  );
}

// Plain React Native styles: this node is animated by Reanimated (docs/unistyles.md).
const positionStyles = RNStyleSheet.create({
  content: {
    position: "absolute",
    left: 0,
    right: 0,
  },
});

const styles = StyleSheet.create((theme) => ({
  sheet: {
    width: "100%",
    maxWidth: SHEET_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
}));
