import { expect, type Locator, type Page } from "@playwright/test";
import { escapeRegex } from "./regex";

/** The composer's one model-and-effort pill. */
export function composerModelControl(page: Page): Locator {
  return page.getByTestId("combined-model-selector").filter({ visible: true }).first();
}

function pickerViewport(page: Page): Locator {
  return page.getByTestId("combobox-desktop-container");
}

/**
 * The pill speaks "model · effort · fast", leaving out parts that do not apply. Omitted inputs
 * match any value in their place.
 */
export function composerModelControlName(input: { model?: string; effort?: string }): RegExp {
  const model = input.model === undefined ? "[^·]+?" : escapeRegex(input.model);
  const effort = input.effort === undefined ? "(?: · [^·]+?)?" : ` · ${escapeRegex(input.effort)}`;
  return new RegExp(`^Change model and effort \\(${model}${effort}(?: · [^·]+?)?\\)$`);
}

export async function expectComposerModelControl(
  page: Page,
  input: { model?: string; effort?: string },
  options?: { timeout?: number },
): Promise<void> {
  await expect(composerModelControl(page)).toHaveAccessibleName(composerModelControlName(input), {
    timeout: options?.timeout ?? 30_000,
  });
}

export async function expectComposerModel(page: Page, model: string): Promise<void> {
  await expectComposerModelControl(page, { model });
}

export async function expectComposerEffort(page: Page, effort: string): Promise<void> {
  await expectComposerModelControl(page, { effort });
}

/** Opens the quick card: the popover on wide layouts, the overlay on lean ones. */
export async function openModelControl(page: Page): Promise<void> {
  await composerModelControl(page).click();
  await expect(
    page
      .getByTestId("agent-effort-card")
      .or(page.getByTestId("agent-intelligence-overlay"))
      .filter({ visible: true })
      .first(),
  ).toBeVisible({ timeout: 30_000 });
}

export async function openAdvancedModelSettings(page: Page): Promise<void> {
  await openModelControl(page);
  await page.getByTestId("agent-effort-advanced").filter({ visible: true }).first().click();
  await expect(page.getByTestId("agent-advanced-page").filter({ visible: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** The quick card's model row leads to the model browser. */
export async function openModelPicker(page: Page): Promise<void> {
  await composerModelControl(page).click();
  await expect(pickerViewport(page)).toBeVisible({ timeout: 30_000 });
  const change = pickerViewport(page).getByTestId("agent-quick-change-model");
  if (await change.isVisible()) {
    await change.click();
  }
  await expect(pickerViewport(page).getByTestId("model-search-all-input")).toBeVisible({
    timeout: 30_000,
  });
}

export async function closeModelControl(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(pickerViewport(page)).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Searches every provider and picks the row whose label or model id is `model`, else the top
 * result: labels carry version suffixes (for example "Haiku 4.5").
 */
export async function pickModelFromBrowser(page: Page, model: string): Promise<void> {
  const viewport = pickerViewport(page);
  await viewport.getByTestId("model-search-all-input").fill(model);
  const rows = viewport.locator('[data-testid^="model-row-"]');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const byLabel = rows.filter({
    has: page.getByText(new RegExp(`^${escapeRegex(model)}$`, "i")),
  });
  const byId = viewport.locator(`[data-testid^="model-row-"][data-testid$="-${model}"]`);
  const exact = byLabel.or(byId);
  const row = (await exact.count()) > 0 ? exact.first() : rows.first();
  await row.click();
  await expect(viewport.getByTestId("agent-model-browser")).toHaveCount(0, { timeout: 30_000 });
}
