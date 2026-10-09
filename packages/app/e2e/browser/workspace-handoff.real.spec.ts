import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test, type Page } from "../support/fixtures";
import { closeModelControl, openModelPicker } from "../support/helpers/model-control";
import { submitMessage } from "../support/helpers/composer";
import { allowPermission, waitForPermissionPrompt } from "../support/helpers/permissions";
import { handoffHosts, openHandoff, savedTransfer } from "../support/helpers/workspace-handoff";

interface HistoryEvidence {
  page: Page;
  token: string;
  destination: { destinationCwd: string; reservationId: string };
  importedId: string;
}

async function inspectPreviousConversation(
  page: Page,
  token: string,
  archiveManifest: string,
  screenshotPath: string,
) {
  const bytes = await readFile(archiveManifest);
  await writeFile(archiveManifest, Buffer.alloc(bytes.length));
  await page.getByTestId("handoff-history-open").click();
  const sheet = page.getByTestId("handoff-history-sheet");
  const content = page.getByTestId("handoff-history-content");
  await expect(content).toContainText("Blob checksum differs from the manifest");
  await expect(content.getByTestId("handoff-history-retry")).toBeVisible();
  await writeFile(archiveManifest, bytes);
  await content.getByTestId("handoff-history-retry").click();
  await expect(content).toContainText("Read-only history from Source laptop");
  await expect(content.getByTestId("user-message").filter({ hasText: token })).toBeVisible();
  await expect(content.getByRole("textbox", { name: "Message agent..." })).toHaveCount(0);
  await page.screenshot({ path: screenshotPath });
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).not.toBeVisible();
}

async function continueConversation(
  page: Page,
  client: DaemonClient,
  agentId: string,
  prompt: string,
  token: string,
) {
  await openModelPicker(page);
  const model = page
    .getByTestId("combobox-desktop-container")
    .locator('[data-testid^="model-row-claude-"][data-testid*="haiku"]')
    .first();
  await expect(model).toBeVisible();
  await model.click();
  await closeModelControl(page);
  await expect.poll(async () => (await client.fetchAgent(agentId))?.agent.model).toMatch(/haiku/i);
  await submitMessage(page, prompt);
  await waitForPermissionPrompt(page, 90_000);
  const stop = page.getByRole("button", { name: "Stop agent", exact: true });
  await expect(stop).toBeVisible();
  const accept = page.getByTestId("permission-request-accept").filter({ visible: true }).first();
  const approvedTools: string[] = [];
  // Discovery can require its own permission before Write. Keep the destination's
  // policy and approve through the same controls as the user, with a bounded count.
  await page.addLocatorHandler(
    accept,
    async () => {
      const pending = await client.fetchAgent(agentId);
      const permission = pending?.agent.pendingPermissions[0];
      if (!permission) throw new Error("Permission prompt has no pending request");
      approvedTools.push(permission.name);
      await allowPermission(page);
    },
    { times: 5 },
  );
  await expect(stop).toBeHidden({ timeout: 90_000 });
  await page.removeLocatorHandler(accept);
  expect(approvedTools).toContain("Write");
  await expect(
    page.getByTestId("assistant-message").filter({ hasText: token, visible: true }).last(),
  ).toBeVisible();
}

test.describe("real conversation handoff through the app", () => {
  test.skip(process.platform === "win32", "Ownership release requires POSIX directory durability");
  test.setTimeout(240_000);

  for (const scenario of [
    {
      mode: "native",
      historyViewport: { width: 1280, height: 720 },
      label: "Keep native sessions",
      prompt:
        "Use the Write tool to create continued.txt in the current workspace containing only the transfer token from our earlier conversation, then reply with the token. Do not write to the old workspace.",
      verifyHistory: async ({ page, token }: HistoryEvidence) => {
        await expect(
          page.getByTestId("user-message").filter({ hasText: token, visible: true }),
        ).toBeVisible();
      },
    },
    {
      mode: "context",
      historyViewport: { width: 390, height: 844 },
      label: "Continue with exported history",
      prompt:
        "Read the original transcript file in the exported context to find the transfer token. Use the Write tool to create continued.txt in the current workspace containing only that token, then reply with it. Do not write to the old workspace.",
      verifyHistory: async ({ token, destination, importedId }: HistoryEvidence) => {
        const history = await readFile(
          path.join(
            destination.destinationCwd,
            `handoff-context-${destination.reservationId}`,
            importedId,
            "timeline.json",
          ),
          "utf8",
        );
        expect(history).toContain(token);
      },
    },
  ] as const) {
    test(`moves a ${scenario.mode} Claude conversation and continues it using prior-only context`, async ({
      page,
    }, testInfo) => {
      const providerRoot = await mkdtemp(path.join(tmpdir(), "handoff-browser-claude-"));
      const claudeConfigDirs = {
        source: path.join(providerRoot, "source"),
        destination: path.join(providerRoot, "destination"),
      };
      let hosts: Awaited<ReturnType<typeof handoffHosts>> | undefined;
      try {
        for (const configDir of Object.values(claudeConfigDirs)) {
          await mkdir(configDir);
          await symlink(
            path.join(
              process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
              ".credentials.json",
            ),
            path.join(configDir, ".credentials.json"),
          );
        }
        hosts = await handoffHosts(page, { git: true, claudeConfigDirs });
        const host = hosts;
        const agent = await host.sourceClient.createAgent({
          provider: "claude",
          model: "haiku",
          modeId: "bypassPermissions",
          cwd: host.workspace.repoPath,
          workspaceId: host.workspace.workspaceId,
          title: "Handoff conversation",
        });
        await page.goto(`${host.route}?open=${encodeURIComponent(`agent:${agent.id}`)}`);
        const token = randomUUID();
        await test.step("retain information only in the original conversation", async () => {
          await submitMessage(
            page,
            `Remember the transfer token at the end of this historical note. ${"Context detail. ".repeat(160)} Transfer token: ${token}. Reply with exactly ACK. Do not repeat the token, write files or run tools.`,
          );
          await expect(
            page.getByTestId("assistant-message").filter({ hasText: "ACK", visible: true }),
          ).toBeVisible({ timeout: 90_000 });
          expect((await host.sourceClient.waitForFinish(agent.id, 90_000)).status).toBe("idle");
        });
        const original = await host.sourceClient.fetchAgent(agent.id);
        if (!original?.agent.persistence) throw new Error("Source session did not persist");
        const nativeSessionId = original.agent.persistence.sessionId;
        await test.step("review and transfer through the workspace action", async () => {
          await openHandoff(page);
          await page.getByTestId("handoff-host-trigger").click();
          await page.getByTestId(`handoff-host-${host.destination.serverId}`).click();
          await page.getByTestId("handoff-parent").fill(host.destinationParent);
          await page.getByTestId("handoff-mode-trigger").click();
          await page.getByText(scenario.label, { exact: true }).last().click();
          await page.getByTestId("handoff-submit").click();
          await expect(page.getByTestId("handoff-review")).toContainText("Handoff conversation");
          await expect(page.getByTestId("handoff-review")).toContainText(scenario.label);
          expect((await host.destinationClient.fetchWorkspaces()).entries).toEqual([]);
          await page.screenshot({
            path: testInfo.outputPath(`handoff-real-${scenario.mode}-review.png`),
          });
          await page.getByTestId("handoff-submit").click();
          await expect(page.getByTestId("handoff-submit")).toHaveText("Move workspace", {
            timeout: 30_000,
          });
          await expect(
            host.sourceClient.sendMessage(agent.id, "Must stay stopped"),
          ).rejects.toThrow("held by handoff");
          await page.getByTestId("handoff-submit").click();
          await expect(page.getByTestId("handoff-submit")).toHaveText("Open destination", {
            timeout: 30_000,
          });
        });
        const transferId = await savedTransfer(
          page,
          host.source.serverId,
          host.workspace.workspaceId,
        );
        const moved = await host.destinationClient.handoffGetDestinationStatus({ transferId });
        expect(moved.error).toBeNull();
        if (!moved.result) throw new Error("Destination status is missing");
        const destination = moved.result;
        expect(destination.state).toBe("active");
        expect(destination.agentMappings).toHaveLength(1);
        const importedId = destination.agentMappings[0].destinationAgentId;
        await page.getByTestId("handoff-submit").click();
        await expect(page).toHaveURL(
          new RegExp(`/h/${host.destination.serverId}/workspace/${destination.workspaceId}`),
        );
        await test.step("read the transferred conversation and continue on the destination", async () => {
          const tab = page
            .getByTestId(`workspace-tab-agent_${importedId}`)
            .filter({ visible: true });
          await expect(tab).toBeVisible({ timeout: 30_000 });
          await tab.click();
          await scenario.verifyHistory({ page, token, destination, importedId });
          await page.setViewportSize(scenario.historyViewport);
          await expect(page.getByTestId("handoff-provenance")).toContainText(
            scenario.mode === "native"
              ? "Native session continued"
              : "New session with exported history",
          );
          if (!destination.manifestDigest) throw new Error("Missing transferred manifest digest");
          await inspectPreviousConversation(
            page,
            token,
            path.join(
              host.destination.paseoHome,
              "handoff",
              "archives",
              transferId,
              "blobs",
              destination.manifestDigest,
            ),
            testInfo.outputPath(`handoff-real-${scenario.mode}-history.png`),
          );
          await page.setViewportSize({ width: 1280, height: 720 });
          const imported = await host.destinationClient.fetchAgent(importedId);
          expect(imported?.agent.labels["paseo.handoff-mode"]).toBe(scenario.mode);
          expect(imported?.agent.persistence?.sessionId ?? null).toBe(
            scenario.mode === "native" ? nativeSessionId : null,
          );
          await continueConversation(
            page,
            host.destinationClient,
            importedId,
            scenario.prompt,
            token,
          );
          expect((await host.destinationClient.waitForFinish(importedId, 90_000)).status).toBe(
            "idle",
          );
          expect(
            (await readFile(path.join(destination.destinationCwd, "continued.txt"), "utf8")).trim(),
          ).toBe(token);
          await expect(
            readFile(path.join(host.workspace.repoPath, "continued.txt")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const continued = await host.destinationClient.fetchAgent(importedId);
          if (!continued?.agent.persistence) throw new Error("Destination session did not persist");
          expect(continued.agent.persistence.sessionId === nativeSessionId).toBe(
            scenario.mode === "native",
          );
          await page.screenshot({
            path: testInfo.outputPath(`handoff-real-${scenario.mode}-continued.png`),
          });
        });
        await expect(
          host.sourceClient.sendMessage(agent.id, "Must remain stopped after continuation"),
        ).rejects.toThrow("held by handoff");
      } finally {
        try {
          await hosts?.close();
        } finally {
          await rm(providerRoot, { recursive: true, force: true });
        }
      }
    });
  }
});
