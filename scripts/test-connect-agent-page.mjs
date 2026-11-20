// End-to-end for the full SDK-only agent onboarding:
// 1 open the connect page → 2 create an identity with a backup download →
// 3 install it into an agent instance → 4 the agent joins and the site shows
// live presence and a signed message. No hosted service or manual wallet step.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { startStaticServer, waitFor } from "./e2e/helpers.mjs";
import { installAgentIdentity } from "../packages/agent/install.js";

const root = resolve(import.meta.dirname, "..");
const PASSPHRASE = "connect agent e2e passphrase 2026";
const server = await startStaticServer();
const dir = await mkdtemp(join(tmpdir(), "ai-auth-connect-agent-"));
let browser;
let agent;

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.siteUrl}connect-agent/`);
  await waitFor(() => page.locator("#setup").isVisible(), {
    message: "identity form is visible",
  });
  assert.equal(await page.locator("text=Create wallet").count(), 0);

  const link = await page.locator("#site-link").inputValue();
  const instruction = await page.locator("#instruction").inputValue();
  assert.match(link, /connect-agent\/\?room=default/u);
  assert.match(instruction, /^Origin: http:\/\//mu);
  assert.match(instruction, /Room: default/u);
  assert.match(instruction, /Capabilities:.*presence\.read/u);
  assert.doesNotMatch(instruction, /connectAIAuthModal/u);
  assert.match(
    await page.locator("#mcp-command").innerText(),
    /--open-wallet/u,
  );

  // 2 · Create identity and capture both downloads.
  await page.locator("#agent-name-input").fill("e2e-agent");
  await page.locator("#passphrase").fill(PASSPHRASE);
  await page.locator("#confirm").fill(PASSPHRASE);
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await page.locator("#create").click();
  await waitFor(() => page.locator("#share-block").isVisible(), {
    message: "install instructions are visible",
  });
  await waitFor(() => downloads.length === 2, {
    message: "backup and install package downloaded",
  });
  const installDownload = downloads.find((download) =>
    download.suggestedFilename().includes("install"),
  );
  assert.ok(installDownload, "install package was downloaded");
  const packagePath = join(dir, "ai-auth-agent-install.json");
  await installDownload.saveAs(packagePath);
  const installPackage = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(installPackage.format, "ai-auth-agent-install");
  assert.match(installPackage.binding.type, /instance-binding/u);

  // 3 · Install into an agent instance using the agent SDK.
  const installed = await installAgentIdentity({
    dir: join(dir, "keystore"),
    installPackage,
    passphrase: PASSPHRASE,
  });
  assert.equal(installed.id, installPackage.walletId);
  assert.equal(installed.instanceId, installPackage.instanceId);

  // 4 · Start the agent with the installed identity.
  agent = spawn(
    process.execPath,
    [
      resolve(root, "packages/agent/examples/installed-peer.mjs"),
      join(dir, "keystore"),
      server.origin,
      "default",
      "e2e-agent",
      "40",
    ],
    {
      cwd: root,
      env: { ...process.env, AI_AUTH_PASSPHRASE: PASSPHRASE },
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
        return state && state.phase === "connected" && state.items.length >= 1;
      }),
    {
      timeout: 60_000,
      message: "the installed agent connects and sends a message",
    },
  );

  assert.equal(await page.locator("#status-pill").innerText(), "CONNECTED");
  assert.match(
    await page.locator("#agent-id").innerText(),
    new RegExp(installed.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
  );
  assert.equal(await page.locator("#capabilities .cap-chip").count(), 3);
  assert.match(
    await page.locator("#activity-list").innerText(),
    /hello from e2e-agent/u,
  );
  assert.equal(await page.locator("#share-block").isVisible(), false);
  assert.equal(await page.locator("#session").isVisible(), true);
  assert.deepEqual(errors, []);

  // A wallet must still never be created in a vacuum in the owner console.
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
  } finally {
    await ownerContext.close();
  }

  console.log(
    "Connect Agent E2E passed: identity created with backup, installed into an agent instance, agent connected with that exact identity, and live activity appeared.",
  );
} catch (error) {
  console.error("E2E_FAIL", error);
  process.exitCode = 1;
} finally {
  if (agent) agent.kill("SIGTERM");
  if (browser) await browser.close().catch(() => {});
  await server.stop?.();
  server.child?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
