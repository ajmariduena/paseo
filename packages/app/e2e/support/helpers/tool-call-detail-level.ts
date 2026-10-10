import type { Page } from "@playwright/test";

/** Overview is the default; detailed renders every call as its own tool-call badge. */
export async function showDetailedToolCalls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const key = "@paseo:app-settings";
    const raw = localStorage.getItem(key);
    const stored = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    localStorage.setItem(key, JSON.stringify({ ...stored, toolCallDetailLevel: "detailed" }));
  });
}
