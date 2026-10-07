import { expect, test } from "@playwright/test";
import { prepareRenderDocument, type RenderTheme } from "../../src/html-render/document";
import { prepareVisualizationDocument } from "../../src/html-render/visualize-bridge";

const theme: RenderTheme = {
  appearance: "light",
  variables: {
    "--background": "#ffffff",
    "--foreground": "#111827",
    "--muted": "#f3f4f6",
    "--muted-foreground": "#6b7280",
    "--card": "#ffffff",
    "--card-foreground": "#111827",
    "--secondary": "#f3f4f6",
    "--secondary-foreground": "#111827",
    "--border": "#d1d5db",
    "--input": "#d1d5db",
    "--ring": "#2563eb",
    "--primary": "#2563eb",
    "--primary-foreground": "#ffffff",
    "--destructive": "#dc2626",
    "--chart-1": "#16a34a",
    "--chart-2": "#2563eb",
    "--chart-3": "#d97706",
    "--chart-4": "#9333ea",
    "--chart-5": "#e11d48",
    "--chart-6": "#0891b2",
    "--radius": "10px",
    "--font-sans": "system-ui",
    "--font-mono": "monospace",
    "--font-size-base": "14px",
  },
};

test("visualization tabs and height updates work while remote fetch stays blocked", async ({
  page,
}) => {
  await page.setContent('<iframe id="visual" sandbox="allow-scripts"></iframe>');
  await page.evaluate(() => {
    const host = window as unknown as { heights: number[] };
    host.heights = [];
    window.addEventListener("message", (event) => {
      if (event.data?.method === "visualization/size") host.heights.push(event.data.params.height);
    });
  });
  const document = prepareVisualizationDocument({
    fragment:
      '<div class="nav" role="tablist"><button role="tab" aria-controls="a" aria-selected="true">A</button><button role="tab" aria-controls="b" aria-selected="false">B</button></div><section id="a" role="tabpanel">Apple</section><section id="b" role="tabpanel" hidden>Banana</section><div class="viz-carousel"><section data-variant="First">First slide</section><section data-variant="Second" hidden>Second slide</section></div><div id="grow" style="height:120px"></div>',
    theme,
    nonce: "visual-test",
    identity: "/tmp/visual-test.html",
    state: null,
    mode: "inline",
    linkMode: "web",
  });
  await page.locator("#visual").evaluate((frame: HTMLIFrameElement, html) => {
    frame.srcdoc = html;
  }, document);
  const visual = page.frameLocator("#visual");
  await visual.getByRole("tab", { name: "B" }).click();
  await expect(visual.locator("#a")).toBeHidden();
  await expect(visual.locator("#b")).toBeVisible();
  await visual.getByRole("button", { name: "Next design" }).click();
  await expect(visual.getByText("Second slide")).toBeVisible();
  await expect(visual.getByText("First slide")).toBeHidden();
  await visual.getByRole("combobox", { name: "Choose design" }).selectOption({ label: "First" });
  await expect(visual.getByText("First slide")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { heights: number[] }).heights.length))
    .toBeGreaterThan(0);
  const before = await page.evaluate(
    () => (window as unknown as { heights: number[] }).heights.at(-1)!,
  );
  await visual.locator("#grow").evaluate((element: HTMLElement) => {
    element.style.height = "420px";
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { heights: number[] }).heights.at(-1)!))
    .toBeGreaterThan(before);
  expect(
    await visual.locator("body").evaluate(async () => {
      try {
        await fetch("https://example.com/blocked");
        return "allowed";
      } catch {
        return "blocked";
      }
    }),
  ).toBe("blocked");
});

test("html render reports height and blocks fetch in the real iframe", async ({ page }) => {
  await page.setContent('<iframe id="render" sandbox="allow-scripts"></iframe>');
  await page.evaluate(() => {
    const host = window as unknown as { heights: number[] };
    host.heights = [];
    window.addEventListener("message", (event) => {
      if (event.data?.method === "ui/notifications/size-changed")
        host.heights.push(event.data.params.height);
    });
  });
  const document = prepareRenderDocument({
    html: '<div style="height:320px">Page</div>',
    theme,
    nonce: "render-test",
    renderId: "render-test",
    linkMode: "web",
  });
  await page.locator("#render").evaluate((frame: HTMLIFrameElement, html) => {
    frame.srcdoc = html;
  }, document);
  const render = page.frameLocator("#render");
  await expect(render.getByText("Page")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { heights: number[] }).heights.at(-1)!))
    .toBeGreaterThanOrEqual(320);
  expect(
    await render.locator("body").evaluate(async () => {
      try {
        await fetch("https://example.com/blocked");
        return "allowed";
      } catch {
        return "blocked";
      }
    }),
  ).toBe("blocked");
});
