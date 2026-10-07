import { useMemo } from "react";
import { Modal, Pressable, View } from "react-native";
import { X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isNative } from "@/constants/platform";
import { HtmlRenderFrame } from "./frame";
import type { RenderTheme } from "./document";
import type { VisualizationFrameOptions } from "./visualize-bridge";

interface HtmlRenderViewerProps {
  html: string;
  renderId: string;
  title: string;
  height: number;
  theme: RenderTheme;
  onClose: () => void;
  visualization?: VisualizationFrameOptions;
}

export function HtmlRenderViewer(props: HtmlRenderViewerProps) {
  const insets = useSafeAreaInsets();
  const gutter = isNative ? 16 : 24;
  const rootStyle = useMemo(
    () => ({
      flex: 1,
      backgroundColor: props.theme.variables["--background"],
      paddingTop: insets.top + gutter,
      paddingBottom: insets.bottom + gutter,
      paddingHorizontal: gutter,
    }),
    [gutter, insets.bottom, insets.top, props.theme],
  );
  return (
    <Modal visible animationType="fade" onRequestClose={props.onClose}>
      <View style={rootStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.visualization ? "Close visualization" : "Close HTML page"}
          onPress={props.onClose}
          style={closeStyle}
        >
          <X size={22} color={props.theme.variables["--foreground"]} />
        </Pressable>
        <View style={contentStyle}>
          <HtmlRenderFrame {...props} fullscreen />
        </View>
      </View>
    </Modal>
  );
}

const closeStyle = { alignSelf: "flex-end" as const, padding: 8 };
const contentStyle = { flex: 1 };
