import { router } from "expo-router";
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { StatusRing } from "@/components/status-ring";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { flushDraftPersistStorage, useDraftStore } from "@/stores/draft-store";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import {
  type PendingWorkspaceCreation,
  pendingWorkspaceCreationKey,
  usePendingWorkspaceCreationStore,
} from "@/stores/pending-workspace-creation";

export function PendingWorkspaceScreen({ creation }: { creation: PendingWorkspaceCreation }) {
  const { t } = useTranslation();
  const toast = useToast();
  const failed = creation.phase === "failed";
  const status = failed
    ? t(
        creation.outcomeUnknown
          ? "sidebar.workspace.status.creationUnconfirmed"
          : "sidebar.workspace.status.creationFailed",
      )
    : t("sidebar.workspace.status.creating");
  const handleRetry = useCallback(async () => {
    try {
      const draftId = generateDraftId();
      const original = useDraftStore
        .getState()
        .getDraftInput(buildNewWorkspaceDraftKey(creation.draftId));
      useDraftStore.getState().saveDraftInput({
        draftKey: buildNewWorkspaceDraftKey(draftId),
        draft: original ?? { text: creation.prompt, attachments: [] },
      });
      await flushDraftPersistStorage();
      if (!creation.outcomeUnknown) {
        usePendingWorkspaceCreationStore
          .getState()
          .remove(pendingWorkspaceCreationKey(creation.serverId, creation.workspaceId));
      }
      router.push(
        buildNewWorkspaceRoute({
          serverId: creation.serverId,
          sourceDirectory: creation.sourceDirectory,
          projectId: creation.projectId,
          displayName: creation.projectName,
          draftId,
        }),
      );
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }, [
    creation.draftId,
    creation.prompt,
    creation.projectId,
    creation.projectName,
    creation.serverId,
    creation.sourceDirectory,
    creation.workspaceId,
    creation.outcomeUnknown,
    toast,
  ]);

  return (
    <View style={styles.screen} testID="pending-workspace-screen">
      <ScreenHeader
        left={
          <>
            <SidebarMenuToggle />
            <ScreenTitle>{creation.projectName}</ScreenTitle>
          </>
        }
      />
      <View style={styles.tabBar}>
        <Text style={styles.tabTitle} numberOfLines={1}>
          {creation.prompt.trim() || t("sidebar.workspace.status.creating")}
        </Text>
        {!failed ? <StatusRing /> : null}
      </View>
      <View style={styles.content}>
        <View style={styles.message}>
          <Text style={styles.prompt}>{creation.prompt}</Text>
        </View>
        <Text style={failed ? styles.error : styles.status} testID="pending-workspace-status">
          {status}
        </Text>
        {failed && creation.error && !creation.outcomeUnknown ? (
          <Text style={styles.status}>{creation.error}</Text>
        ) : null}
        {failed ? (
          <Pressable
            accessibilityRole="button"
            onPress={handleRetry}
            style={styles.retry}
            testID="pending-workspace-return-to-draft"
          >
            <Text style={styles.retryText}>{t("sidebar.workspace.status.backToDraft")}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  tabBar: {
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  tabTitle: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  content: { flex: 1, padding: theme.spacing[4], gap: theme.spacing[3] },
  message: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  prompt: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  retry: { alignSelf: "flex-start", padding: theme.spacing[2] },
  retryText: { color: theme.colors.accentForeground, fontSize: theme.fontSize.sm },
}));
