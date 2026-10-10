import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SquarePen } from "lucide-react-native";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PendingWorkspaceAgentPane } from "@/composer/draft/workspace-tab";
import { buildDraftPanelDescriptor } from "@/panels/draft-panel-descriptor";
import { getPanelRegistration } from "@/panels/panel-registry";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { PendingWorkspaceFrame } from "@/screens/workspace/workspace-screen";
import type { WorkspaceTabPresentation } from "@/screens/workspace/workspace-tab-presentation";
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

const MAX_PROVISIONAL_TITLE_CHARS = 60;

// Mirrors the daemon's provisional workspace title (server create-agent-title.ts) so the header
// keeps its text when the real descriptor arrives.
function deriveProvisionalTitle(prompt: string): string | null {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
  return firstLine ? firstLine.slice(0, MAX_PROVISIONAL_TITLE_CHARS).trim() : null;
}

function buildPendingTabPresentation(input: {
  creation: PendingWorkspaceCreation;
  failed: boolean;
}): WorkspaceTabPresentation {
  ensurePanelsRegistered();
  const descriptor = buildDraftPanelDescriptor({
    isCreating: true,
    pendingPrompt: input.creation.prompt,
    icon: SquarePen,
  });
  return {
    key: `pending:${input.creation.draftId}`,
    kind: "draft",
    label: descriptor.label,
    subtitle: descriptor.subtitle,
    tooltip: descriptor.tooltip,
    modified: false,
    showCloseButton: getPanelRegistration("draft")?.showCloseButton ?? false,
    titleState: descriptor.titleState,
    icon: descriptor.icon,
    statusBucket: input.failed ? "failed" : descriptor.statusBucket,
  };
}

export function PendingWorkspaceScreen({ creation }: { creation: PendingWorkspaceCreation }) {
  const { t } = useTranslation();
  const toast = useToast();
  const failed = creation.phase === "failed";
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
  const tab = useMemo(() => buildPendingTabPresentation({ creation, failed }), [creation, failed]);
  const title = deriveProvisionalTitle(creation.prompt) ?? creation.projectName;
  const failureTitle = t(
    creation.outcomeUnknown
      ? "sidebar.workspace.status.creationUnconfirmed"
      : "sidebar.workspace.status.creationFailed",
  );
  const failureDescription =
    creation.error && !creation.outcomeUnknown ? creation.error : undefined;
  const backToDraftLabel = t("sidebar.workspace.status.backToDraft");
  const failure = useMemo(
    () =>
      failed ? (
        <Alert
          variant="error"
          size="sm"
          testID="pending-workspace-status"
          title={failureTitle}
          description={failureDescription}
        >
          <Button
            variant="outline"
            size="sm"
            onPress={handleRetry}
            testID="pending-workspace-return-to-draft"
          >
            {backToDraftLabel}
          </Button>
        </Alert>
      ) : null,
    [backToDraftLabel, failed, failureDescription, failureTitle, handleRetry],
  );

  return (
    <PendingWorkspaceFrame
      serverId={creation.serverId}
      workspaceId={creation.workspaceId}
      title={title}
      subtitle={creation.projectName}
      tab={tab}
      testID="pending-workspace-screen"
    >
      <PendingWorkspaceAgentPane
        serverId={creation.serverId}
        workspaceId={creation.workspaceId}
        draftId={creation.draftId}
        clientMessageId={creation.clientMessageId}
        prompt={creation.prompt}
        createdAt={creation.createdAt}
        sourceDirectory={creation.sourceDirectory}
        setup={creation.agentSetup ?? null}
        failure={failure}
      />
    </PendingWorkspaceFrame>
  );
}
