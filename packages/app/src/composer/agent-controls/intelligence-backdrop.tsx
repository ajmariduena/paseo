import { Pressable, StyleSheet as RNStyleSheet } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BlurView } from "expo-blur";
import type { Theme } from "@/styles/theme";

const BACKDROP_FADE_MS = 160;
const BLUR_INTENSITY = 40;

const ThemedBlurView = withUnistyles(BlurView, (theme: Theme) => ({
  tint: theme.colorScheme === "dark" ? ("dark" as const) : ("light" as const),
}));

/** iOS and web blur the chat behind the overlay; a light scrim on top settles the contrast. */
export function IntelligenceBackdrop({
  onPress,
  accessibilityLabel,
}: {
  onPress: () => void;
  accessibilityLabel: string;
}) {
  return (
    <Animated.View
      entering={FadeIn.duration(BACKDROP_FADE_MS)}
      exiting={FadeOut.duration(BACKDROP_FADE_MS)}
      style={RNStyleSheet.absoluteFill}
    >
      <ThemedBlurView intensity={BLUR_INTENSITY} style={RNStyleSheet.absoluteFill} />
      <Pressable
        style={styles.scrim}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID="agent-intelligence-backdrop"
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  scrim: {
    ...RNStyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface0,
    opacity: theme.opacity[50],
  },
}));
