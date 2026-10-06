import { Pressable, StyleSheet as RNStyleSheet } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";

const BACKDROP_FADE_MS = 160;
// Android's blur is experimental and costly behind a live stream, so it gets a dark scrim.
const SCRIM_OPACITY = 0.85;

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
    opacity: SCRIM_OPACITY,
  },
}));
