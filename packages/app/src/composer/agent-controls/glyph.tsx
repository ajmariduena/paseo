import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

export function ComposerToolbarGlyph({ children, size }: { children: ReactNode; size: number }) {
  return (
    <View
      style={[styles.box, { width: size, height: size }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
