import { expect, type Page } from "@playwright/test";

export async function selectComposerModel(page: Page, modelId: string): Promise<void> {
  const trigger = page.getByTestId("combined-model-selector").filter({ visible: true }).first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  const popover = page.getByTestId("combobox-desktop-container");
  await expect(popover).toBeVisible({ timeout: 30_000 });
  const change = popover.getByTestId("agent-quick-change-model");
  if (await change.isVisible()) {
    await change.click();
  }
  const search = popover.getByTestId("model-search-all-input");
  await expect(search).toBeVisible({ timeout: 30_000 });
  await search.fill(modelId);
  const row = popover.locator(`[data-testid^="model-row-"][data-testid$="-${modelId}"]`).first();
  await expect(row).toBeVisible();
  const label = (await row.locator("div[dir=auto]").first().innerText()).trim();
  await row.click();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName(new RegExp(`\\(${escapeRegex(label)}`));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
