// E2E for the MCP approval window: a local server opens the wallet with a
// request in the URL; the human creates a wallet and approves; the signed
// consent is posted back to the loopback callback.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { webcrypto } from "node:crypto";
import { createPermissionRequest } from "../packages/p2p/index.js";
import { chromium } from "playwright";
import { startStaticServer, waitFor } from "./e2e/helpers.mjs";

globalThis.crypto ??= webcrypto;
globalThis.indexedDB ??= (await import("fake-indexeddb")).IDBFactory
  ? new (await import("fake-indexeddb")).IDBFactory()
  : globalThis.indexedDB;

const server = await startStaticServer();
const consentServer = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
  } else if (req.method === "POST") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  } else {
    res.writeHead(405).end();
  }
});
const received = [];
await new Promise((ok) => consentServer.listen(0, "127.0.0.1", ok));
const callback = `http://127.0.0.1:${consentServer.address().port}/consent/test`;

let browser;
try {
  const request = await createPermissionRequest(server.origin, [
    "presence.read",
    "messages.send",
  ]);
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
  const walletUrl = new URL(`${server.siteUrl}wallet/`);
  walletUrl.searchParams.set("connect", "1");
  walletUrl.searchParams.set("connect-request", encoded);
  walletUrl.searchParams.set("callback", callback);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(walletUrl.href);

  const wallet = page;
  await waitFor(
    async () => (await wallet.locator("#create-wallet-form").count()) > 0,
    { message: "inline wallet creation appears" },
  );
  await wallet.locator("#wallet-name").fill("MCP consent agent");
  await wallet
    .locator("#wallet-passphrase")
    .fill("mcp consent passphrase 2026");
  await wallet
    .locator("#wallet-passphrase-confirm")
    .fill("mcp consent passphrase 2026");
  const download = page.waitForEvent("download");
  await wallet.locator('#create-wallet-form button[type="submit"]').click();
  await download;
  await wallet.locator("#external-permission-form").waitFor();
  await wallet
    .locator('input[name="external-capability"][value="presence.read"]')
    .check();
  await wallet
    .locator('#external-permission-form button[type="submit"]')
    .click();

  await waitFor(() => received.length === 1, {
    message: "signed consent reaches the local callback",
  });
  const message = received[0];
  assert.equal(message.type, "ai-auth/connect-consent");
  assert.equal(message.requestNonce, request.nonce);
  assert.match(message.wallet.id, /^agent:/u);
  assert.deepEqual(message.consent.body.payload.capabilities.sort(), [
    "presence.read",
  ]);
  assert.deepEqual(errors, []);
  console.log(
    "MCP consent window E2E passed: the URL-carried request opened the wallet, approval was created, and the signed consent reached the loopback callback.",
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((ok) => consentServer.close(ok));
  await server.stop?.();
  server.child?.kill("SIGTERM");
}
