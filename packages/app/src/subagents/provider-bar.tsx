import { type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CornerLeftUp } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/utils/time";
import type { ProviderSubagentBarStatus } from "./provider-bar-status";
import { useElapsedNow } from "./presentation/use-elapsed-now";

const ICON_SIZE = 20;

function ProviderSubagentBarStatusText({
  status,
}: {
  status: ProviderSubagentBarStatus;
}): ReactElement {
  const { t } = useTranslation();
  const now = useElapsedNow(status.kind === "working");
  let text: string;
  switch (status.kind) {
    case "starting":
      text = t("subagents.status.starting");
      break;
    case "working":
      text = t("subagents.providerBar.working", {
        duration: formatDuration(Math.max(0, now - status.since.getTime())),
      });
      break;
    case "completed":
      text = t("subagents.providerBar.completedIn", {
        duration: formatDuration(status.durationMs),
      });
      break;
    case "failed":
      text = t("subagents.status.failed");
      break;
    case "stopped":
      text = t("subagents.status.stopped");
      break;
  }
  return (
    <Text style={styles.status} numberOfLines={1} testID="provider-subagent-bar-status">
      {text}
    </Text>
  );
}

/**
 * Stands in the composer slot of a read-only provider subagent pane: what runs there, how long
 * it has run, and the way back to whoever started it. A missing composer already says the pane
 * takes no input, so the bar does not repeat it.
 */
export function ProviderSubagentBar({
  serverId,
  provider,
  label,
  status,
  onOpenParent,
}: {
  serverId: string;
  provider: string;
  label: string;
  status: ProviderSubagentBarStatus;
  onOpenParent: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const Icon = useProviderIcon(provider, serverId);
  return (
    <View style={styles.slot} testID="provider-subagent-bar">
      <View style={styles.bar}>
        <Icon size={ICON_SIZE} color={styles.icon.color} />
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <ProviderSubagentBarStatusText status={status} />
        <View style={styles.spacer} />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={CornerLeftUp}
          onPress={onOpenParent}
          testID="provider-subagent-bar-open-parent"
        >
          {t("subagents.providerBar.openParent")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  bar: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: {
      xs: 56,
      md: 72,
    },
    paddingLeft: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
    paddingRight: {
      xs: theme.spacing[2],
      md: theme.spacing[3],
    },
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
  label: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  status: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  spacer: {
    flex: 1,
  },
}));
