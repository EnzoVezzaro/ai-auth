// Browser E2E for session persistence: connect once, reload the site, then
// resume the saved session through the explicit Resume action. No second
// wallet approval is given. The wallet is a real iframe page in this run.
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  approveWallet,
  launchBrowser,
  root,
  startStaticServer,
} from "./e2e/helpers.mjs";

const CAPS = ["presence.read", "messages.send"];
const server = await startStaticServer({ build: false });
const sdkBundle = await readFile(resolve(root, "dist-p2p/ai-auth.js"));
const site = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Resume E2E</title></head><body>
<button id="connect">Connect AI Auth wallet</button>
<button id="resume" hidden>Resume saved session</button>
<output id="status">Waiting</output>
<script type="module">
import { connectAIAuthModal, createSessionStore, listResumableSessions, resumeAIAuthSession } from "/ai-auth.js";
const options = {
  walletUrl: ${JSON.stringify(server.walletUrl)},
  capabilities: ${JSON.stringify(CAPS)},
  sessionTtlMs: 30 * 60_000,
};
const store = createSessionStore();
const attach = (connection) => {
  window.__connection = connection;
  window.__connected = true;
};
document.querySelector("#connect").addEventListener("click", async () => {
  try {
    attach(await connectAIAuthModal(options));
    document.querySelector("#status").textContent = "Connected";
  } catch (error) {
    window.__connectError = error.message;
  }
});
const records = await listResumableSessions(store, {
  origin: location.origin,
  room: "default",
  capabilities: ${JSON.stringify(CAPS)},
});
document.querySelector("#resume").hidden = records.length === 0;
document.querySelector("#resume").addEventListener("click", async () => {
  try {
    const connection = await resumeAIAuthSession({ ...options, sessionStore: store });
    if (!connection) throw new Error("No saved session to resume");
    attach(connection);
    window.__resumed = true;
    document.querySelector("#status").textContent = "Resumed";
  } catch (error) {
    window.__resumeError = error.message;
  }
});
</script></body></html>`;
const siteServer = createHttpServer((request, response) => {
  if (request.url === "/ai-auth.js") {
    response.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
    });
    response.end(sdkBundle);
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(site);
});
await new Promise((resolveListen, reject) => {
  siteServer.once("error", reject);
  siteServer.listen(0, "127.0.0.1", resolveListen);
});
const siteUrl = `http://127.0.0.1:${siteServer.address().port}/`;

const browser = await launchBrowser();
const contexts = [];
try {
  const context = await browser.newContext({ acceptDownloads: true });
  contexts.push(context);
  const { site: page } = await approveWallet(context, {
    siteUrl,
    name: "Resume E2E wallet",
    passphrase: "Resume E2E recovery passphrase",
    approve: CAPS,
  });
  await page.waitForFunction(() => window.__connected === true);
  const firstNonce = await page.evaluate(
    () => window.__connection.consent.body.payload.requestNonce,
  );

  // A page refresh rebuilds the iframe wallet too; the record and the wallet
  // key both survive, and the visitor clicks Resume instead of re-approving.
  await page.reload();
  const resume = page.locator("#resume");
  await resume.waitFor({ state: "visible", timeout: 10_000 });
  await resume.click();
  await page.waitForFunction(() => window.__connected === true, undefined, {
    timeout: 30_000,
  });
  assert.equal(await page.evaluate(() => window.__resumed), true);
  assert.equal(
    await page.evaluate(
      () => window.__connection.consent.body.payload.requestNonce,
    ),
    firstNonce,
    "resume reuses the stored consent; it does not mint a new approval",
  );
  console.log(
    "Session resume passed: a page refresh followed by Resume reused the signed consent without a new wallet approval.",
  );
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  await browser.close();
  await new Promise((close) => siteServer.close(close));
  await server.stop();
}
