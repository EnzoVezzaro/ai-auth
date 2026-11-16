import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const base = process.env.LANDING_URL ?? "http://127.0.0.1:4173/";
const output = resolve(import.meta.dirname, "../screenshots/landing");
await mkdir(output, { recursive: true });

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
];

const sections = [
  ["hero", ".hero"],
  ["environments", "#environments"],
  ["flow", "#flow"],
  ["presence", "#presence"],
  ["network", "#network"],
  ["developers", "#developers"],
  ["open", "#open"],
];

const report = { base, viewports: [], errors: [] };
const browser = await chromium.launch();

for (const viewport of viewports) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  await page.screenshot({
    path: resolve(output, `${viewport.name}-hero.png`),
  });

  for (const [name, selector] of sections.slice(1)) {
    const element = page.locator(selector);
    await element.scrollIntoViewIfNeeded();
    await page.waitForTimeout(950);
    await page.screenshot({
      path: resolve(output, `${viewport.name}-${name}.png`),
    });
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(700);
  await page.screenshot({
    path: resolve(output, `${viewport.name}-full.png`),
    fullPage: true,
  });

  const result = {
    name: viewport.name,
    size: `${viewport.width}x${viewport.height}`,
    errors,
    scrollWidth: await page.evaluate(
      () => document.documentElement.scrollWidth,
    ),
    clientWidth: await page.evaluate(
      () => document.documentElement.clientWidth,
    ),
    canvasCount: await page.locator("canvas").count(),
  };

  if (viewport.name === "desktop") {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("[data-connection-next]").click();
    result.connectionState = await page
      .locator("[data-connection-state]")
      .textContent();
    await page.locator('[data-env="webmcp"]').click();
    result.envTitle = await page.locator("[data-env-title]").textContent();
    await page.locator('[data-stage="2"]').click();
    result.flowLabel = await page.locator("[data-flow-label]").textContent();
    await page.locator('[data-code-tab="agent"]').click();
    result.codePanel = await page
      .locator('[data-code-panel="agent"]')
      .isVisible();
    await page.locator("#developers").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(output, "desktop-interactions.png"),
    });
  }

  if (viewport.name === "mobile") {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(".mobile-nav summary").click();
    result.mobileMenu = await page.locator(".mobile-nav nav").isVisible();
    await page.screenshot({ path: resolve(output, "mobile-navigation.png") });
  }

  report.viewports.push(result);
  if (errors.length) report.errors.push({ viewport: viewport.name, errors });
  await context.close();
}

const reduced = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const reducedPage = await reduced.newPage();
const reducedErrors = [];
reducedPage.on("pageerror", (error) => reducedErrors.push(error.message));
await reducedPage.goto(base, { waitUntil: "networkidle" });
await reducedPage.waitForTimeout(600);
await reducedPage.screenshot({ path: resolve(output, "reduced-motion.png") });
report.reducedMotion = {
  canvasCount: await reducedPage.locator("canvas").count(),
  fallbackVisible: await reducedPage.locator(".hero-fallback").isVisible(),
  errors: reducedErrors,
};
await reduced.close();

const fallback = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await fallback.addInitScript(() => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (String(type).includes("webgl") || String(type).includes("experimental"))
      return null;
    return original.call(this, type, ...rest);
  };
});
const fallbackPage = await fallback.newPage();
const fallbackErrors = [];
fallbackPage.on("pageerror", (error) => fallbackErrors.push(error.message));
await fallbackPage.goto(base, { waitUntil: "networkidle" });
await fallbackPage.waitForTimeout(700);
await fallbackPage.screenshot({ path: resolve(output, "webgl-fallback.png") });
report.webglFallback = {
  canvasCount: await fallbackPage.locator("canvas").count(),
  fallbackVisible: await fallbackPage.locator(".hero-fallback").isVisible(),
  errors: fallbackErrors,
};
await fallback.close();

await browser.close();
await writeFile(
  resolve(output, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
