// E2E for the EXTERNAL wallet integration on /host-site/.
//
// This is deliberately NOT the apps/connect-agent identity-setup flow. It
// drives the real in-page wallet modal from `connectAIAuthModal`, has the owner
// approve an explicit subset, and verifies the site renders only signed consent
// data. A real headless agent (own keystore, real Nostr + WebRTC) then joins
// "host-demo" as the owner-authorised agent and sends a signed message/text.
//
// No wallet/signature mocks. No passphrase, full wallet id or full agent id is
// ever written to stdout, an assertion message, or a report artifact — only
// masked fragments are compared.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  expectStable,
  launchBrowser,
  root,
  startStaticServer,
  waitFor,
} from "./e2e/helpers.mjs";
import { HeadlessAgent, newContext } from "./e2e/participants.mjs";
import { createReport } from "./e2e/report.mjs";
import { createSiteAuthority } from "./e2e/site-authority.mjs";
import {
  createAgentRuntime,
  createFileKeystore,
} from "../packages/agent/index.js";
import { createParticipationPolicy } from "../packages/p2p/index.js";

const ROOM = "host-demo";
const APPROVED = ["presence.read", "messages.send"];
const FORBIDDEN = "tools.invoke";
// Synthetic harness fixture, not a production secret. Never printed.
const PASSPHRASE = "host site e2e passphrase 2026";
process.env.AI_AUTH_PASSPHRASE = PASSPHRASE;
const OWNER_NAME = "host-site-owner";
const RUN_LIMIT_MS = 8 * 60_000;

const report = createReport();
const short = (id) =>
  typeof id === "string" && id.length > 8 ? id.slice(0, 8) : "unknown";

let server;
let browser;
let contexts = [];
let site;
let authority;
let agent;
let rogue;
let exitCode = 0;

const step = async (n, name, fn) => {
  console.log(`STEP ${n}. ${name}`);
  return report.step(n, name, (evidence) => fn(evidence));
};

function block(reasons) {
  return new Error(
    `BLOCKED: host-site contract has not landed in this working tree.\n  - ${reasons.join("\n  - ")}`,
  );
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function preflight() {
  const missing = [];
  for (const file of ["index.html", "site.js", "site.css"]) {
    if (!(await exists(resolve(root, "examples", "host-site", file))))
      missing.push(
        `examples/host-site/${file} does not exist (site worker has not landed it)`,
      );
  }
  if (missing.length) throw block(missing);
}

async function writeArtifact(extra = {}) {
  const dir = resolve(root, "test-results");
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "host-site-e2e-report.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        room: ROOM,
        approvedScopes: APPROVED,
        ...extra,
        steps: [...report.rows].sort((a, b) => a.step - b.step),
      },
      null,
      2,
    ),
  );
}

/**
 * A real headless agent: its own encrypted keystore, real Nostr signaling and
 * real WebRTC. The participation policy stays in "open" mode (matching the
 * host site's open room) while still being bound to the owner's authority and
 * carrying a signed membership — a restricted room would drop chat addressed
 * to the wallet, which is not a member of the agent's policy.
 */
async function startAgent({ authority, name, scopes }) {
  const dir = await mkdtemp(pathJoin(tmpdir(), "host-site-agent-"));
  const keystore = createFileKeystore({ dir });
  if (!(await keystore.exists())) await keystore.create({ name });
  const wallet = await keystore.unlock();
  const membership = await authority.admit(wallet.id, scopes);
  const policy = createParticipationPolicy({
    mode: "open",
    trustPolicy: { issuers: [authority.issuerJwk] },
    origin: server.origin,
    room: ROOM,
  });
  const runtime = createAgentRuntime({
    keystore,
    origin: server.origin,
    room: ROOM,
    capabilities: APPROVED,
    descriptor: { name },
    participation: { policy, membership },
  });
  try {
    await runtime.join();
  } catch (error) {
    throw new Error(
      `agent join failed (${name}): ${error?.cause?.message ?? error?.message ?? error}`,
      { cause: error },
    );
  }
  return { id: wallet.id, runtime, dir, membership };
}

async function closeAgent(handle) {
  if (!handle) return;
  try {
    await handle.runtime.close();
  } catch {
    // Already gone.
  }
  await rm(handle.dir, { recursive: true, force: true }).catch(() => {});
}

async function cleanup() {
  for (const c of contexts) await c.close().catch(() => {});
  await closeAgent(agent);
  await rogue?.stop().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop();
}

// Reads only masked/derived state from the page; never returns a full id.
const pageView = (page) =>
  page.evaluate(() => {
    const hs = window.__hostSite;
    const text = (sel) =>
      document.querySelector(sel)?.textContent?.trim() ?? "";
    const full = hs?.connection?.identity?.id;
    return {
      hook: Boolean(hs),
      phase: hs?.state?.phase ?? null,
      status: text("#status"),
      scopes: text("#scopes"),
      scopeChips: [...document.querySelectorAll("#scopes .scope")].map((n) =>
        n.textContent.trim(),
      ),
      peers: text("#peers"),
      peerCodes: [...document.querySelectorAll("#peers li code")].map((n) =>
        n.textContent.trim(),
      ),
      events: text("#events"),
      eventTypes: [...document.querySelectorAll("#events li code")].map((n) =>
        n.textContent.trim(),
      ),
      effective: [...(hs?.state?.effectiveCapabilities ?? [])],
      connectionCaps: [...(hs?.connection?.capabilities ?? [])],
      stateScopes: [...(hs?.state?.effectiveCapabilities ?? [])],
      peerKeys: [...(hs?.state?.peers?.keys?.() ?? [])],
      eventLog: (hs?.state?.events ?? []).map((e) => ({
        type: e.type,
        issuer: e.issuer,
      })),
      request: hs?.connection?.request
        ? {
            audience: hs.connection.request.audience,
            room: hs.connection.request.room,
            capabilities: [...hs.connection.request.capabilities],
          }
        : null,
      maskLeaked:
        typeof full === "string" && full.length > 0
          ? text("#status").includes(full)
          : false,
    };
  });

const waitForPhase = (phase, timeout = 30_000) =>
  waitFor(async () => (await pageView(site)).phase === phase, {
    timeout,
    message: `host site phase to become ${phase}`,
  });

const connectDisabled = () => site.locator("#connect").isDisabled();

async function driveWalletModal() {
  // Mirrors the proven helper's flow but waits on the host-site hook, which
  // deliberately does not set window.__connected.
  await site.locator("#connect").click();
  await site.locator('dialog iframe[title="AI Auth wallet"]').waitFor();
  const handle = await site
    .locator('dialog iframe[title="AI Auth wallet"]')
    .elementHandle();
  const wallet = await handle.contentFrame();
  assert.ok(wallet, "real in-page wallet iframe exists");

  await wallet.waitForFunction(
    () =>
      document
        .querySelector("#view")
        ?.innerText.includes("Requested permissions"),
    undefined,
    { timeout: 15_000 },
  );

  // First run: the wallet creates the owner identity inline in this request.
  if (await wallet.locator("[data-go-wallet]").count())
    await wallet.locator("[data-go-wallet]").click();
  let created = false;
  if (await wallet.locator("#create-wallet-form").count()) {
    await wallet.locator("#wallet-name").fill(OWNER_NAME);
    await wallet.locator("#wallet-passphrase").fill(PASSPHRASE);
    await wallet.locator("#wallet-passphrase-confirm").fill(PASSPHRASE);
    assert.equal(
      (await pageView(site)).phase,
      "connecting",
      "site waits during approval",
    );
    const download = site.waitForEvent("download");
    await wallet.locator('#create-wallet-form button[type="submit"]').click();
    await download; // the encrypted recovery file, never read or logged
    created = true;
  }

  try {
    await wallet
      .locator("#external-permission-form")
      .waitFor({ timeout: 30_000 });
  } catch (error) {
    const view = await wallet.locator("#view").innerText();
    throw new Error(
      `Wallet did not show the external permission form. View: ${view}`,
      { cause: error },
    );
  }

  const requested = await wallet
    .locator('#external-permission-form input[name="external-capability"]')
    .evaluateAll((nodes) => nodes.map((n) => n.value));
  assert.ok(
    requested.includes("presence.read") && requested.includes("messages.send"),
    "wallet shows the site's requested presence/message scopes",
  );
  assert.ok(!requested.includes(FORBIDDEN), "site never requests tools.invoke");
  const view = await wallet.locator("#view").innerText();
  assert.ok(
    view.includes(server.origin),
    "wallet dialog shows the requesting origin",
  );

  for (const capability of requested) {
    const box = wallet.locator(
      `#external-permission-form input[name="external-capability"][value="${capability}"]`,
    );
    await box.setChecked(APPROVED.includes(capability));
  }
  return { wallet, requested, created };
}

const limit = setTimeout(async () => {
  console.error(`Whole-run timeout of ${RUN_LIMIT_MS / 1000}s exceeded`);
  report.rows.push({
    step: 99,
    name: "whole-run timeout",
    status: "FAIL",
    durationMs: RUN_LIMIT_MS,
    note: "exceeded whole-run limit",
    evidence: {},
  });
  await writeArtifact({ aborted: true });
  await cleanup();
  process.exit(1);
}, RUN_LIMIT_MS);
limit.unref();

try {
  await preflight();

  server = await startStaticServer();
  const hostPageUrl = `${server.siteUrl}host-site/`;
  const pageResponse = await fetch(hostPageUrl);
  if (!pageResponse.ok) {
    throw block([
      `GET ${hostPageUrl} returned ${pageResponse.status} — build-p2p-static.mjs does not publish /host-site/`,
    ]);
  }
  const html = await pageResponse.text();
  for (const id of ["connect", "status", "scopes", "peers", "events"]) {
    if (!html.includes(`id="${id}"`))
      throw block([`host-site/index.html is missing #${id}`]);
  }
  const scriptResponse = await fetch(`${server.siteUrl}host-site/site.js`);
  if (!scriptResponse.ok)
    throw block([`GET /host-site/site.js returned ${scriptResponse.status}`]);

  browser = await launchBrowser();
  const context = await newContext(browser);
  contexts.push(context);
  site = await context.newPage();
  const pageErrors = [];
  site.on("pageerror", (error) => pageErrors.push(error.message));
  site.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await step(
    1,
    "host-site contract is served and inspectable",
    async (evidence) => {
      await site.goto(hostPageUrl);
      await waitFor(() => site.locator("#connect").isVisible(), {
        message: "#connect is visible",
      });
      const view = await pageView(site);
      assert.equal(view.hook, true, "window.__hostSite inspection hook exists");
      assert.equal(view.phase, "idle");
      evidence.route = "/host-site/";
      evidence.roomContract = ROOM;
    },
  );

  await step(
    2,
    "initial UI shows no false connected state",
    async (evidence) => {
      const view = await pageView(site);
      assert.match(view.status, /Not connected/u);
      assert.equal(view.scopeChips.length, 0, "no scopes before approval");
      assert.equal(view.peerCodes.length, 0, "no peers before approval");
      assert.equal(view.eventTypes.length, 0, "no events before approval");
      assert.equal(await connectDisabled(), false, "Connect is enabled");
      evidence.initialStatus = view.status;
    },
  );

  let wallet;
  await step(
    3,
    "Connect opens the real wallet modal with origin and requested scopes",
    async (evidence) => {
      const driven = await driveWalletModal();
      wallet = driven.wallet;
      evidence.walletCreatedInline = driven.created;
      evidence.requestedScopes = driven.requested;
      evidence.modalIsInPageDialog =
        (await site.locator("dialog[open]").count()) > 0;
    },
  );

  await step(
    4,
    "Owner approves subset: Connected, effective scopes only, masked id",
    async (evidence) => {
      let view = await pageView(site);
      assert.equal(
        view.phase,
        "connecting",
        "site waits while approval is pending",
      );
      assert.equal(
        await connectDisabled(),
        true,
        "Connect is disabled while approval is pending",
      );

      await wallet
        .locator('#external-permission-form button[type="submit"]')
        .click();
      await waitForPhase("connected");
      view = await pageView(site);

      assert.match(view.status, /^Connected/u, "status shows Connected");
      assert.equal(view.maskLeaked, false, "full wallet id is never rendered");
      assert.match(
        view.status,
        /…/u,
        "status contains a masked wallet id fragment",
      );

      assert.deepEqual([...view.effective].sort(), [...APPROVED].sort());
      assert.deepEqual([...view.connectionCaps].sort(), [...APPROVED].sort());
      assert.deepEqual([...view.scopeChips].sort(), [...APPROVED].sort());
      assert.ok(
        !view.scopeChips.includes(FORBIDDEN),
        "tools.invoke is never shown",
      );
      assert.ok(
        !view.scopes.includes(FORBIDDEN),
        "tools.invoke is absent from #scopes",
      );
      assert.equal(
        view.request?.audience,
        server.origin,
        "consent audience is this site",
      );
      assert.equal(view.request?.room, ROOM, "consent room is host-demo");
      assert.equal(
        await connectDisabled(),
        true,
        "Connect is disabled while connected",
      );
      assert.equal(
        await site.locator("#disconnect").isDisabled(),
        false,
        "Disconnect is enabled",
      );
      evidence.statusShape = view.status.replace(/[A-Za-z0-9]/gu, "x");
      evidence.effectiveScopes = view.effective;
      evidence.room = view.request?.room;
    },
  );

  const agentShort = () => short(agent?.id ?? "unknown");

  await step(
    5,
    "Owner-authorised headless agent joins host-demo: verified peer + signed message",
    async (evidence) => {
      authority = await createSiteAuthority({
        origin: server.origin,
        room: ROOM,
      });
      agent = await startAgent({
        authority,
        name: "owner-agent",
        scopes: APPROVED,
      });
      const expected = short(agent.id);
      await waitFor(
        async () =>
          (await pageView(site)).peerCodes.some((code) =>
            code.startsWith(expected),
          ),
        {
          timeout: 90_000,
          message: "owner agent to appear as a masked verified peer",
        },
      );
      let view = await pageView(site);
      assert.ok(
        view.peerKeys.some((key) => key.startsWith(expected)),
        "agent appears in the site's presence state",
      );
      assert.ok(
        view.peerCodes.every((code) => code.includes("…")),
        "peer ids are masked",
      );

      await waitFor(
        async () => (agent.runtime.connectionState.directPeerCount ?? 0) >= 1,
        {
          timeout: 90_000,
          message: "agent to establish a direct data channel",
        },
      );

      const marker = `host-site signed message ${Date.now()}`;
      await agent.runtime.send("message/text", { text: marker });
      await waitFor(
        async () => {
          const v = await pageView(site);
          return (
            v.eventTypes.includes("message/text") &&
            v.eventLog.some(
              (e) =>
                e.type === "message/text" && e.issuer?.startsWith(expected),
            )
          );
        },
        {
          timeout: 90_000,
          message: "agent's signed message/text to reach #events",
        },
      );
      view = await pageView(site);
      assert.ok(
        !view.events.includes(FORBIDDEN),
        "no tools.invoke event was accepted",
      );
      evidence.agentPeerMask = `${expected.slice(0, 6)}…`;
      evidence.agentDirectPeers = agent.runtime.connectionState.directPeerCount;
      evidence.eventTypes = view.eventTypes;
      evidence.ownerAuthorityIssuedMembership = true;
    },
  );

  await step(
    6,
    "Negative: an uninvited identity cannot change site status or scopes",
    async (evidence) => {
      const rogueAuthority = await createSiteAuthority({
        origin: server.origin,
        room: ROOM,
      });
      // A separate process is required: the Nostr/Trystero transport only joins
      // one room per app id per process. Restricted mode still broadcasts signed
      // presence, which is all this negative check needs.
      rogue = new HeadlessAgent({
        origin: server.origin,
        room: ROOM,
        issuer: rogueAuthority.issuerJwk,
        name: "uninvited-agent",
      });
      const rogueId = await rogue.start();
      const rogueMembership = await rogueAuthority.admit(rogueId, [FORBIDDEN]);
      await rogue.cmd("join", { membership: rogueMembership });

      const before = await pageView(site);
      await expectStable(
        async () => {
          const v = await pageView(site);
          return {
            status: v.status,
            scopes: v.scopeChips,
            effective: v.effective,
            phase: v.phase,
          };
        },
        {
          window: 2_000,
          message: "uninvited agent must not change status/scopes",
        },
      );
      const after = await pageView(site);
      assert.equal(
        after.phase,
        "connected",
        "site connection stays the owner's",
      );
      assert.deepEqual(
        after.scopeChips,
        before.scopeChips,
        "uninvited scopes never appear",
      );
      assert.ok(
        !after.scopeChips.includes(FORBIDDEN),
        "forged tools.invoke is never granted",
      );
      assert.ok(
        !after.eventTypes.includes(FORBIDDEN),
        "forged tool event is never shown",
      );
      evidence.rogueMask = `${short(rogue.id).slice(0, 6)}…`;
      evidence.siteStatusUnchanged = after.status === before.status;
      // The room is intentionally open (no participation policy configured on the
      // site); a peer row is not an authorization claim. Recorded as a risk, not
      // asserted as a pass.
      evidence.openRoomNote =
        "peer list reflects signed presence, not site authorization";
      await rogue.stop();
      rogue = null;
    },
  );

  await step(
    7,
    "Agent offline removes its peer; Disconnect clears any green state",
    async (evidence) => {
      assert.ok(agent, "authorised agent exists from step 5");
      const expected = agentShort();
      await closeAgent(agent);
      agent = null;
      await waitFor(
        async () =>
          !(await pageView(site)).peerCodes.some((code) =>
            code.startsWith(expected),
          ),
        { timeout: 60_000, message: "offline agent to leave the peer list" },
      );
      await expectStable(async () => (await pageView(site)).peerCodes, {
        window: 1_000,
        message: "offline agent must not reappear",
      });
      let view = await pageView(site);
      assert.equal(
        view.phase,
        "connected",
        "owner's own connection remains valid",
      );
      assert.ok(
        !view.peerCodes.some((code) => code.startsWith(expected)),
        "no false green peer for the offline agent",
      );

      await site.locator("#disconnect").click();
      await waitForPhase("disconnected");
      view = await pageView(site);
      assert.match(
        view.status,
        /^Disconnected/u,
        "status is Disconnected after disconnect",
      );
      assert.ok(
        !/^Connected/u.test(view.status),
        "no green Connected state lingers",
      );
      assert.equal(view.scopeChips.length, 0, "scopes cleared");
      assert.equal(view.peerCodes.length, 0, "peers cleared");
      assert.equal(
        await connectDisabled(),
        false,
        "Connect is available again",
      );
      evidence.finalStatus = view.status;
      evidence.pageErrors = pageErrors.slice(0, 5);
    },
  );

  console.log(report.summary());
  const passed = report.rows.every((row) => row.status === "PASS");
  console.log(
    `RESULT ${passed ? "PASS" : "FAIL"} — ${report.rows.filter((r) => r.status === "PASS").length}/${report.rows.length} steps passed`,
  );
  await writeArtifact({ exitCode: passed ? 0 : 1 });
  exitCode = passed ? 0 : 1;
} catch (error) {
  const raw = String(error?.stack ?? error);
  const isBlocked = raw.includes("BLOCKED:");
  const status = isBlocked ? "BLOCKED" : "FAIL";
  console.log(
    `[${status}] harness setup\n        ${raw.split("\n").slice(0, 8).join("\n        ")}`,
  );
  report.rows.push({
    step: 0,
    name: isBlocked ? "BLOCKED: host-site contract" : "harness setup",
    status,
    durationMs: 0,
    note: raw.split("\n").slice(0, 8).join("\n        "),
    evidence: {},
  });
  console.log(report.summary());
  console.log(`RESULT ${status}`);
  await writeArtifact({ exitCode: isBlocked ? 2 : 1 }).catch(() => {});
  exitCode = isBlocked ? 2 : 1;
} finally {
  clearTimeout(limit);
  await delay(0);
  await cleanup();
}

process.exit(exitCode);
