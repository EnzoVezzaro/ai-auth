import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const workerDir = resolve(root, "apps/worker");
const wranglerBin = resolve(workerDir, "node_modules/.bin/wrangler");
const stateDir = await mkdtemp(resolve(tmpdir(), "ai-auth-worker-e2e-"));
const childProcesses = [];
let browser;

async function freePort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

function startProcess(name, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-12_000);
    });
  }
  childProcesses.push({
    name,
    child,
    get output() {
      return output;
    },
  });
  return child;
}

async function waitForHttp(url, child, description) {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${description} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const processInfo = childProcesses.find((item) => item.child === child);
  throw new Error(
    `${description} did not become ready: ${lastError?.message ?? "process exited"}\n${processInfo?.output ?? ""}`,
  );
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(1_000)]);
  }
}

async function runBrowserFlow(appOrigin, serviceOrigin) {
  const page = await browser.newPage();
  await page.goto(appOrigin);
  try {
    return await page.evaluate(
      async ({ appOrigin, serviceOrigin }) => {
        const [{ identityFor, signEnvelope }, { createServiceClient }] =
          await Promise.all([
            import(`${appOrigin}/packages/p2p/index.js`),
            import(`${appOrigin}/packages/p2p/service.js`),
          ]);

        async function createWallet() {
          const pair = await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
          );
          const publicKey = await crypto.subtle.exportKey(
            "jwk",
            pair.publicKey,
          );
          const id = await identityFor(publicKey);
          const wallet = {
            id,
            publicKey,
            privateKey: pair.privateKey,
            sign(type, payload) {
              return signEnvelope(wallet, type, payload);
            },
          };
          return wallet;
        }

        function eventCollector() {
          const events = [];
          return {
            events,
            waitFor(predicate, label) {
              const existing = events.find(predicate);
              if (existing) return Promise.resolve(existing);
              return new Promise((resolve, reject) => {
                let interval;
                const timeout = setTimeout(() => {
                  clearInterval(interval);
                  reject(new Error(`Timed out waiting for ${label}`));
                }, 10_000);
                interval = setInterval(() => {
                  const found = events.find(predicate);
                  if (!found) return;
                  clearTimeout(timeout);
                  clearInterval(interval);
                  resolve(found);
                }, 20);
              });
            },
            onEvent(event) {
              events.push(event);
            },
          };
        }

        const owner = await createWallet();
        const guest = await createWallet();
        const ownerCapabilities = [
          "tenant.create",
          "tenant.invite",
          "messages.read",
          "messages.write",
          "presence.read",
          "presence.publish",
        ];
        const guestCapabilities = [
          "tenant.join",
          "messages.read",
          "messages.write",
          "presence.read",
          "presence.publish",
        ];
        const client = createServiceClient({
          baseUrl: serviceOrigin,
          audience: appOrigin,
        });
        const ownerSession = await client.authenticate(
          owner,
          ownerCapabilities,
          ownerCapabilities,
        );
        const created = await client.createTenant(
          ownerSession,
          "Browser service E2E",
        );
        const tenantId = created.tenant.tenantId;
        const guestSession = await client.authenticate(
          guest,
          guestCapabilities,
          guestCapabilities,
        );
        const invitation = await client.createInvitation(ownerSession, owner, {
          tenantId,
          recipient: guest.id,
          capabilities: guestCapabilities,
          expiresAt: Date.now() + 60_000,
        });
        await client.joinTenant(guestSession, tenantId, invitation);

        const ownerEvents = eventCollector();
        const guestEvents = eventCollector();
        const ownerPresence = client.connectPresenceResilient(
          ownerSession,
          tenantId,
          "browser-e2e",
          ownerEvents.onEvent,
        );
        const guestPresence = client.connectPresenceResilient(
          guestSession,
          tenantId,
          "browser-e2e",
          guestEvents.onEvent,
        );

        try {
          await Promise.all([
            ownerEvents.waitFor(
              (event) => event.type === "session.authenticated",
              "owner WebSocket authentication",
            ),
            guestEvents.waitFor(
              (event) => event.type === "session.authenticated",
              "guest WebSocket authentication",
            ),
            guestEvents.waitFor(
              (event) =>
                event.type === "presence.snapshot" &&
                event.peers.some((peer) => peer.id === owner.id),
              "owner in guest presence snapshot",
            ),
            ownerEvents.waitFor(
              (event) =>
                event.type === "presence.joined" && event.agent.id === guest.id,
              "guest presence announcement",
            ),
          ]);

          if (!ownerPresence.sendPresence("busy"))
            throw new Error("Owner presence update was not sent");
          const updatedPresence = await guestEvents.waitFor(
            (event) =>
              event.type === "presence.updated" &&
              event.agent.id === owner.id &&
              event.status === "busy",
            "signed owner presence update",
          );

          if (!guestPresence.sendMessage("authenticated browser message"))
            throw new Error("Guest message was not sent");
          const deliveredMessage = await ownerEvents.waitFor(
            (event) =>
              event.type === "message.created" &&
              event.message.body === "authenticated browser message",
            "shared browser message delivery",
          );
          const history = await client.listMessages(
            ownerSession,
            tenantId,
            "browser-e2e",
          );
          if (
            history.messages.length !== 1 ||
            history.messages[0].body !== deliveredMessage.message.body
          )
            throw new Error("Durable message history did not match delivery");

          return {
            ownerId: owner.id,
            guestId: guest.id,
            tenantId,
            ownerSawGuest: ownerEvents.events.some(
              (event) =>
                event.type === "presence.joined" && event.agent.id === guest.id,
            ),
            guestSawOwner: guestEvents.events.some(
              (event) =>
                event.type === "presence.snapshot" &&
                event.peers.some((peer) => peer.id === owner.id),
            ),
            ownerPresenceStatus: updatedPresence.status,
            deliveredBody: deliveredMessage.message.body,
            storedMessageCount: history.messages.length,
          };
        } finally {
          ownerPresence.close();
          guestPresence.close();
        }
      },
      { appOrigin, serviceOrigin },
    );
  } finally {
    await page.close();
  }
}

const appPort = await freePort();
const workerPort = await freePort();
const appOrigin = `http://127.0.0.1:${appPort}`;
const serviceOrigin = `http://127.0.0.1:${workerPort}`;
const appServer = startProcess(
  "static wallet",
  process.execPath,
  [resolve(root, "scripts/serve.mjs")],
  { cwd: root, env: { PATH: process.env.PATH, PORT: String(appPort) } },
);
const workerServer = startProcess(
  "local Worker",
  process.execPath,
  [
    wranglerBin,
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(workerPort),
    "--persist-to",
    stateDir,
    "--var",
    `ALLOWED_ORIGINS:${appOrigin}`,
  ],
  {
    cwd: workerDir,
    env: {
      PATH: process.env.PATH,
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      WRANGLER_SEND_METRICS: "false",
    },
  },
);

try {
  await Promise.all([
    waitForHttp(`${appOrigin}/`, appServer, "static wallet"),
    waitForHttp(`${serviceOrigin}/v1/health`, workerServer, "local Worker"),
  ]);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AI_AUTH_CHROME_PATH
      ? { executablePath: process.env.AI_AUTH_CHROME_PATH }
      : {}),
  });
  const result = await runBrowserFlow(appOrigin, serviceOrigin);
  assert.notEqual(result.ownerId, result.guestId);
  assert.equal(result.ownerSawGuest, true);
  assert.equal(result.guestSawOwner, true);
  assert.equal(result.ownerPresenceStatus, "busy");
  assert.equal(result.deliveredBody, "authenticated browser message");
  assert.equal(result.storedMessageCount, 1);
  console.log(
    "Browser-to-Worker service E2E passed (wallet sessions, tenant invitation, presence, shared messaging, and durable history).",
  );
} finally {
  await browser?.close();
  await Promise.all(childProcesses.map((item) => stopProcess(item.child)));
  await rm(stateDir, { recursive: true, force: true });
}
