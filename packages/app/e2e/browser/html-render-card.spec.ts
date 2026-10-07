import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { selectWorkspaceInSidebar } from "../support/helpers/sidebar";

test("desktop render control appears over a hovered frame and opens its viewer", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const render = { renderId: randomUUID(), title: "Hover fixture", height: 800 };
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "html-render-hover-",
    title: "HTML render hover fixture",
    model: "ten-second-stream",
    featureValues: {
      mockCompletedToolCall: {
        name: "html_render",
        output: JSON.stringify({ htmlRender: render }),
      },
    },
  });
  try {
    const directory = path.join(process.env.E2E_PASEO_HOME!, "html-renders", agent.agentId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${render.renderId}.html`),
      '<main style="height:800px;background:#fff">Hover fixture</main>',
    );
    await writeFile(
      path.join(directory, `${render.renderId}.json`),
      JSON.stringify({ title: render.title }),
    );
    await page.goto("/");
    await expect(page.getByText(agent.cwd.split("/").at(-1)!, { exact: true }).first()).toBeVisible(
      { timeout: 20_000 },
    );
    await selectWorkspaceInSidebar(page, agent.workspaceId);
    await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible();
    await agent.client.sendAgentMessage(agent.agentId, "Show the HTML render fixture.");

    const frame = page.locator('iframe[title="Hover fixture"]');
    const expand = page.getByRole("button", { name: "Expand HTML page" });
    await expect(frame).toBeVisible({ timeout: 30_000 });
    await frame.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.mouse.move(10, 10);
    await expect
      .poll(() => expand.locator("..").evaluate((node) => getComputedStyle(node).opacity))
      .toBe("0");

    const frameBox = await frame.boundingBox();
    if (!frameBox) throw new Error("Inline render frame has no bounds");
    await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
    await expect
      .poll(() => expand.locator("..").evaluate((node) => getComputedStyle(node).opacity))
      .toBe("1");
    await page.mouse.move(10, 10);
    await expect
      .poll(() => expand.locator("..").evaluate((node) => getComputedStyle(node).opacity))
      .toBe("0");
    await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
    await expect
      .poll(() => expand.locator("..").evaluate((node) => getComputedStyle(node).opacity))
      .toBe("1");
    expect(
      await expand.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return hit === button || button.contains(hit);
      }),
    ).toBe(true);
    await expand.click();
    await expect(page.getByRole("button", { name: "Close HTML page" })).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});
