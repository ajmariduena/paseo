import { expect, test } from "@playwright/test";
import {
  prepareRenderDocument,
  renderFrameHeight,
  type RenderTheme,
} from "../../src/html-render/document";
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

test("dark visualization blends with the thread and measures a wrapped final paragraph", async ({
  page,
}) => {
  const darkTheme: RenderTheme = {
    appearance: "dark",
    variables: {
      ...theme.variables,
      "--background": "#181B1A",
      "--card": "#1E2120",
      "--foreground": "#F5F5F4",
    },
  };
  await page.setContent(
    '<div style="background:#181B1A"><iframe id="visual" sandbox="allow-scripts" style="display:block;width:360px;height:240px;border:0;background:transparent"></iframe></div>',
  );
  await page.evaluate(() => {
    const host = window as unknown as { heights: number[] };
    host.heights = [];
    window.addEventListener("message", (event) => {
      if (event.data?.method !== "visualization/size") return;
      const height = event.data.params.height;
      host.heights.push(height);
      const frame = document.getElementById("visual") as HTMLIFrameElement;
      frame.style.height = `${height}px`;
    });
  });
  const markup = prepareVisualizationDocument({
    fragment:
      '<div><div style="height:260px">Chart</div><p id="footnote" style="font-size:15px;line-height:1.5;margin:16px 0 24px">Illustrative ratings, 1–5; higher is better. Compile speed means time to runnable feedback, including interpreted workflows. Actual performance depends on workload, runtime settings, and tooling; compare the complete footnote before drawing a conclusion.</p></div>',
    theme: darkTheme,
    nonce: "footnote-test",
    identity: "/tmp/footnote-test.html",
    state: null,
    mode: "inline",
    linkMode: "web",
  });
  const frame = page.locator("#visual");
  await frame.evaluate((element: HTMLIFrameElement, html) => {
    element.srcdoc = html;
  }, markup);
  const visual = page.frameLocator("#visual");
  const footnote = visual.locator("#footnote");
  await expect(footnote).toBeVisible();
  expect(await frame.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  expect(
    await visual.locator("html").evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe("rgb(24, 27, 26)");
  expect(
    await visual.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe("rgb(24, 27, 26)");
  expect(
    await visual
      .locator("html")
      .evaluate((element) => getComputedStyle(element).getPropertyValue("--card").trim()),
  ).toBe("#1E2120");
  const lineCount = await footnote.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight);
  });
  expect(lineCount).toBeGreaterThan(2);
  const extents = await footnote.evaluate((element) => ({
    previous: Math.ceil(
      Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height),
    ),
    needed: Math.ceil(
      element.getBoundingClientRect().bottom +
        Number.parseFloat(getComputedStyle(element).marginBottom),
    ),
  }));
  expect(extents.needed).toBeGreaterThan(extents.previous);
  const fits = () =>
    footnote.evaluate((element) => {
      const margin = Number.parseFloat(getComputedStyle(element).marginBottom);
      return element.getBoundingClientRect().bottom + margin <= innerHeight + 1;
    });
  await expect.poll(fits).toBe(true);
  const firstHeight = await frame.evaluate((element) => element.getBoundingClientRect().height);
  await footnote.evaluate((element: HTMLElement) => {
    element.style.fontSize = "24px";
  });
  await expect
    .poll(() => frame.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(firstHeight);
  await expect.poll(fits).toBe(true);
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
  const renderMarkup = prepareRenderDocument({
    html: '<div style="height:320px">Page</div>',
    theme,
    nonce: "render-test",
    renderId: "render-test",
    linkMode: "web",
  });
  await page.locator("#render").evaluate((frame: HTMLIFrameElement, html) => {
    frame.srcdoc = html;
  }, renderMarkup);
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

test("a measured phone-width page grows to content height without inner scrolling", async ({
  page,
}) => {
  await page.setContent(
    '<iframe id="render" sandbox="allow-scripts" style="width:360px;border:0"></iframe>',
  );
  await page.evaluate(() => {
    const host = window as unknown as { heights: number[] };
    host.heights = [];
    window.addEventListener("message", (event) => {
      if (event.data?.method === "ui/notifications/size-changed")
        host.heights.push(event.data.params.height);
    });
  });
  const renderMarkup = prepareRenderDocument({
    html: '<style>.panel{height:900px}@media(max-width:500px){.panel{height:1500px}}</style><div class="panel">Phone layout</div>',
    theme,
    nonce: "phone-test",
    renderId: "phone-test",
    linkMode: "web",
  });
  await page.locator("#render").evaluate((frame: HTMLIFrameElement, html) => {
    frame.srcdoc = html;
  }, renderMarkup);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { heights: number[] }).heights.at(-1) ?? 0),
    )
    .toBeGreaterThanOrEqual(1500);
  const measured = [320, 375, 430, 520, 640, 728, 860, 1000, 1144].map(
    (width) => [width, width < 728 ? 1500 : 900] as const,
  );
  const width = await page
    .locator("#render")
    .evaluate((frame: HTMLIFrameElement) => frame.getBoundingClientRect().width);
  const live = await page.evaluate(
    () => (window as unknown as { heights: number[] }).heights.at(-1)!,
  );
  const height = renderFrameHeight(900, live, width, measured);
  expect(height).toBe(1500);
  await page.locator("#render").evaluate((frame: HTMLIFrameElement, value) => {
    frame.style.height = `${value}px`;
  }, height);
  expect(
    await page
      .frameLocator("#render")
      .locator("body")
      .evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
  ).toBe(true);
});
