// End-to-end for the agent-first page: no human wallet form, no owner approval.
// The site opens a room silently; a headless agent creates its own keystore
// identity, connects, and the page shows live presence and signed messages.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { startStaticServer, waitFor } from "./e2e/helpers.mjs";

const root = resolve(import.meta.dirname, "..");
const server = await startStaticServer();
const dir = await mkdtemp(join(tmpdir(), "ai-auth-connect-agent-"));
let browser;
let agent;

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.siteUrl}connect-agent/`);
  await waitFor(() => page.locator("#site-link").inputValue(), {
    message: "connect link is visible",
  });

  const link = await page.locator("#site-link").inputValue();
  const instruction = await page.locator("#instruction").inputValue();
  assert.match(link, /connect-agent\/\?room=default/u);
  assert.match(instruction, /^Origin: http:\/\//mu);
  assert.match(instruction, /Room: default/u);
  assert.match(instruction, /Capabilities:.*presence\.read/u);
  assert.doesNotMatch(instruction, /connectAIAuthModal/u);
  assert.equal(await page.locator("text=Create wallet").count(), 0);

  agent = spawn(
    process.execPath,
    [
      resolve(root, "packages/agent/examples/peer.mjs"),
      dir,
      "default",
      "e2e-agent",
      "30",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        AI_AUTH_ORIGIN: server.origin,
        AI_AUTH_PASSPHRASE: "Connect agent page E2E passphrase",
      },
    },
  );
  const agentLog = [];
  agent.stdout.on("data", (chunk) =>
    agentLog.push(...String(chunk).split("\n").filter(Boolean)),
  );

  await waitFor(
    () =>
      page.evaluate(() => {
        const state = window.__connectAgent;
        return state && state.agents.size >= 1 && state.messages >= 1;
      }),
    { timeout: 60_000, message: "the agent appears with a signed message" },
  );

  assert.equal(await page.locator("#count-agents").innerText(), "1");
  assert.match(await page.locator("#participants").innerText(), /e2e-agent/u);
  assert.match(
    await page.locator("#activity").innerText(),
    /hello from e2e-agent/u,
  );
  assert.match(
    await page.locator("#room-status").innerText(),
    /peer connected/iu,
  );
  assert.deepEqual(errors, []);

  // A wallet must never be created in a vacuum. In a fresh context (no site
  // wallet in IndexedDB) the owner console offers restore, not a create form.
  const ownerContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(`${server.siteUrl}wallet/`);
    await ownerPage.locator('[data-view="wallet"]').click();
    await waitFor(
      async () => (await ownerPage.locator("#view .panel").count()) > 0,
      { message: "owner console renders" },
    );
    assert.equal(await ownerPage.locator("#create-wallet-form").count(), 0);
    assert.equal(await ownerPage.locator("#wallet-name").count(), 0);
    assert.equal(await ownerPage.locator("#import-wallet-form").count(), 1);
    const ownerText = await ownerPage.locator("#view").innerText();
    assert.match(ownerText, /Identities are created for agents/iu);
    assert.match(ownerText, /created when a site asks/iu);
    assert.match(ownerText, /Connect an agent/iu);
  } finally {
    await ownerContext.close();
  }

  console.log(
    "Connect Agent page E2E passed: agent self-created its identity, connected, the site showed live presence and a message, and no wallet can be created without a request.",
  );
} finally {
  if (agent) agent.kill("SIGTERM");
  if (browser) await browser.close().catch(() => {});
  await server.stop?.();
  server.child?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
