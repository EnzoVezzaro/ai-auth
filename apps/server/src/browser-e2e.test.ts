import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import axe from "axe-core";

test("real Chrome website SDK, WebMCP fallback, dashboard, and axe accessibility", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-auth-browser-"));
  const port = 35000 + Math.floor(Math.random() * 8000);
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    server = spawn(
      process.execPath,
      ["--import", "tsx", "apps/server/src/server.ts"],
      {
        env: {
          ...process.env,
          PORT: String(port),
          AI_AUTH_DB: join(directory, "browser.sqlite"),
        },
        stdio: "ignore",
      },
    );
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`${base}/health`)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* wait for local listener */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, "local service becomes ready");
    const registration = await fetch(`${base}/v1/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Chrome Browser Automation",
        runtime: "Playwright + Chrome",
        category: "browser_automation",
      }),
    });
    assert.equal(registration.status, 201);
    const { token } = (await registration.json()) as { token: string };

    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_BIN ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto(`${base}/demo`);
    await page.locator("#native").waitFor();
    const webmcpStatus = await page.locator("#native").textContent();
    assert.match(webmcpStatus ?? "", /Native WebMCP|local adapter/);
    await page.getByLabel("Local agent token").fill(token);
    await page.getByRole("button", { name: "Connect presence" }).click();
    await page.getByText("Connected as Chrome Browser Automation").waitFor();
    await page.getByRole("button", { name: /Run declared tool/ }).click();
    await page
      .getByText("Current page note: updated by browser tool")
      .waitFor();

    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const result = await (
        window as unknown as {
          axe: {
            run(): Promise<{
              violations: Array<{
                id: string;
                impact: string | null;
                help: string;
              }>;
            }>;
          };
        }
      ).axe.run();
      return result.violations
        .filter(
          (item) => item.impact === "critical" || item.impact === "serious",
        )
        .map(({ id, impact, help }) => ({ id, impact, help }));
    });
    assert.deepEqual(
      violations,
      [],
      "demo has no serious or critical axe violations",
    );

    const dashboard = await browser.newPage();
    await dashboard.goto(`${base}/dashboard`);
    await dashboard.getByLabel("Agent token").fill(token);
    await dashboard.getByRole("button", { name: "Connect" }).click();
    await dashboard
      .getByText("Connected. Refreshing every 3 seconds.")
      .waitFor();
    assert.equal(await dashboard.locator("#sessions").textContent(), "1");
    console.log(
      JSON.stringify({
        browser: "Google Chrome",
        category: "browser_automation",
        nativeWebMCP: webmcpStatus,
        collaboration: "ticket-authenticated websocket session active",
        declaredTool: "verified visible page-state change",
        dashboard: "authenticated live session metric rendered",
        axeSeriousOrCriticalViolations: violations.length,
      }),
    );
  } finally {
    await browser?.close();
    server?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(directory, { recursive: true, force: true });
  }
});
