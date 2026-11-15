import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  createPermissionRequest,
  NonceGuard,
  verifyPermissionConsent,
} from "../packages/p2p/index.js";

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
const relyingPartyServer = createHttpServer((_request, response) => {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'",
    "Content-Type": "text/html; charset=utf-8",
    "Cross-Origin-Opener-Policy": "unsafe-none",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><title>AI Auth relying-party E2E</title></head>
      <body>
        <button id="connect">Connect wallet</button>
        <script>
          window.__connectReady = false;
          window.__receivedConsent = null;
          window.addEventListener("message", (event) => {
            if (event.data?.type === "ai-auth/connect-ready") {
              window.__connectReady = true;
              return;
            }
            if (event.data?.type === "ai-auth/connect-consent") {
              window.__receivedConsent = {
                origin: event.origin,
                ...event.data,
                sourceMatchesPopup: event.source === window.__walletPopup,
              };
            }
          });
          document.querySelector("#connect").addEventListener("click", () => {
            window.__walletPopup = window.open(window.__walletUrl, "ai-auth-wallet");
          });
        </script>
      </body>
    </html>`);
});
await new Promise((resolve, reject) => {
  relyingPartyServer.once("error", reject);
  relyingPartyServer.listen(0, "127.0.0.1", resolve);
});
const relyingPartyPort = relyingPartyServer.address().port;
let browser;
let context;
let restoreContext;
let pageA;
let pageB;
let relyingPartyPage;
let popupPage;
let onboardingContext;
let onboardingRelyingPartyPage;
let onboardingPopupPage;
let onboardingObserverPage;

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

async function createWallet(
  page,
  name,
  passphrase,
  { waitForBackupButton = true } = {},
) {
  if (!(await page.locator("#wallet-name").count()))
    await page.locator("#view [data-go-wallet]").click();
  await page.locator("#wallet-name").fill(name);
  await page.locator("#wallet-passphrase").fill(passphrase);
  await page.locator("#wallet-passphrase-confirm").fill(passphrase);
  const downloadPromise = page.waitForEvent("download");
  await page.locator('#create-wallet-form button[type="submit"]').click();
  const download = await downloadPromise;
  if (waitForBackupButton) await page.locator("#download-backup").waitFor();
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

  const walletAId = await pageA.evaluate(async () =>
    (await import("/packages/p2p/index.js"))
      .loadWallet()
      .then((wallet) => wallet.id),
  );
  const relyingPartyUrl = `http://127.0.0.1:${relyingPartyPort}/`;
  const relyingPartyOrigin = new URL(relyingPartyUrl).origin;
  const walletUrl = `${url}?connect=1`;
  const request = await createPermissionRequest(relyingPartyOrigin, [
    "presence.read",
    "messages.send",
  ]);
  relyingPartyPage = await context.newPage();
  await relyingPartyPage.goto(relyingPartyUrl);
  await relyingPartyPage.evaluate(
    ({ request: permissionRequest, walletUrl: walletPopupUrl }) => {
      window.__permissionRequest = permissionRequest;
      window.__walletUrl = walletPopupUrl;
    },
    { request, walletUrl },
  );
  const popupPromise = relyingPartyPage.waitForEvent("popup");
  await relyingPartyPage.locator("#connect").click();
  popupPage = await popupPromise;
  await popupPage.waitForLoadState();
  await relyingPartyPage.waitForFunction(() => window.__connectReady);
  await relyingPartyPage.evaluate((permissionRequest) => {
    window.__walletPopup.postMessage(
      { type: "ai-auth/connect-request", request: permissionRequest },
      new URL(window.__walletUrl).origin,
    );
  }, request);

  const consentForm = popupPage.locator("#external-permission-form");
  await consentForm.waitFor();
  const presenceCapability = popupPage.locator(
    'input[name="external-capability"][value="presence.read"]',
  );
  await presenceCapability.check();
  assert.equal(
    await popupPage
      .locator('input[name="external-capability"][value="messages.send"]')
      .isChecked(),
    false,
    "unselected requested capabilities must remain unapproved",
  );
  await consentForm.locator('button[type="submit"]').click();
  await relyingPartyPage.waitForFunction(() => window.__receivedConsent);
  const receivedConsent = await relyingPartyPage.evaluate(
    () => window.__receivedConsent,
  );
  assert.equal(receivedConsent.origin, new URL(walletUrl).origin);
  assert.equal(receivedConsent.sourceMatchesPopup, true);
  assert.equal(receivedConsent.requestNonce, request.nonce);
  const nonceGuard = new NonceGuard();
  assert.equal(
    await verifyPermissionConsent(receivedConsent.consent, request, {
      expectedOrigin: relyingPartyOrigin,
      expectedWallet: walletAId,
      nonceGuard,
    }),
    true,
    "the relying party must verify the wallet's signed scope approval",
  );
  assert.deepEqual(receivedConsent.consent.body.payload.capabilities, [
    "presence.read",
  ]);
  assert.equal(
    await verifyPermissionConsent(receivedConsent.consent, request, {
      expectedOrigin: relyingPartyOrigin,
      expectedWallet: walletAId,
      nonceGuard,
    }),
    false,
    "a popup consent proof must not be accepted twice",
  );
  await popupPage.close();
  popupPage = null;
  await relyingPartyPage.close();
  relyingPartyPage = null;

  onboardingContext = await browser.newContext({ acceptDownloads: true });
  onboardingRelyingPartyPage = await onboardingContext.newPage();
  await onboardingRelyingPartyPage.goto(relyingPartyUrl);
  const onboardingRequest = await createPermissionRequest(relyingPartyOrigin, [
    "presence.read",
  ]);
  await onboardingRelyingPartyPage.evaluate(
    ({ request: permissionRequest, walletUrl: walletPopupUrl }) => {
      window.__permissionRequest = permissionRequest;
      window.__walletUrl = walletPopupUrl;
    },
    { request: onboardingRequest, walletUrl },
  );
  const onboardingPopupPromise =
    onboardingRelyingPartyPage.waitForEvent("popup");
  await onboardingRelyingPartyPage.locator("#connect").click();
  onboardingPopupPage = await onboardingPopupPromise;
  await onboardingPopupPage.waitForLoadState();
  await onboardingRelyingPartyPage.waitForFunction(() => window.__connectReady);
  await onboardingRelyingPartyPage.evaluate((permissionRequest) => {
    window.__walletPopup.postMessage(
      { type: "ai-auth/connect-request", request: permissionRequest },
      new URL(window.__walletUrl).origin,
    );
  }, onboardingRequest);
  await onboardingPopupPage.locator("[data-go-wallet]").waitFor();
  await onboardingPopupPage.locator("[data-go-wallet]").click();
  await createWallet(
    onboardingPopupPage,
    "E2E Popup Wallet",
    "Temporary popup passphrase",
    { waitForBackupButton: false },
  );
  await onboardingPopupPage.locator("#external-permission-form").waitFor();
  await onboardingPopupPage.locator('button[data-view="peer"]').click();
  await onboardingPopupPage.locator("#toggle-private").waitFor();
  await onboardingPopupPage.locator("#toggle-private").click();
  await onboardingPopupPage.locator("#toggle-private").click();
  assert.equal(
    await onboardingPopupPage.locator("#toggle-private").innerText(),
    "Go private",
  );
  await onboardingPopupPage.locator('button[data-view="connect"]').click();
  await onboardingPopupPage.locator("#external-permission-form").waitFor();

  onboardingObserverPage = await onboardingContext.newPage();
  await onboardingObserverPage.goto(url);
  await onboardingObserverPage.locator("#overview-peer-count").waitFor();
  await delay(500);
  assert.equal(
    await onboardingObserverPage.locator("#overview-peer-count").innerText(),
    "0",
    "a first-time consent popup must not advertise its new wallet before approval",
  );
  await onboardingObserverPage.close();
  onboardingObserverPage = null;

  await onboardingPopupPage
    .locator('input[name="external-capability"][value="presence.read"]')
    .check();
  await onboardingPopupPage
    .locator('#external-permission-form button[type="submit"]')
    .click();
  await onboardingRelyingPartyPage.waitForFunction(
    () => window.__receivedConsent,
  );
  const onboardingConsent = await onboardingRelyingPartyPage.evaluate(
    () => window.__receivedConsent,
  );
  assert.equal(onboardingConsent.sourceMatchesPopup, true);
  assert.equal(onboardingConsent.requestNonce, onboardingRequest.nonce);
  const onboardingWalletId = await onboardingPopupPage.evaluate(async () =>
    (await import("/packages/p2p/index.js"))
      .loadWallet()
      .then((wallet) => wallet.id),
  );
  assert.equal(
    await verifyPermissionConsent(
      onboardingConsent.consent,
      onboardingRequest,
      {
        expectedOrigin: relyingPartyOrigin,
        expectedWallet: onboardingWalletId,
        nonceGuard: new NonceGuard(),
      },
    ),
    true,
    "a newly created popup wallet must be able to approve the original request",
  );
  await onboardingContext.close();
  onboardingContext = null;
  onboardingPopupPage = null;
  onboardingRelyingPartyPage = null;

  const importContext = await browser.newContext({ acceptDownloads: true });
  const importRelyingPartyPage = await importContext.newPage();
  await importRelyingPartyPage.goto(relyingPartyUrl);
  const importRequest = await createPermissionRequest(relyingPartyOrigin, [
    "presence.read",
  ]);
  await importRelyingPartyPage.evaluate(
    ({ request: permissionRequest, walletUrl: walletPopupUrl }) => {
      window.__receivedConsent = null;
      window.__permissionRequest = permissionRequest;
      window.__walletUrl = walletPopupUrl;
    },
    { request: importRequest, walletUrl },
  );
  const importPopupPromise = importRelyingPartyPage.waitForEvent("popup");
  await importRelyingPartyPage.locator("#connect").click();
  const importPopupPage = await importPopupPromise;
  await importPopupPage.waitForLoadState();
  await importRelyingPartyPage.waitForFunction(() => window.__connectReady);
  await importRelyingPartyPage.evaluate((permissionRequest) => {
    window.__walletPopup.postMessage(
      { type: "ai-auth/connect-request", request: permissionRequest },
      new URL(window.__walletUrl).origin,
    );
  }, importRequest);
  await importPopupPage.locator("[data-go-wallet]").click();
  await importPopupPage.locator("#backup-file").setInputFiles({
    name: "ai-auth-alpha-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(alphaBackup),
  });
  await importPopupPage
    .locator("#restore-passphrase")
    .fill("Temporary alpha passphrase");
  await importPopupPage
    .locator('#import-wallet-form button[type="submit"]')
    .click();
  await importPopupPage.locator("#external-permission-form").waitFor();
  await importPopupPage.locator('button[data-view="peer"]').click();
  await importPopupPage.locator("#toggle-private").waitFor();
  await importPopupPage.locator("#toggle-private").click();
  await importPopupPage.locator("#toggle-private").click();
  assert.equal(
    await importPopupPage.locator("#toggle-private").innerText(),
    "Go private",
  );
  await importPopupPage.locator('button[data-view="connect"]').click();
  await importPopupPage.locator("#external-permission-form").waitFor();
  const importObserverPage = await importContext.newPage();
  await importObserverPage.goto(url);
  await importObserverPage.locator("#overview-peer-count").waitFor();
  await delay(500);
  assert.equal(
    await importObserverPage.locator("#overview-peer-count").innerText(),
    "0",
    "an imported consent-popup wallet must not advertise presence before approval",
  );
  await importContext.close();

  await Promise.all([
    pageA.locator('button[data-view="peer"]').click(),
    pageB.locator('button[data-view="peer"]').click(),
  ]);
  await Promise.all([
    pageA.getByText("E2E Beta", { exact: true }).first().waitFor(),
    pageB.getByText("E2E Alpha", { exact: true }).first().waitFor(),
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
    "Browser E2E passed: encrypted wallet recovery, distinct identities, one-use popup consent with approved-scope verification, signed presence, direct WebRTC, one signed delivery, and heartbeat-stable Overview.",
  );
}

try {
  await main();
} finally {
  await popupPage?.close().catch(() => {});
  await relyingPartyPage?.close().catch(() => {});
  await onboardingObserverPage?.close().catch(() => {});
  await onboardingContext?.close();
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
  if (relyingPartyServer.listening)
    await new Promise((resolve, reject) =>
      relyingPartyServer.close((error) => (error ? reject(error) : resolve())),
    );
  if (server.exitCode === null) {
    const exit = once(server, "exit");
    server.kill("SIGTERM");
    await Promise.race([exit, delay(5_000)]).catch(() => {});
  }
}
