import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  expectNewWorkspaceProjectSelected,
  NO_PROJECT_LABEL,
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  selectWorkspaceIsolation,
  submitNewWorkspaceEmpty,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { LAST_WORKSPACE_SELECTION_STORAGE_KEY } from "@/stores/last-workspace-selection";
import { buildHostWorkspaceRoute, buildNewWorkspaceRoute } from "@/utils/host-routes";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

const OFFLINE_SERVER_IDS = [
  "srv_e2e_preselect_offline_1",
  "srv_e2e_preselect_offline_2",
  "srv_e2e_preselect_offline_3",
];

// Without a route project, New workspace starts on the project last used to
// create a workspace, then on No project; the open workspace's project does not
// win. A plain /new must not let a stale remembered offline host steal the
// initial host when exactly one saved host is online.

async function pressNewWorkspaceShortcut(page: import("@playwright/test").Page): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+n`);
  await expect(page).toHaveURL(/\/new(?:\?.*)?$/, { timeout: 30_000 });
}

async function expectProjectPreselectedWithin(
  page: import("@playwright/test").Page,
  projectDisplayName: string,
  timeout: number,
): Promise<void> {
  const projectPicker = page.getByRole("button", { name: "Workspace project" });
  await expect(projectPicker).toContainText(projectDisplayName, { timeout });
}

async function expectAnyProjectPreselectedWithin(
  page: import("@playwright/test").Page,
  timeout: number,
): Promise<void> {
  const projectPicker = page.getByRole("button", { name: "Workspace project" });
  await expect(projectPicker).toBeVisible({ timeout });
  await expect
    .poll(
      async () => {
        const label = ((await projectPicker.textContent()) ?? "").trim();
        return label || "Choose project";
      },
      { timeout },
    )
    .not.toBe("Choose project");
}

async function openColdRestoredWorkspaceWithOfflineHostFirst(
  page: import("@playwright/test").Page,
  workspace: SeededWorkspace,
): Promise<void> {
  const connectedServerId = getServerId();
  await seedSavedSettingsHosts(page, [
    ...OFFLINE_SERVER_IDS.map((serverId, index) => ({
      serverId,
      label: `Offline host ${index + 1}`,
      endpoint: `127.0.0.1:${index + 1}`,
    })),
    {
      serverId: connectedServerId,
      label: "Connected host",
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
  ]);
  await page.evaluate(
    ({ storageKey, serverId, workspaceId }) => {
      localStorage.setItem(storageKey, JSON.stringify({ serverId, workspaceId }));
    },
    {
      storageKey: LAST_WORKSPACE_SELECTION_STORAGE_KEY,
      serverId: connectedServerId,
      workspaceId: workspace.workspaceId,
    },
  );

  await page.goto("/");
  await expect(page).toHaveURL(buildHostWorkspaceRoute(connectedServerId, workspace.workspaceId), {
    timeout: 60_000,
  });
  await waitForSidebarHydration(page);
}

async function openNewWorkspaceWithStaleOfflineSelection(
  page: import("@playwright/test").Page,
): Promise<void> {
  const connectedServerId = getServerId();
  await seedSavedSettingsHosts(page, [
    ...OFFLINE_SERVER_IDS.map((serverId, index) => ({
      serverId,
      label: `Offline host ${index + 1}`,
      endpoint: `127.0.0.1:${index + 1}`,
    })),
    {
      serverId: connectedServerId,
      label: "Connected host",
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
  ]);
  await page.evaluate(
    ({ storageKey, serverId }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ serverId, workspaceId: "wks_stale_offline" }),
      );
    },
    {
      storageKey: LAST_WORKSPACE_SELECTION_STORAGE_KEY,
      serverId: OFFLINE_SERVER_IDS[0]!,
    },
  );

  await page.goto(buildNewWorkspaceRoute());
  await expect(page.getByTestId("host-picker-trigger")).toBeVisible({ timeout: 60_000 });
}

async function seedOfflineHostsWithStaleSelection(
  page: import("@playwright/test").Page,
): Promise<void> {
  const connectedServerId = getServerId();
  await seedSavedSettingsHosts(page, [
    ...OFFLINE_SERVER_IDS.map((serverId, index) => ({
      serverId,
      label: `Offline host ${index + 1}`,
      endpoint: `127.0.0.1:${index + 1}`,
    })),
    {
      serverId: connectedServerId,
      label: "Connected host",
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
  ]);
  await page.evaluate(
    ({ storageKey, serverId }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ serverId, workspaceId: "wks_stale_offline" }),
      );
    },
    {
      storageKey: LAST_WORKSPACE_SELECTION_STORAGE_KEY,
      serverId: OFFLINE_SERVER_IDS[0]!,
    },
  );
}

test.describe("New workspace project default", () => {
  test.describe.configure({ timeout: 240_000 });

  let projectA: SeededWorkspace;
  let projectB: SeededWorkspace;

  test.beforeEach(async () => {
    projectA = await seedWorkspace({ repoPrefix: "preselect-a-" });
    projectB = await seedWorkspace({ repoPrefix: "preselect-b-" });
  });

  test.afterEach(async () => {
    await projectA?.cleanup();
    await projectB?.cleanup();
  });

  test("Cmd+N and the New workspace button start on No project, not the project you are looking at", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: projectB.workspaceId,
    });
    await pressNewWorkspaceShortcut(page);
    await expectNewWorkspaceProjectSelected(page, NO_PROJECT_LABEL);

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: projectA.workspaceId,
    });
    await openGlobalNewWorkspaceComposer(page);
    await expectNewWorkspaceProjectSelected(page, NO_PROJECT_LABEL);
  });

  test("the project last used to create a workspace wins over No project and the open workspace", async ({
    page,
  }) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await switchWorkspaceViaSidebar({ page, serverId, workspaceId: projectA.workspaceId });
    await openGlobalNewWorkspaceComposer(page);
    await selectNewWorkspaceProject(page, {
      projectKey: projectB.projectKey,
      projectDisplayName: projectB.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "local");
    await submitNewWorkspaceEmpty(page);
    await expect(page).toHaveURL(/\/workspace\//, { timeout: 60_000 });
    await expect(page).not.toHaveURL(buildHostWorkspaceRoute(serverId, projectB.workspaceId));

    await switchWorkspaceViaSidebar({ page, serverId, workspaceId: projectA.workspaceId });
    await pressNewWorkspaceShortcut(page);
    await expectNewWorkspaceProjectSelected(page, projectB.projectDisplayName);

    await switchWorkspaceViaSidebar({ page, serverId, workspaceId: projectA.workspaceId });
    await openGlobalNewWorkspaceComposer(page);
    await expectNewWorkspaceProjectSelected(page, projectB.projectDisplayName);
  });

  test("Cmd+N starts on the connected host's No project when an offline saved host is first", async ({
    page,
  }) => {
    await openColdRestoredWorkspaceWithOfflineHostFirst(page, projectB);

    await pressNewWorkspaceShortcut(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectProjectPreselectedWithin(page, NO_PROJECT_LABEL, 8_000);
  });

  test("New workspace button starts on the connected host's No project when an offline saved host is first", async ({
    page,
  }) => {
    await openColdRestoredWorkspaceWithOfflineHostFirst(page, projectB);

    await openGlobalNewWorkspaceComposer(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectProjectPreselectedWithin(page, NO_PROJECT_LABEL, 8_000);
  });

  test("plain /new ignores stale remembered offline hosts when only one saved host is connected", async ({
    page,
  }) => {
    await openNewWorkspaceWithStaleOfflineSelection(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectAnyProjectPreselectedWithin(page, 8_000);
  });

  test("stale remembered offline host heals after visiting the connected workspace", async ({
    page,
  }) => {
    const connectedServerId = getServerId();
    await seedOfflineHostsWithStaleSelection(page);

    await page.goto(buildHostWorkspaceRoute(connectedServerId, projectB.workspaceId));
    await expect(page).toHaveURL(buildHostWorkspaceRoute(connectedServerId, projectB.workspaceId), {
      timeout: 60_000,
    });
    await waitForSidebarHydration(page);

    await openGlobalNewWorkspaceComposer(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectProjectPreselectedWithin(page, NO_PROJECT_LABEL, 8_000);
  });
});
