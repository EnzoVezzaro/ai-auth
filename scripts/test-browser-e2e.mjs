import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const portProbe = createNetServer();
await new Promise((resolve, reject) => {
  portProbe.once("error", reject);
  portProbe.listen(0, "127.0.0.1", resolve);
});
const walletPort = portProbe.address().port;
await new Promise((resolve, reject) =>
  portProbe.close((error) => (error ? reject(error) : resolve())),
);
const basePath = "/ai-auth/";
const staticSiteUrl = `http://127.0.0.1:${walletPort}${basePath}`;
const walletBaseUrl = `${staticSiteUrl}wallet/`;
const walletUrl = `${walletBaseUrl}?debug=1`;
const walletServer = spawn(
  process.execPath,
  [resolve(root, "scripts/serve.mjs")],
  {
    env: {
      PATH: process.env.PATH,
      PORT: String(walletPort),
      BASE_PATH: basePath,
    },
    stdio: "inherit",
  },
);

const sdkBundle = await readFile(resolve(root, "dist-p2p/ai-auth.js"));
const siteServer = createHttpServer((request, response) => {
  if (request.url === "/ai-auth.js") {
    response.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    response.end(sdkBundle);
    return;
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'",
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`<!doctype html>
    <html lang="en"><head><meta charset="utf-8"><title>AI Auth site integration</title></head>
    <body>
      <button id="connect">Connect AI Auth wallet</button>
      <button id="invoke-tool" disabled>Invoke page tool</button>
      <button id="publish-cursor" disabled>Publish cursor</button>
      <output id="status">Waiting for approval</output>
      <ol id="events"></ol>
      <script type="module">
        import {
          connectAIAuthPopup,
          registerAIAuthPageActions,
        } from "/ai-auth.js";
        const walletUrl = ${JSON.stringify(walletUrl)};
        document.querySelector("#connect").addEventListener("click", async () => {
          try {
            const connection = await connectAIAuthPopup({
              walletUrl,
              capabilities: ["presence.read", "tools.invoke"],
            });
            window.__connection = connection;
            window.__pageActions = await registerAIAuthPageActions({
              connection,
              actions: [{
                name: "page.review",
                description: "Review a page through the site's approved tool.",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
                requiredCapability: "tools.invoke",
                execute: async ({ text }) => ({ reviewed: text }),
              }],
              publishAction: (event) => connection.publishAction({
                name: event.name,
                state: event.state,
                summary: event.summary,
              }),
            });
            connection.onEvent((envelope) => {
              const item = document.createElement("li");
              item.dataset.type = envelope.body.type;
              item.dataset.issuer = envelope.body.issuer;
              item.textContent = JSON.stringify(envelope.body.payload);
              document.querySelector("#events").append(item);
            });
            document.querySelector("#invoke-tool").disabled = false;
            document.querySelector("#publish-cursor").disabled = false;
            document.querySelector("#status").textContent = "Wallet approved";
            window.__connected = true;
          } catch (error) {
            document.querySelector("#status").textContent = error.message;
            window.__connectError = error.message;
          }
        });
        document.querySelector("#invoke-tool").addEventListener("click", async () => {
          try {
            const name = "page.review";
            if (document.modelContext?.executeTool) {
              const tool = (await document.modelContext.getTools())
                .find((candidate) => candidate.name === name);
              if (!tool) throw new Error("The approved WebMCP tool was not discoverable");
              window.__pageActionResult = await document.modelContext.executeTool(
                tool,
                { text: "Reviewed this workspace through WebMCP" },
              );
              window.__toolMode = "webmcp";
            } else {
              window.__pageActionResult = await window.__pageActions.execute(
                name,
                { text: "Reviewed this workspace through the JavaScript fallback" },
              );
              window.__toolMode = "javascript-fallback";
            }
            document.querySelector("#status").textContent = "Tool invoked via " + window.__toolMode;
          } catch (error) {
            document.querySelector("#status").textContent = error.message;
            window.__toolError = error.message;
          }
        });
        document.querySelector("#publish-cursor").addEventListener("click", () => {
          window.__connection.publishCursor({ x: 0.25, y: 0.75 });
        });
      </script>
    </body></html>`);
});
await new Promise((resolve, reject) => {
  siteServer.once("error", reject);
  siteServer.listen(0, "127.0.0.1", resolve);
});
const integrationSiteUrl = `http://127.0.0.1:${siteServer.address().port}/?debug=1`;
let browser;
const contexts = [];

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (walletServer.exitCode !== null)
      throw new Error(
        `Static wallet server exited with ${walletServer.exitCode}`,
      );
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Static wallet server did not serve ${url}`);
}

async function approveWallet(context, name, passphrase) {
  await context.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection;
    if (!NativePeerConnection) return;
    window.__aiAuthIceDiagnostics = [];
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget);
        peer.addEventListener("iceconnectionstatechange", async () => {
          if (!["failed", "disconnected"].includes(peer.iceConnectionState))
            return;
          const stats = await peer.getStats().catch(() => new Map());
          const entries = [...stats.values()];
          const candidates = entries
            .filter(
              (stat) =>
                stat.type === "local-candidate" ||
                stat.type === "remote-candidate",
            )
            .map(({ type, candidateType, protocol, port, relayProtocol }) => ({
              type,
              candidateType,
              protocol,
              port,
              relayProtocol,
            }));
          const pairs = entries
            .filter((stat) => stat.type === "candidate-pair")
            .map(
              ({
                state,
                nominated,
                selected,
                bytesSent,
                bytesReceived,
                localCandidateId,
                remoteCandidateId,
              }) => ({
                state,
                nominated,
                selected,
                bytesSent,
                bytesReceived,
                localCandidateId,
                remoteCandidateId,
              }),
            );
          window.__aiAuthIceDiagnostics.push({
            iceConnectionState: peer.iceConnectionState,
            connectionState: peer.connectionState,
            candidates,
            pairs,
          });
        });
        return peer;
      },
    });
  });
  const site = await context.newPage();
  const siteDiagnostics = [];
  site.on("console", (message) => {
    if (message.text().includes("[AI Auth debug]"))
      siteDiagnostics.push(message.text());
  });
  await site.goto(integrationSiteUrl);
  const popupPromise = site.waitForEvent("popup");
  await site.locator("#connect").click();
  const popup = await popupPromise;
  const popupErrors = [];
  popup.on("pageerror", (error) => popupErrors.push(error.message));
  popup.on("console", (message) => {
    if (
      message.type() === "error" ||
      message.text().includes("[AI Auth debug]")
    )
      popupErrors.push(message.text());
  });
  await popup.waitForLoadState("domcontentloaded");
  await popup.waitForFunction(
    () =>
      document
        .querySelector("#view")
        ?.innerText.includes("Requested capabilities"),
    undefined,
    { timeout: 10_000 },
  );
  if (await popup.locator("[data-go-wallet]").count()) {
    await popup.locator("[data-go-wallet]").click();
    await popup.locator("#wallet-name").fill(name);
    await popup.locator("#wallet-passphrase").fill(passphrase);
    await popup.locator("#wallet-passphrase-confirm").fill(passphrase);
    const download = popup.waitForEvent("download");
    await popup.locator('#create-wallet-form button[type="submit"]').click();
    await download;
  }
  try {
    await popup
      .locator("#external-permission-form")
      .waitFor({ timeout: 30_000 });
  } catch (error) {
    throw new Error(
      `Wallet popup did not show the permission form. Current view: ${await popup.locator("#view").innerText()} Errors: ${popupErrors.join(" | ")}`,
      { cause: error },
    );
  }
  await popup
    .locator('input[name="external-capability"][value="presence.read"]')
    .check();
  await popup
    .locator('input[name="external-capability"][value="tools.invoke"]')
    .check();
  await popup
    .locator('#external-permission-form button[type="submit"]')
    .click();
  await site.waitForFunction(() => window.__connected === true, undefined, {
    timeout: 30_000,
  });
  return { site, popup, popupErrors, siteDiagnostics };
}

try {
  await waitForServer(walletUrl);
  const landing = await fetch(staticSiteUrl).then((response) =>
    response.text(),
  );
  assert.match(landing, /href="\.\/wallet\/"/u);
  assert.match(landing, /href="\.\/docs\/ARCHITECTURE\.md"/u);
  assert.equal((await fetch(`${staticSiteUrl}landing.css`)).status, 200);
  const html = await fetch(walletUrl).then((response) => response.text());
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /href="\.\/styles\.css"/);
  assert.equal((await fetch(`${walletBaseUrl}app.js`)).status, 200);
  assert.equal((await fetch(`${walletBaseUrl}styles.css`)).status, 200);
  assert.equal((await fetch(`${staticSiteUrl}ai-auth.js`)).status, 200);

  browser = await chromium.launch({
    headless: true,
    ...(process.env.AI_AUTH_CHROMIUM_PATH
      ? { executablePath: process.env.AI_AUTH_CHROMIUM_PATH }
      : {}),
  });
  const contextA = await browser.newContext({ acceptDownloads: true });
  const contextB = await browser.newContext({ acceptDownloads: true });
  contexts.push(contextA, contextB);
  const {
    site: siteA,
    popup: popupA,
    popupErrors: popupErrorsA,
    siteDiagnostics: siteDiagnosticsA,
  } = await approveWallet(
    contextA,
    "First agent",
    "Temporary first passphrase",
  );
  const {
    site: siteB,
    popup: popupB,
    popupErrors: popupErrorsB,
    siteDiagnostics: siteDiagnosticsB,
  } = await approveWallet(
    contextB,
    "Second agent",
    "Temporary second passphrase",
  );

  await siteA.locator("#invoke-tool").click();
  try {
    await siteB.waitForFunction(
      () =>
        [...document.querySelectorAll("#events li")].some(
          (item) =>
            item.dataset.type === "agent/action" &&
            JSON.parse(item.textContent).state === "completed",
        ),
      undefined,
      { timeout: 25_000 },
    );
  } catch (error) {
    throw new Error(
      `Signed action was not delivered. Site A: ${await siteA.locator("#status").innerText()}, Site B: ${await siteB.locator("#status").innerText()}, wallet A: ${await popupA.locator("#topbar-status").innerText()}, wallet B: ${await popupB.locator("#topbar-status").innerText()}, ICE A: ${JSON.stringify(await popupA.evaluate(() => window.__aiAuthIceDiagnostics))}, ICE B: ${JSON.stringify(await popupB.evaluate(() => window.__aiAuthIceDiagnostics))}, site diagnostics A: ${siteDiagnosticsA.join(" | ")}, site diagnostics B: ${siteDiagnosticsB.join(" | ")}, wallet logs A: ${popupErrorsA.join(" | ")}, wallet logs B: ${popupErrorsB.join(" | ")}`,
      { cause: error },
    );
  }
  const action = await siteB
    .locator('#events li[data-type="agent/action"]')
    .last()
    .innerText();
  assert.match(action, /Completed page\.review/u);
  const actionStates = await siteB
    .locator('#events li[data-type="agent/action"]')
    .evaluateAll((items) =>
      items.map((item) => JSON.parse(item.textContent).state),
    );
  assert.deepEqual(actionStates.slice(-2), ["started", "completed"]);
  assert.match(
    await siteA.evaluate(() => document.querySelector("#status").textContent),
    /Tool invoked via (webmcp|javascript-fallback)/u,
  );

  await siteA.locator("#publish-cursor").click();
  await siteB.waitForFunction(
    () =>
      [...document.querySelectorAll("#events li")].some(
        (item) => item.dataset.type === "presence/cursor",
      ),
    undefined,
    { timeout: 60_000 },
  );
  assert.match(
    await siteB
      .locator('#events li[data-type="presence/cursor"]')
      .last()
      .innerText(),
    /0\.25.*0\.75/s,
  );

  console.log(
    "Browser E2E passed on /ai-auth/: landing, wallet and docs routes resolve; the page registered and invoked a scope-approved WebMCP tool or JS fallback, and a separate wallet received its signed started/completed action and cursor events over direct WebRTC.",
  );
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  await browser?.close().catch(() => {});
  if (siteServer.listening)
    await new Promise((resolve, reject) =>
      siteServer.close((error) => (error ? reject(error) : resolve())),
    );
  if (walletServer.exitCode === null) {
    const exited = once(walletServer, "exit");
    walletServer.kill("SIGTERM");
    await Promise.race([exited, delay(5_000)]).catch(() => {});
  }
}
