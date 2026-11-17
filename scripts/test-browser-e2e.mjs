import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  approveWallet as approveWalletModal,
  expectStable,
  freePort,
  launchBrowser,
  root,
  waitFor,
  waitForServer,
} from "./e2e/helpers.mjs";

const walletPort = await freePort();
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
  if (request.url?.split("?")[0] === "/agent") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; style-src 'unsafe-inline';`,
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(`<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><title>AI Auth agent client</title></head>
      <body>
        <button id="connect-agent">Register and connect agent</button>
        <output id="agent-status">Agent is not connected</output>
        <section id="agent-catalog-state">
          <h2>Agent's live view of site tools</h2>
          <p>Connection: <output id="agent-connection">not connected</output></p>
          <p>Visible tool count: <output id="agent-tool-count">0</output></p>
          <ul id="agent-tool-list"></ul>
          <p>Catalog changes: <output id="agent-catalog-history">no catalog yet</output></p>
        </section>
        <script type="module">
          import { createWallet, P2PRoom, NostrWebRTC, createAIAuthAgentClient } from "/ai-auth.js";
          const status = document.querySelector("#agent-status");
          const connection = document.querySelector("#agent-connection");
          const toolCount = document.querySelector("#agent-tool-count");
          const toolList = document.querySelector("#agent-tool-list");
          const history = document.querySelector("#agent-catalog-history");
          const targetWallet = new URLSearchParams(location.search).get("site");
          window.__targetSiteWallet = targetWallet;
          let lastCount = -1;
          const changes = [];
          // Render the agent's live state into the DOM so a screenshot shows what
          // the agent can actually see. Filter to the site under test: other
          // peers in the room also publish tool catalogs.
          const renderAgentState = () => {
            const catalogs = (window.__agentCatalogs ?? []).filter(
              (catalog) => !targetWallet || catalog.wallet === targetWallet,
            );
            const names = [...new Set(catalogs.flatMap((catalog) =>
              (catalog.tools ?? []).map((tool) => tool.name),
            ))].sort();
            if (names.length !== lastCount) {
              changes.push(\`\${lastCount < 0 ? "initial" : lastCount} -> \${names.length} tool(s)\`);
              lastCount = names.length;
            }
            connection.textContent = window.__agentConnected ? "connected" : "not connected";
            toolCount.textContent = String(names.length);
            toolList.replaceChildren(...names.map((name) => {
              const item = document.createElement("li");
              item.textContent = name;
              return item;
            }));
            history.textContent = changes.join(" | ");
          };
          window.__renderAgentState = renderAgentState;
          // The catalog getter is live, but a withdrawal removes a catalog
          // without firing onCatalog, so refresh the DOM on a timer as well.
          setInterval(renderAgentState, 100);
          renderAgentState();
          document.querySelector("#connect-agent").addEventListener("click", async () => {
            try {
              const wallet = await createWallet({ name: "Browser E2E agent", passphrase: "Temporary E2E agent passphrase" });
              const room = new P2PRoom(wallet, "default", {
                origin: location.origin,
                capabilities: ["presence.read", "tools.invoke"],
              });
              const transport = new NostrWebRTC(room, { origin: location.origin, room: "default" });
              const client = createAIAuthAgentClient(room);
              // A live getter, so a provider withdrawal or expiry is
              // observable without waiting for another catalog announcement.
              Object.defineProperty(window, "__agentCatalogs", {
                configurable: true,
                get: () => client.catalogs,
              });
              await transport.start();
              window.__agent = { wallet, room, transport, client };
              status.textContent = "Agent registered and connected";
              window.__agentConnected = true;
              renderAgentState();
            } catch (error) {
              status.textContent = error.message;
              window.__agentError = error.message;
              renderAgentState();
            }
          });
        </script>
      </body></html>`);
    return;
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-src http://127.0.0.1:${walletPort}`,
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`<!doctype html>
    <html lang="en"><head><meta charset="utf-8"><title>AI Auth site integration</title></head>
    <body>
      <button id="connect">Connect AI Auth wallet</button>
      <button id="invoke-tool" disabled>Invoke page tool</button>
      <button id="publish-cursor" disabled>Publish cursor</button>
      <button id="withdraw-tools" disabled>Withdraw page tools</button>
      <button id="approve-action" hidden>Approve agent action</button>
      <section id="share-target">Public workspace section for collaboration</section>
      <output id="status">Waiting for approval</output>
      <ol id="events"></ol>
      <script>
        const fakeScreen = document.createElement("canvas");
        fakeScreen.width = 640;
        fakeScreen.height = 360;
        const fakeContext = fakeScreen.getContext("2d");
        fakeContext.fillStyle = "#17634d";
        fakeContext.fillRect(0, 0, fakeScreen.width, fakeScreen.height);
        let fakeFrame = false;
        window.__fakeScreenTimer = setInterval(() => {
          fakeFrame = !fakeFrame;
          fakeContext.fillStyle = fakeFrame ? "#17634d" : "#1c6e54";
          fakeContext.fillRect(0, 0, fakeScreen.width, fakeScreen.height);
        }, 100);
        fakeScreen.style.cssText = "position:fixed;left:-10000px;top:0";
        document.body.append(fakeScreen);
        window.__fakeScreenCaptureCalls = 0;
        HTMLMediaElement.prototype.play = async () => {};
        Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
          configurable: true,
          get: () => 640,
        });
        Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
          configurable: true,
          get: () => 360,
        });
        const drawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
          if (source instanceof HTMLVideoElement) {
            this.fillStyle = "#17634d";
            this.fillRect(0, 0, this.canvas.width, this.canvas.height);
            return;
          }
          return drawImage.call(this, source, ...args);
        };
        Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
          configurable: true,
          value: async () => {
            window.__fakeScreenCaptureCalls++;
            return fakeScreen.captureStream(2);
          },
        });
      </script>
      <script type="module">
        import {
          connectAIAuthModal,
          mountCollaborationWheel,
          mountAIAuthInPageAgent,
        } from "/ai-auth.js";
        const walletUrl = ${JSON.stringify(walletUrl)};
        document.querySelector("#connect").addEventListener("click", async () => {
          try {
            const connection = await connectAIAuthModal({
              walletUrl,
              capabilities: ["presence.read", "tools.invoke", "messages.send", "content.share"],
              // A numeric session: the lifecycle checks below need an expiry (default is Never).
              sessionTtlMs: 30 * 60_000,
            });
            window.__connection = connection;
            window.__removeWheel = mountCollaborationWheel(connection.transfers, { capabilities: connection.capabilities });
            window.__transfers = [];
            connection.transfers.subscribe((event) => window.__transfers.push(event));
            connection.onDisconnect(() => { window.__connected = false; window.__disconnected = true; window.__removeWheel(); });
            window.__pendingActionApproval = null;
            let demoCounter = 0;
            window.__pageActions = await mountAIAuthInPageAgent({
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
                execute: async ({ text }, { signal }) => {
                  if (text.includes("wait for remote cancellation"))
                    await new Promise((resolve) =>
                      signal.addEventListener("abort", resolve, { once: true }),
                    );
                  return { reviewed: text };
                },
              }, {
                name: "demo.echo",
                description: "Echo a message on an independent test website.",
                inputSchema: {
                  type: "object",
                  properties: { message: { type: "string" } },
                  required: ["message"],
                },
                requiredCapability: "tools.invoke",
                execute: async ({ message }) => ({ echoed: message }),
              }, {
                name: "demo.increment",
                description: "Increment the independent site's counter.",
                inputSchema: { type: "object", properties: {} },
                requiredCapability: "tools.invoke",
                execute: async () => ({ count: ++demoCounter }),
              }],
              authorize: (action, input, context) => new Promise((resolve) => {
                window.__pendingActionApproval = { action, input, context, resolve };
                document.querySelector("#approve-action").hidden = false;
              }),
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
            document.querySelector("#withdraw-tools").disabled = false;
            document.querySelector("#withdraw-tools").addEventListener("click", () => {
              window.__pageActions.stop();
              document.querySelector("#status").textContent = "Page tools withdrawn";
            });
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
        document.querySelector("#approve-action").addEventListener("click", () => {
          const pending = window.__pendingActionApproval;
          if (!pending) return;
          window.__pendingActionApproval = null;
          document.querySelector("#approve-action").hidden = true;
          pending.resolve(true);
        });
      </script>
    </body></html>`);
});
await new Promise((resolve, reject) => {
  siteServer.once("error", reject);
  siteServer.listen(0, "127.0.0.1", resolve);
});
const integrationSiteUrl = `http://localhost:${siteServer.address().port}/?debug=1`;
let browser;
const contexts = [];
let evidencePage = null;

function approveWallet(context, name, passphrase) {
  return approveWalletModal(context, {
    siteUrl: integrationSiteUrl,
    name,
    passphrase,
    approve: [
      "presence.read",
      "tools.invoke",
      "messages.send",
      "content.share",
    ],
  });
}

try {
  await waitForServer(walletUrl, walletServer);
  const landing = await fetch(staticSiteUrl).then((response) =>
    response.text(),
  );
  assert.match(landing, /href="\.\/wallet\/"/u);
  assert.match(landing, /href="\.\/docs\/ARCHITECTURE\.html"/u);
  assert.equal((await fetch(`${staticSiteUrl}landing.css`)).status, 200);
  const html = await fetch(walletUrl).then((response) => response.text());
  assert.match(html, /src="\.\/app\.js(\?v=[^"]*)?"/);
  assert.match(html, /href="\.\/styles\.css(\?v=[^"]*)?"/);
  assert.equal((await fetch(`${walletBaseUrl}app.js`)).status, 200);
  assert.equal((await fetch(`${walletBaseUrl}styles.css`)).status, 200);
  assert.equal((await fetch(`${staticSiteUrl}ai-auth.js`)).status, 200);

  browser = await launchBrowser();
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
  await siteA.locator("#approve-action").waitFor({ state: "visible" });
  await siteA.locator("#approve-action").click();
  try {
    await siteB.waitForFunction(
      () =>
        [...document.querySelectorAll("#events li")].some(
          (item) =>
            item.dataset.type === "agent/action" &&
            JSON.parse(item.textContent).name === "page.review" &&
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
  const completedPageAction = await siteB
    .locator('#events li[data-type="agent/action"]')
    .evaluateAll((items) =>
      items
        .map((item) => JSON.parse(item.textContent))
        .findLast(
          (event) =>
            event.name === "page.review" && event.state === "completed",
        ),
    );
  assert.equal(completedPageAction.summary, "Completed page.review");
  const actionStates = await siteB
    .locator('#events li[data-type="agent/action"]')
    .evaluateAll((items) =>
      items
        .map((item) => JSON.parse(item.textContent))
        .filter((event) => event.name === "page.review")
        .map((event) => event.state),
    );
  assert.deepEqual(actionStates.slice(-2), ["started", "completed"]);
  assert.match(
    await siteA.evaluate(() => document.querySelector("#status").textContent),
    /Tool invoked via (webmcp|javascript-fallback)/u,
  );

  evidencePage = siteB;
  const shots = resolve(root, "test-results/screenshots");
  await mkdir(shots, { recursive: true });
  const targetSiteWallet = await siteA.evaluate(
    () => window.__connection.identity.id,
  );
  const agentPage = await contextA.newPage();
  const agentPageErrors = [];
  agentPage.on("pageerror", (error) => agentPageErrors.push(error.message));
  await agentPage.goto(
    `${integrationSiteUrl.replace("/?debug=1", "/agent")}?site=${encodeURIComponent(targetSiteWallet)}`,
  );
  await agentPage.locator("#connect-agent").click();
  await agentPage.waitForFunction(
    () => window.__agentConnected === true,
    undefined,
    {
      timeout: 30_000,
    },
  );
  await agentPage.evaluate(() => window.__renderAgentState());
  await siteA.screenshot({
    path: resolve(shots, "generic-site-connected.png"),
    fullPage: true,
  });
  await agentPage.screenshot({
    path: resolve(shots, "generic-agent-connected.png"),
    fullPage: true,
  });
  try {
    await agentPage.waitForFunction(
      (walletId) =>
        window.__agentCatalogs?.some((catalog) => catalog.wallet === walletId),
      targetSiteWallet,
      {
        timeout: 60_000,
      },
    );
  } catch (error) {
    const diagnostics = {
      targetSiteWallet,
      catalogWallets: await agentPage.evaluate(() =>
        (window.__agentCatalogs ?? []).map((catalog) => catalog.wallet),
      ),
      agentPeers: await agentPage.evaluate(() =>
        Object.keys(window.__agent?.transport?.transport?.getPeers?.() ?? {}),
      ),
      siteAStatus: await siteA.locator("#status").innerText(),
      siteBStatus: await siteB.locator("#status").innerText(),
      walletAStatus: await popupA.locator("#topbar-status").innerText(),
      walletBStatus: await popupB.locator("#topbar-status").innerText(),
      walletAIce: await popupA.evaluate(
        () => window.__aiAuthIceDiagnostics ?? [],
      ),
      walletBIce: await popupB.evaluate(
        () => window.__aiAuthIceDiagnostics ?? [],
      ),
      siteADiagnostics: siteDiagnosticsA,
      siteBDiagnostics: siteDiagnosticsB,
      walletAErrors: popupErrorsA,
      walletBErrors: popupErrorsB,
      agentPageErrors,
    };
    throw new Error(
      `The agent did not discover site A's wallet catalog: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
  const agentCatalog = await agentPage.evaluate(
    (walletId) =>
      window.__agentCatalogs.find((catalog) => catalog.wallet === walletId),
    targetSiteWallet,
  );
  assert.ok(agentCatalog, "the agent discovered site A's wallet catalog");
  assert.ok(agentCatalog.tools.some((tool) => tool.name === "page.review"));
  // These tools belong to this generic test website, not to AI Auth or BODY4AI.
  assert.ok(agentCatalog.tools.some((tool) => tool.name === "demo.echo"));
  assert.ok(agentCatalog.tools.some((tool) => tool.name === "demo.increment"));

  // The agent page renders its live catalog into the DOM so screenshots and
  // assertions both describe what the agent can actually see.
  const readAgentDom = async () => {
    await agentPage.evaluate(() => window.__renderAgentState());
    return {
      status: await agentPage.locator("#agent-status").innerText(),
      connection: await agentPage.locator("#agent-connection").innerText(),
      count: await agentPage.locator("#agent-tool-count").innerText(),
      tools: await agentPage.locator("#agent-tool-list").innerText(),
      history: await agentPage.locator("#agent-catalog-history").innerText(),
    };
  };
  const domCatalogVisible = await readAgentDom();
  console.log(`Agent DOM with catalog: ${JSON.stringify(domCatalogVisible)}`);
  assert.match(
    domCatalogVisible.tools,
    /page\.review/u,
    "agent DOM lists page.review",
  );
  assert.match(
    domCatalogVisible.tools,
    /demo\.echo/u,
    "agent DOM lists demo.echo",
  );
  assert.match(
    domCatalogVisible.tools,
    /demo\.increment/u,
    "agent DOM lists demo.increment",
  );
  assert.ok(
    Number(domCatalogVisible.count) >= 3,
    `agent DOM tool count is non-empty: ${domCatalogVisible.count}`,
  );
  await agentPage.screenshot({
    path: resolve(shots, "generic-agent-client-connected.png"),
    fullPage: true,
  });

  const invokeDemoTool = async (name, input) => {
    const response = agentPage.evaluate(
      ({ catalog, name, input }) =>
        window.__agent.client.callTool(catalog, name, input),
      { catalog: agentCatalog, name, input },
    );
    await siteA
      .locator("#approve-action")
      .waitFor({ state: "visible", timeout: 60_000 });
    await siteA.locator("#approve-action").click();
    return response;
  };
  assert.deepEqual(
    await invokeDemoTool("demo.echo", {
      message: "hello from another agent wallet",
    }),
    { echoed: "hello from another agent wallet" },
  );
  assert.deepEqual(await invokeDemoTool("demo.increment", {}), { count: 1 });
  assert.deepEqual(await invokeDemoTool("demo.increment", {}), { count: 2 });
  const agentCall = agentPage.evaluate(
    (catalog) =>
      window.__agent.client.callTool(catalog, "page.review", {
        text: "Reviewed by a separately connected agent wallet",
      }),
    agentCatalog,
  );
  await siteA
    .locator("#approve-action")
    .waitFor({ state: "visible", timeout: 60_000 });
  const agentLifecycleBeforeApproval = await siteA
    .locator('#events li[data-type="agent/action"]')
    .count();
  await siteA.locator("#approve-action").click();
  assert.deepEqual(await agentCall, {
    reviewed: "Reviewed by a separately connected agent wallet",
  });
  await siteB.waitForFunction(
    (previousCount) =>
      [...document.querySelectorAll('#events li[data-type="agent/action"]')]
        .slice(previousCount)
        .some(
          (item) =>
            JSON.parse(item.textContent).summary === "Completed page.review",
        ),
    agentLifecycleBeforeApproval,
    { timeout: 30_000 },
  );
  const startedActionsBeforeCancel = await siteB
    .locator('#events li[data-type="agent/action"]')
    .evaluateAll(
      (items) =>
        items.filter((item) => JSON.parse(item.textContent).state === "started")
          .length,
    );
  await agentPage.evaluate((catalog) => {
    const controller = new AbortController();
    window.__agentCancelController = controller;
    window.__agentCancelResult = window.__agent.client
      .callTool(
        catalog,
        "page.review",
        { text: "wait for remote cancellation" },
        { signal: controller.signal },
      )
      .then(
        () => ({ name: "unexpected-success" }),
        (error) => ({ name: error.name, message: error.message }),
      );
  }, agentCatalog);
  await siteA.locator("#approve-action").waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await siteA.locator("#approve-action").click();
  await siteB.waitForFunction(
    (previousCount) =>
      [
        ...document.querySelectorAll('#events li[data-type="agent/action"]'),
      ].filter((item) => JSON.parse(item.textContent).state === "started")
        .length > previousCount,
    startedActionsBeforeCancel,
    { timeout: 30_000 },
  );
  await agentPage.evaluate(() => window.__agentCancelController.abort());
  assert.equal(
    (await agentPage.evaluate(() => window.__agentCancelResult)).name,
    "AbortError",
  );
  await siteB.waitForFunction(
    () =>
      [
        ...document.querySelectorAll('#events li[data-type="agent/action"]'),
      ].some((item) => JSON.parse(item.textContent).state === "cancelled"),
    undefined,
    { timeout: 30_000 },
  );
  await agentPage.evaluate(() =>
    window.__agent.client.publishCursor({ x: 0.61, y: 0.28, scroll: 0.4 }),
  );
  await siteB.waitForFunction(
    () =>
      [
        ...document.querySelectorAll('#events li[data-type="presence/cursor"]'),
      ].some((item) => JSON.parse(item.textContent).label.length > 0),
    undefined,
    { timeout: 30_000 },
  );

  await siteA.locator("#publish-cursor").click();
  await siteB.waitForFunction(
    () =>
      [...document.querySelectorAll('#events li[data-type="presence/cursor"]')]
        .map((item) => JSON.parse(item.textContent))
        .some((event) => event.x === 0.25 && event.y === 0.75),
    undefined,
    { timeout: 60_000 },
  );
  const humanCursor = await siteB
    .locator('#events li[data-type="presence/cursor"]')
    .evaluateAll((items) =>
      items
        .map((item) => JSON.parse(item.textContent))
        .findLast((event) => event.x === 0.25 && event.y === 0.75),
    );
  assert.deepEqual(
    {
      x: humanCursor.x,
      y: humanCursor.y,
      visible: humanCursor.visible,
      label: humanCursor.label,
    },
    { x: 0.25, y: 0.75, visible: true, label: "First agent" },
  );

  await siteA
    .locator(
      '[data-ai-auth-collaboration-wheel] button[aria-label="Open collaboration"]',
    )
    .click();
  await siteA
    .getByRole("textbox", { name: "Message" })
    .fill("Wheel chat message");
  await siteA.getByRole("button", { name: "Send", exact: true }).click();
  await siteB.waitForFunction(
    () =>
      window.__transfers.some(
        (event) => event.type === "text" && event.text === "Wheel chat message",
      ),
    undefined,
    { timeout: 30000 },
  );
  assert.equal(
    await siteB.evaluate(
      () =>
        window.__transfers.find((event) => event.type === "text").envelope.body
          .type,
    ),
    "message/text",
  );
  await siteA.getByRole("button", { name: "Share element" }).click();
  await siteA.locator("#share-target").click();
  // The wheel previews every share before it is sent.
  await siteA.locator('[data-action="confirm"]').waitFor({ timeout: 10_000 });
  await siteA.locator('[data-action="confirm"]').click();
  await siteB.waitForFunction(
    () =>
      window.__transfers.some(
        (event) =>
          event.type === "element" &&
          event.metadata?.text === "Public workspace section for collaboration",
      ),
    undefined,
    { timeout: 30_000 },
  );
  await siteA.getByRole("button", { name: "Screenshot" }).click();
  await siteA.locator('[data-action="confirm"]').waitFor({ timeout: 10_000 });
  await siteA.locator('[data-action="confirm"]').click();
  try {
    await siteB.waitForFunction(
      () =>
        window.__transfers.some(
          (event) =>
            event.type === "attachment" &&
            event.name === "screenshot.jpg" &&
            event.kind === "screenshot",
        ),
      undefined,
      { timeout: 30_000 },
    );
  } catch (error) {
    const status = await siteA
      .locator("[data-ai-auth-collaboration-wheel]")
      .evaluate((host) => ({
        status: host.shadowRoot.querySelector(".status").textContent,
        captureCalls: host.ownerDocument.defaultView.__fakeScreenCaptureCalls,
        screenshotDisabled:
          host.shadowRoot
            .querySelector('[data-action="screenshot"]')
            .getAttribute("aria-disabled") === "true",
      }));
    throw new Error(
      `Screenshot was not shared. Wheel diagnostics: ${JSON.stringify(status)}`,
      {
        cause: error,
      },
    );
  }
  await siteA.getByRole("button", { name: "Record screen" }).click();
  await siteA.getByRole("button", { name: "Stop recording" }).waitFor({
    timeout: 10_000,
  });
  await delay(1_000);
  await siteA.getByRole("button", { name: "Stop recording" }).click();
  await siteA.locator('[data-action="confirm"]').waitFor({ timeout: 10_000 });
  await siteA.locator('[data-action="confirm"]').click();
  try {
    await siteB.waitForFunction(
      () =>
        window.__transfers.some(
          (event) =>
            event.type === "attachment" &&
            event.name === "recording.webm" &&
            event.kind === "recording",
        ),
      undefined,
      { timeout: 30_000 },
    );
  } catch (error) {
    const diagnostics = await siteA
      .locator("[data-ai-auth-collaboration-wheel]")
      .evaluate((host) => ({
        status: host.shadowRoot.querySelector(".status").textContent,
        button: host.shadowRoot.querySelector('[data-action="record"]')
          .textContent,
        captureCalls: host.ownerDocument.defaultView.__fakeScreenCaptureCalls,
      }));
    throw new Error(
      `Recording was not shared. Wheel diagnostics: ${JSON.stringify(diagnostics)}`,
      {
        cause: error,
      },
    );
  }
  await siteA.evaluate(() =>
    window.__connection.transfers.sendAttachment(
      new Blob(["sensitive-image-payload"], { type: "image/png" }),
      { kind: "screenshot", name: "test.png" },
    ),
  );
  await siteB.waitForFunction(
    () =>
      window.__transfers.some(
        (event) => event.type === "attachment" && event.name === "test.png",
      ),
    undefined,
    { timeout: 30000 },
  );
  const persisted = await popupB.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-auth-wallet-v2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve, reject) => {
      const request = db
        .transaction("activity")
        .objectStore("activity")
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return JSON.stringify(records);
  });
  assert.doesNotMatch(
    persisted,
    /c2Vuc2l0aXZlLWltYWdlLXBheWxvYWQ=/u,
    "attachment bytes never enter activity history",
  );
  // WebMCP lifecycle: the page is the tool provider. Withdrawing it while the
  // signed session is still live must drop the catalog for every connected agent.
  await siteA.locator("#withdraw-tools").click();
  await agentPage.waitForFunction(
    (walletId) =>
      !window.__agentCatalogs.some((catalog) => catalog.wallet === walletId),
    targetSiteWallet,
    { timeout: 15_000 },
  );
  const domToolsWithdrawn = await readAgentDom();
  console.log(
    `Agent DOM after withdrawal: ${JSON.stringify(domToolsWithdrawn)}`,
  );
  assert.equal(
    domToolsWithdrawn.tools.trim(),
    "",
    "agent DOM tool list is empty after the site withdraws its tools",
  );
  assert.equal(
    domToolsWithdrawn.count,
    "0",
    "agent DOM tool count is zero after the site withdraws its tools",
  );
  await agentPage.screenshot({
    path: resolve(shots, "generic-agent-tools-withdrawn.png"),
    fullPage: true,
  });

  // Session lifetime: the handshake challenge is short, the signed session is
  // not. Both pages share one controllable clock so the test can cross the old
  // two-minute limit, renew explicitly, and then run past the session expiry
  // without waiting in real time.
  const setClockOffset = (offsetMs) =>
    Promise.all(
      [popupA, siteA].map((page) =>
        page.evaluate((offset) => {
          // Both Date.now() and new Date() follow the controllable clock, so
          // signed timestamps and verifier clocks stay consistent.
          window.__RealDate ??= Date;
          const RealDate = window.__RealDate;
          window.__realNow ??= RealDate.now.bind(RealDate);
          window.__clockOffset = offset;
          window.Date = class extends RealDate {
            constructor(...args) {
              if (args.length) super(...args);
              else super(window.__realNow() + window.__clockOffset);
            }
            static now() {
              return window.__realNow() + window.__clockOffset;
            }
          };
        }, offsetMs),
      ),
    );
  await popupA.evaluate(() => {
    window.__realSign = crypto.subtle.sign.bind(crypto.subtle);
    window.__signCount = 0;
    crypto.subtle.sign = (...args) => {
      window.__signCount++;
      return window.__realSign(...args);
    };
  });
  const publishFromSite = (summary) =>
    siteA.evaluate((text) => {
      try {
        window.__connection.publishAction({
          name: "lifetime.check",
          state: "progress",
          summary: text,
        });
        return "";
      } catch (error) {
        return error.message;
      }
    }, summary);
  const signedCount = () => popupA.evaluate(() => window.__signCount);
  const initialExpiry = await siteA.evaluate(
    () => window.__connection.expiresAt,
  );
  const sessionLengthMs = await siteA.evaluate(
    () =>
      window.__connection.expiresAt -
      window.__connection.consent.body.payload.issuedAt,
  );
  assert.ok(
    sessionLengthMs >= 15 * 60_000,
    "session grant is longer than the 2 minute handshake",
  );
  assert.match(
    await popupA.locator("#session-countdown").innerText(),
    /Session ends at/u,
    "wallet UI shows when the session expires",
  );

  // Three minutes later (past the old 2 minute connection limit) the session
  // is still authorized end to end.
  await setClockOffset(180_000);
  const signedBefore = await signedCount();
  assert.equal(await publishFromSite("after three minutes"), "");
  await popupA.waitForFunction(
    (count) => window.__signCount > count,
    signedBefore,
    { timeout: 10_000 },
  );

  // Renewal needs the wallet owner to approve again and never adds scopes.
  const renewing = siteA.evaluate(() =>
    window.__connection
      .renew()
      .then(() => "renewed")
      .catch((error) => error.message),
  );
  await popupA.locator("#approve-renewal").click();
  assert.equal(await renewing, "renewed");
  const renewedExpiry = await siteA.evaluate(
    () => window.__connection.expiresAt,
  );
  assert.ok(renewedExpiry > initialExpiry, "renewal moved the expiry forward");
  assert.deepEqual(
    await siteA.evaluate(() => [...window.__connection.capabilities]),
    ["content.share", "messages.send", "presence.read", "tools.invoke"],
    "renewal kept the same capabilities",
  );

  // Past the original expiry the renewed session is still usable. Activity
  // keeps the 10 minute idle timeout from firing along the way.
  for (const minute of [12, 21, 30, 32]) {
    await setClockOffset(minute * 60_000);
    assert.equal(await publishFromSite(`minute ${minute}`), "");
    await delay(150);
  }
  assert.ok(
    renewedExpiry >
      (await siteA.evaluate(() => window.__realNow())) + 32 * 60_000,
    "clock is past the original expiry but inside the renewed session",
  );

  // Past the renewed expiry nothing is signed, published or delivered.
  const before = await siteB
    .locator('#events li[data-type="agent/action"]')
    .count();
  await setClockOffset(70 * 60_000);
  await siteA.evaluate(() => {
    window.__lifecycle = [];
    window.__connection.onLifecycle((event) => window.__lifecycle.push(event));
  });
  await siteA.evaluate(
    (targetOrigin) =>
      document.querySelector("dialog iframe").contentWindow.postMessage(
        {
          type: "ai-auth/site-action",
          action: {
            name: "expired.test",
            state: "completed",
            summary: "must not sign",
          },
        },
        targetOrigin,
      ),
    new URL(walletUrl).origin,
  );
  // Wait for the real lifecycle transition, then watch the event count over a
  // window: a single delayed sleep cannot tell "no event" from "late event".
  await waitFor(
    () => siteA.evaluate(() => window.__lifecycle.at(-1)?.reason === "expired"),
    { timeout: 10_000, message: "expired session to disconnect" },
  );
  await expectStable(
    () => siteB.locator('#events li[data-type="agent/action"]').count(),
    { window: 1_000, message: "expired wallet's event count" },
  );
  assert.equal(
    await siteB.locator('#events li[data-type="agent/action"]').count(),
    before,
    "expired wallet did not sign direct host messages",
  );
  assert.deepEqual(
    (await siteA.evaluate(() => window.__lifecycle)).at(-1),
    { type: "disconnected", reason: "expired" },
    "expired session disconnected and removed the wallet modal",
  );
  assert.match(
    await publishFromSite("after expiry"),
    /connection is closed/u,
    "expired session cannot publish",
  );
  assert.equal(await siteA.evaluate(() => window.__connected), false);
  await siteA.evaluate(() => {
    window.Date = window.__RealDate;
  });
  await siteA.evaluate(() => window.__connection.close());
  assert.equal(await siteA.evaluate(() => window.__disconnected), true);
  assert.equal(await siteA.evaluate(() => window.__connected), false);
  assert.equal(await siteA.locator("dialog iframe").count(), 0);
  await siteA.screenshot({
    path: resolve(shots, "generic-site-disconnected.png"),
    fullPage: true,
  });

  // Save unmodified browser screenshots as CI evidence after the real P2P,
  // authorization, tool execution, and cursor assertions have passed.
  const screenshots = resolve(root, "test-results/screenshots");
  await mkdir(screenshots, { recursive: true });
  await siteB.screenshot({
    path: resolve(screenshots, "generic-site-verified-events.png"),
    fullPage: true,
  });
  console.log(
    "Saved verified browser screenshots under test-results/screenshots/",
  );

  // Evidence integrity: every state screenshot must be a distinct image. A
  // byte-identical agent shot would mean the page failed to show its live
  // catalog, which is exactly the misleading evidence this guards against.
  const md5Of = async (name) =>
    createHash("md5")
      .update(await readFile(resolve(shots, name)))
      .digest("hex");
  const agentShotNames = [
    "generic-agent-connected.png",
    "generic-agent-client-connected.png",
    "generic-agent-tools-withdrawn.png",
  ];
  const screenshotMd5 = Object.fromEntries(
    await Promise.all(
      [
        ...agentShotNames,
        "generic-site-connected.png",
        "generic-site-disconnected.png",
      ].map(async (name) => [name, await md5Of(name)]),
    ),
  );
  console.log(`Screenshot md5: ${JSON.stringify(screenshotMd5)}`);
  const agentMd5s = agentShotNames.map((name) => screenshotMd5[name]);
  assert.equal(
    new Set(agentMd5s).size,
    agentMd5s.length,
    `agent screenshots must differ in md5: ${JSON.stringify(screenshotMd5)}`,
  );
  assert.notEqual(
    screenshotMd5["generic-site-connected.png"],
    screenshotMd5["generic-site-disconnected.png"],
    "site connected and disconnected screenshots must differ in md5",
  );

  if (process.env.AI_AUTH_CHECK_TOP_LEVEL_WALLET) {
    const contextC = await browser.newContext({ acceptDownloads: true });
    contexts.push(contextC);
    await contextC.addCookies([
      {
        name: "third_party_probe",
        value: "allowed",
        url: walletBaseUrl,
        sameSite: "None",
        secure: true,
      },
    ]);
    const top = await contextC.newPage();
    await top.goto(walletBaseUrl);
    await top.locator("[data-go-wallet]").click();
    await top.locator("#wallet-name").fill("Existing wallet");
    await top.locator("#wallet-passphrase").fill("Existing wallet passphrase");
    await top
      .locator("#wallet-passphrase-confirm")
      .fill("Existing wallet passphrase");
    const downloaded = top.waitForEvent("download");
    await top.locator('#create-wallet-form button[type="submit"]').click();
    await downloaded;
    await top.locator(".key-id").first().waitFor();
    const topIdentity = await top.locator(".key-id").first().innerText();
    const host = await contextC.newPage();
    await host.goto(integrationSiteUrl);
    await host.locator("#connect").click();
    await host.locator('dialog iframe[title="AI Auth wallet"]').waitFor();
    const embedded = await (
      await host
        .locator('dialog iframe[title="AI Auth wallet"]')
        .elementHandle()
    ).contentFrame();
    await embedded
      .locator("#view")
      .getByText(/Create or restore your wallet|Review before you sign/)
      .waitFor({ timeout: 10000 });
    const cookieVisible = await embedded.evaluate(() =>
      document.cookie.includes("third_party_probe=allowed"),
    );
    console.log(
      `Cross-site cookie probe: ${cookieVisible ? "visible" : "blocked"}`,
    );
    const requiresSetup = await embedded.locator("[data-go-wallet]").count();
    console.log(
      `Cross-site existing wallet: ${requiresSetup ? "NOT visible (storage partitioned or blocked)" : "visible"}; top-level identity ${topIdentity.slice(0, 20)}...`,
    );
    if (requiresSetup)
      throw new Error(
        "Third-party wallet storage is partitioned or blocked: existing top-level identity is unavailable in the embedded wallet",
      );
    await embedded
      .locator('input[name="external-capability"][value="presence.read"]')
      .check();
    await embedded
      .locator('#external-permission-form button[type="submit"]')
      .click();
    await host.waitForFunction(() => window.__connected === true, undefined, {
      timeout: 30000,
    });
    const embeddedIdentity = await host.evaluate(
      () => window.__connection.consent.body.issuer,
    );
    assert.equal(
      embeddedIdentity,
      topIdentity,
      "embedded consent must use the existing top-level identity",
    );
    console.log(
      "Cross-site signed consent matches the top-level wallet identity.",
    );
  }
  console.log(
    "Browser E2E passed: two new wallets required consent; signed action, cursor, text and attachment crossed direct WebRTC; expired direct messages were rejected, attachment bytes were not persisted, and disconnect removed the modal.",
  );
} catch (error) {
  // A failure may happen before the normal evidence checkpoint. Capture the
  // real page when one is available, without concealing the test failure.
  try {
    if (evidencePage && !evidencePage.isClosed()) {
      const screenshots = resolve(root, "test-results/screenshots");
      await mkdir(screenshots, { recursive: true });
      await evidencePage.screenshot({
        path: resolve(screenshots, "generic-site-failure.png"),
        fullPage: true,
      });
    }
  } catch {
    // Browser/network failure can make screenshots impossible to capture.
  }
  throw error;
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
