import { memo, type ReactElement } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { SendMarker } from "./send-markers";

/** "Steer" or "Queued, then sent" above a sent message that did not start a turn of its own. */
export const SendMarkerLabel = memo(function SendMarkerLabel({
  marker,
}: {
  marker: SendMarker;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Text style={styles.marker} numberOfLines={1} testID="user-message-send-marker">
      {t(MARKER_LABEL_KEYS[marker])}
    </Text>
  );
});

const MARKER_LABEL_KEYS: Record<SendMarker, string> = {
  steered: "composer.sendModes.steeredMarker",
  queued: "composer.sendModes.queuedMarker",
};

const styles = StyleSheet.create((theme) => ({
  marker: {
    alignSelf: "flex-end",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[1],
    marginBottom: theme.spacing[1],
  },
}));
