import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const serveScript = resolve(root, "scripts/serve.mjs");
const portServer = createServer();
await new Promise((resolve, reject) => {
  portServer.once("error", reject);
  portServer.listen(0, "127.0.0.1", resolve);
});
const { port } = portServer.address();
await new Promise((resolve, reject) =>
  portServer.close((error) => (error ? reject(error) : resolve())),
);

const server = spawn(process.execPath, [serveScript], {
  env: { PATH: process.env.PATH, PORT: String(port) },
  stdio: "inherit",
});
let browser;
let context;
let restoreContext;
let pageA;
let pageB;

async function waitForApp(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(`Static preview exited with code ${server.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("Static preview did not become ready in 30 seconds");
}

async function createWallet(page, name, passphrase) {
  if (!(await page.locator("#wallet-name").count()))
    await page.locator("#view [data-go-wallet]").click();
  await page.locator("#wallet-name").fill(name);
  await page.locator("#wallet-passphrase").fill(passphrase);
  await page.locator("#wallet-passphrase-confirm").fill(passphrase);
  const downloadPromise = page.waitForEvent("download");
  await page.locator('#create-wallet-form button[type="submit"]').click();
  const download = await downloadPromise;
  await page.locator("#download-backup").waitFor();
  return readFile(await download.path(), "utf8");
}

async function removeWallet(page) {
  if (!(await page.locator("#forget-wallet").count())) return;
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#forget-wallet").click();
  await page.locator("#wallet-name").waitFor();
}

async function main() {
  const url = `http://127.0.0.1:${port}/`;
  await waitForApp(url);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AI_AUTH_CHROME_PATH
      ? { executablePath: process.env.AI_AUTH_CHROME_PATH }
      : {}),
  });
  context = await browser.newContext({ acceptDownloads: true });
  pageA = await context.newPage();
  await pageA.goto(url);
  await pageA.locator('button[data-view="overview"]').waitFor();

  const alphaBackup = await createWallet(
    pageA,
    "E2E Alpha",
    "Temporary alpha passphrase",
  );
  pageB = await context.newPage();
  await pageB.goto(url);
  await pageB.locator('button[data-view="overview"]').waitFor();
  await pageB.locator('button[data-view="wallet"]').click();
  await pageB.waitForFunction(
    () => Boolean(document.querySelector("#forget-wallet")),
    undefined,
    { timeout: 10_000 },
  );
  await pageB.locator("#forget-wallet").waitFor();
  await removeWallet(pageB);
  await createWallet(pageB, "E2E Beta", "Temporary beta passphrase");

  const [identityA, identityB] = await Promise.all([
    pageA.locator(".key-id").innerText(),
    pageB.locator(".key-id").innerText(),
  ]);
  assert.notEqual(
    identityA,
    identityB,
    "tabs must use distinct wallet identities",
  );

  await Promise.all([
    pageA.locator('button[data-view="peer"]').click(),
    pageB.locator('button[data-view="peer"]').click(),
  ]);
  await Promise.all([
    pageA.getByText("E2E Beta", { exact: true }).waitFor(),
    pageB.getByText("E2E Alpha", { exact: true }).waitFor(),
  ]);

  await pageA.locator("#create-offer").click();
  await pageA.waitForFunction(() =>
    document.querySelector("#sdp-out")?.value.startsWith('{"type":"offer"'),
  );
  const offer = await pageA.locator("#sdp-out").inputValue();
  await pageB.locator("#sdp-in").fill(offer);
  await delay(8_500);
  assert.equal(
    await pageB.locator("#sdp-in").inputValue(),
    offer,
    "pasted offer must survive a peer heartbeat rerender",
  );

  await pageB.locator("#answer-offer").click();
  await pageB.waitForFunction(() =>
    document.querySelector("#sdp-out")?.value.startsWith('{"type":"answer"'),
  );
  const answer = await pageB.locator("#sdp-out").inputValue();
  await pageA.locator("#sdp-in").fill(answer);
  await delay(8_500);
  assert.equal(
    await pageA.locator("#sdp-in").inputValue(),
    answer,
    "pasted answer must survive a peer heartbeat rerender",
  );
  await pageA.locator("#apply-answer").click();
  await Promise.all(
    [pageA, pageB].map((page) =>
      page.waitForFunction(
        () => document.querySelector("#rtc-state")?.textContent === "connected",
        undefined,
        { timeout: 20_000 },
      ),
    ),
  );
  await delay(1_000);

  const message = "Signed WebRTC browser E2E";
  await pageB.locator("#peer-message").fill(message);
  await pageB.locator('#message-form button[type="submit"]').click();
  for (const page of [pageA, pageB])
    await page.locator(".message-item", { hasText: message }).waitFor();
  await delay(300);
  for (const page of [pageA, pageB])
    assert.equal(
      await page.locator(".message-item", { hasText: message }).count(),
      1,
      "signed message should render once on each wallet",
    );

  await Promise.all([
    pageA.locator('button[data-view="overview"]').click(),
    pageB.locator('button[data-view="overview"]').click(),
  ]);
  await delay(1_500);
  await pageA.evaluate(() => {
    window.__e2ePeerCountNode = document.querySelector("#overview-peer-count");
  });
  const activityBefore = await pageA
    .locator("#view .metric-line strong")
    .nth(1)
    .innerText();
  await delay(8_500);
  const heartbeatResult = await pageA.evaluate(() => ({
    sameNode:
      window.__e2ePeerCountNode ===
      document.querySelector("#overview-peer-count"),
    peerCount: document.querySelector("#overview-peer-count")?.textContent,
  }));
  const activityAfter = await pageA
    .locator("#view .metric-line strong")
    .nth(1)
    .innerText();
  assert.equal(
    heartbeatResult.sameNode,
    true,
    "heartbeat must not replace the Overview",
  );
  assert.equal(heartbeatResult.peerCount, "1");
  assert.equal(
    activityAfter,
    activityBefore,
    "heartbeats are not activity records",
  );

  restoreContext = await browser.newContext();
  const restorePage = await restoreContext.newPage();
  await restorePage.goto(url);
  await restorePage.locator('button[data-view="wallet"]').click();
  await restorePage.locator("#import-wallet-form").waitFor();
  await restorePage.locator("#backup-file").setInputFiles({
    name: "ai-auth-wallet-recovery.json",
    mimeType: "application/json",
    buffer: Buffer.from(alphaBackup),
  });
  await restorePage
    .locator("#restore-passphrase")
    .fill("Temporary alpha passphrase");
  await restorePage
    .locator('#import-wallet-form button[type="submit"]')
    .click();
  await restorePage.locator(".key-id").waitFor();
  assert.equal(
    await restorePage.locator(".key-id").innerText(),
    identityA,
    "encrypted recovery must restore the original wallet identity in fresh browser storage",
  );

  console.log(
    "Browser E2E passed: encrypted wallet recovery, distinct identities, signed presence, direct WebRTC, one signed delivery, and heartbeat-stable Overview.",
  );
}

try {
  await main();
} finally {
  if (context && pageA && pageB) {
    for (const page of [pageB, pageA]) {
      try {
        await page
          .locator('button[data-view="wallet"]')
          .click({ timeout: 1_000 });
        await removeWallet(page);
      } catch {
        // Context close below removes this run's isolated browser storage.
      }
    }
  }
  await restoreContext?.close();
  await context?.close();
  await browser?.close();
  if (server.exitCode === null) {
    const exit = once(server, "exit");
    server.kill("SIGTERM");
    await Promise.race([exit, delay(5_000)]).catch(() => {});
  }
}
