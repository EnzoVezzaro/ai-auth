// End-to-end for the connect-agent page against the identity-UX audit contract:
// choose → copy instructions → wait → verify with a REAL signed proof → online.
// The agent runs from the keystore created by installAgentIdentity, joins the
// real Nostr/WebRTC room and answers the verifier's challenge with a fresh
// signature from the installed key (security worker's responder). P0-01 is
// asserted: an unexpected peer must never complete the pairing.
// No passphrase or full wallet id is ever placed in an assertion message or a
// screenshot — all identity material here is synthetic fixture material.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { webcrypto } from "node:crypto";
import { chromium } from "playwright";
import { startStaticServer, waitFor, expectStable } from "./e2e/helpers.mjs";
import {
  createWallet,
  bindInstance,
  createInstanceId,
} from "../packages/p2p/index.js";
import {
  installAgentIdentity,
  createFileKeystore,
  createAgentRuntime,
} from "../packages/agent/index.js";
import { createPairingResponder } from "../packages/agent/pairing.js";
import { signingIdentityFor } from "../packages/agent/keystore.js";

globalThis.crypto ??= webcrypto;

const root = resolve(import.meta.dirname, "..");
const CAPABILITIES = ["presence.read", "messages.send", "tools.invoke"];
const ROOM = "default";
// Synthetic fixture only: never a production secret, never in assert output.
const PASSPHRASE = "connect agent e2e passphrase 2026";
process.env.AI_AUTH_PASSPHRASE = PASSPHRASE;
const ROGUE_ISSUER = "agent:qa-unexpected-peer";
const REQUIRED_IDS = [
  "#connect",
  "#waiting",
  "#session",
  "#status-pill",
  "#status-text",
  "#agent-id",
  "#agent-name",
  "#expected-wallet",
  "#expected-instance",
  "#begin-verify",
  "#status-card",
  "#row-identity",
  "#row-access",
  "#row-connected",
];
const STATUS_ROWS = ["Identity verified", "Access approved", "Connected now"];

const server = await startStaticServer();
const dir = await mkdtemp(join(tmpdir(), "ai-auth-connect-agent-"));
let browser;
let runtime;
let responder;

const step = (name) => console.log(`STEP ${name}`);

function blocked(reasons) {
  return new Error(
    `BLOCKED: UX/security contract has not landed in this working tree. Missing:\n  - ${reasons.join("\n  - ")}`,
  );
}

try {
  step("browser-launch");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage({ acceptDownloads: true });

  // Record observable phase transitions so "verified before connected" is
  // proven rather than inferred from a single green screenshot. Only phase
  // names are stored — no ids, signatures or passphrases.
  await page.addInitScript(() => {
    window.__qaPhaseLog = [];
    window.__qaVerifiedLog = [];
    setInterval(() => {
      const state = window.__connectAgent;
      const phase = state?.phase;
      if (phase && window.__qaPhaseLog.at(-1) !== phase)
        window.__qaPhaseLog.push(phase);
      // Verification is a historical fact independent of transport liveness.
      // Record the first moment identity became verified, even if the live peer
      // arrived in the same tick, so "verified before online" is provable.
      if (
        state?.identityVerified === true &&
        window.__qaVerifiedLog.length === 0
      )
        window.__qaVerifiedLog.push({
          phase,
          online: state.online === true,
        });
    }, 25);
  });

  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.siteUrl}connect-agent/`);
  step("page-loaded");
  await waitFor(() => page.locator("#connect").isVisible(), {
    message: "connect CTA is visible",
  });

  // Contract preflight: stop with an exact reason rather than report a pass
  // against the old false-positive UI when the other workers have not landed.
  const missing = [];
  for (const id of REQUIRED_IDS)
    if ((await page.locator(id).count()) === 0) missing.push(`element ${id}`);
  const domText = await page.locator("body").textContent();
  for (const row of STATUS_ROWS)
    if (!domText.includes(row)) missing.push(`status card row "${row}"`);
  if (missing.length) throw blocked(missing);
  step("contract-preflight-ok");

  assert.equal(await page.locator("#agent-name-input").count(), 0);
  assert.equal(await page.locator("#share-block").count(), 0);
  assert.equal(await page.locator("#site-link").count(), 0);

  // Build an install package outside the browser, as an agent harness would.
  const agentWallet = await createWallet({
    name: "e2e-agent",
    passphrase: PASSPHRASE,
    persist: false,
  });
  const instanceId = createInstanceId();
  const binding = await bindInstance(agentWallet, instanceId);
  const installPackage = {
    format: "ai-auth-agent-install",
    version: 1,
    name: agentWallet.name,
    walletId: agentWallet.id,
    instanceId,
    binding,
    backup: agentWallet.backup,
    site: { origin: server.origin, room: ROOM, capabilities: CAPABILITIES },
  };
  await writeFile(
    join(dir, "ai-auth-agent-install.json"),
    JSON.stringify(installPackage, null, 2),
  );
  const keystoreDir = join(dir, "keystore");
  await installAgentIdentity({
    dir: keystoreDir,
    installPackage,
    passphrase: PASSPHRASE,
  });
  step("identity-installed");

  // One real headless agent: installed keystore, live transport and pairing
  // responder on the SAME room so it receives the verifier's one-shot challenge.
  const keystore = createFileKeystore({ dir: keystoreDir });
  const installedWallet = await keystore.unlock();
  runtime = createAgentRuntime({
    keystore,
    origin: server.origin,
    room: ROOM,
    capabilities: CAPABILITIES,
    descriptor: { name: "e2e-agent" },
  });
  responder = createPairingResponder({
    wallet: signingIdentityFor(installedWallet),
    instanceId,
    origin: server.origin,
    room: ROOM,
    siteRoom: runtime.agentRoom,
    capabilities: CAPABILITIES,
    provider: "e2e-self-reported",
    model: "e2e-self-reported",
  });
  await runtime.join();
  step("agent-joined");

  // The page binds verification to the expected public wallet/instance only.
  await page.locator("#expected-wallet").fill(agentWallet.id);
  await page.locator("#expected-instance").fill(instanceId);
  await page.locator("#connect").click();
  await waitFor(() => page.locator("#waiting").isVisible(), {
    message: "waiting state appears after copying",
  });
  step("instructions-copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /Origin: http:\/\//mu);
  assert.match(copied, /Room: default/u);
  assert.match(copied, /Capabilities:.*presence\.read/u);
  assert.match(copied, /--open-wallet/u);
  assert.match(copied, /--auto-join/u);
  assert.match(copied, /never paste private keys/iu);

  // P0-01 regression: peer B arriving while we wait for peer A must never
  // complete pairing A. Inject through the real room listener, no crypto mock.
  await waitFor(
    () => page.evaluate(() => Boolean(window.__connectAgentControls?.siteRoom)),
    { message: "site room exposed for peer injection" },
  );
  await page.evaluate((issuer) => {
    const room = window.__connectAgentControls.siteRoom;
    for (const type of ["peer/hello", "presence/heartbeat"])
      room.notify({
        direction: "in",
        envelope: {
          body: { type, issuer, payload: { label: "Unexpected agent" } },
        },
      });
  }, ROGUE_ISSUER);

  const unexpected = await expectStable(
    async () => ({
      phase: await page.evaluate(() => window.__connectAgent?.phase),
      pill: (await page.locator("#status-text").innerText()).trim(),
      identityVerified: await page.evaluate(
        () => window.__connectAgent?.identityVerified,
      ),
      online: await page.evaluate(() => window.__connectAgent?.online),
    }),
    {
      window: 1_500,
      message: "unexpected peer must not mark the agent connected",
    },
  );
  assert.notEqual(
    unexpected.phase,
    "connected",
    "P0-01 regression: an unexpected peer completed the pairing",
  );
  assert.notEqual(
    unexpected.pill,
    "CONNECTED NOW",
    "P0-01 regression: CONNECTED NOW shown for an unexpected peer",
  );
  assert.equal(
    unexpected.identityVerified,
    false,
    "unexpected peer was verified",
  );
  assert.equal(unexpected.online, false, "unexpected peer was marked online");
  step("unexpected-peer-refused");

  // Chapter 3: the verifier issues a fresh signed challenge on the real room.
  // The site owner (the page's own siteWallet) signs a narrow grant bound to
  // that exact challenge and adds it to the challenge payload. The private key
  // stays in the browser: only the signed envelope crosses the room boundary.
  // This is the owner-approval step of the harness: only the effective subset
  // is granted, so the page must never show tools.invoke as approved.
  await page.evaluate(() => {
    const controls = window.__connectAgentControls;
    const room = controls.siteRoom;
    const send = room.send.bind(room);
    room.send = async (type, payload = {}, extra = {}) => {
      if (type === "agent/pair-challenge" && payload.challenge?.body?.payload) {
        const c = payload.challenge.body.payload;
        const claim = {
          audience: c.origin,
          room: c.room,
          walletId: c.walletId,
          instanceId: c.instanceId,
          sessionId: c.sessionId,
          nonce: c.nonce,
          // Effective scopes the owner approves: a subset of the request.
          scopes: ["presence.read", "messages.send"],
          expiresAt: c.expiresAt,
        };
        const envelope = await controls.siteWallet.sign(
          "agent/access-grant",
          claim,
        );
        payload.grant = { ...claim, envelope };
      }
      return send(type, payload, extra);
    };
  });
  step("owner-grant-armed");
  await page.locator("#begin-verify").click();
  await waitFor(
    () => page.evaluate(() => window.__connectAgent?.phase === "verifying"),
    { message: "verification phase reached" },
  );
  assert.equal(await page.locator("#session").isVisible(), true);
  step("verification-started");

  await waitFor(
    () => page.evaluate(() => window.__connectAgent?.identityVerified === true),
    {
      timeout: 45_000,
      message: "a real signed proof verified the expected identity",
    },
  );
  step("real-proof-verified");
  assert.equal(
    (await page.locator("#identity-status").innerText()).trim(),
    "Verified",
  );
  assert.equal(
    await page.locator("#row-identity").getAttribute("data-level"),
    "ok",
  );
  // The page must not leak the full public id into the UI.
  const shownId = (await page.locator("#agent-id").innerText()).trim();
  assert.ok(shownId.length > 0, "connected agent id is shown");
  assert.equal(
    shownId.includes(agentWallet.id),
    false,
    "full wallet id must be masked in the UI, not shown verbatim",
  );

  // A live authenticated peer is required for "Connected now".
  await waitFor(
    () =>
      page.evaluate(
        () =>
          window.__connectAgent?.transportStatus === "direct-peer-connected",
      ),
    { timeout: 30_000, message: "live authenticated peer is present" },
  );
  step("live-peer-present");

  // Verification must be a distinct historical fact, observed before or at the
  // same moment online is asserted. The UI derives online from identityVerified
  // && accessApproved && live transport, so identity can never be absent when
  // "Connected now" appears. What must never happen is a connected state with
  // no verified identity behind it.
  const observed = await page.evaluate(() => ({
    phases: window.__qaPhaseLog ?? [],
    verified: window.__qaVerifiedLog ?? [],
    identityVerified: window.__connectAgent?.identityVerified === true,
    online: window.__connectAgent?.online === true,
  }));
  assert.ok(
    observed.identityVerified,
    `identity must be verified before online; observed: ${observed.phases.join(" -> ")}`,
  );
  assert.ok(
    observed.verified.length > 0,
    `verified identity was never observed; observed: ${observed.phases.join(" -> ")}`,
  );
  assert.ok(
    observed.online === false || observed.verified[0].phase !== "start",
    `online appeared without verification; observed: ${observed.phases.join(" -> ")}`,
  );

  // The owner-signed grant is now on the wire and the responder forwards it as
  // payload.authorization. Online must still stay false until the verifier
  // verifies that grant and surfaces it in claims — never a synthetic pass.
  step("awaiting-online-state");
  const awarded = await page
    .waitForFunction(
      () => window.__connectAgent?.phase === "connected",
      undefined,
      {
        timeout: 15_000,
      },
    )
    .then(
      () => true,
      () => false,
    );
  assert.equal(
    awarded,
    true,
    "Connected now was not reached: no verified authorization claim reached the UI. The owner-signed grant travels in the challenge and the responder forwards it as payload.authorization; apps/connect-agent/pairing.js must verify it and copy it into claims.authorization before online can be asserted.",
  );

  assert.equal(
    (await page.locator("#status-text").innerText()).trim(),
    "CONNECTED NOW",
  );
  assert.equal(await page.locator("#waiting").isVisible(), false);
  assert.equal(await page.locator("#session").isVisible(), true);
  assert.equal(
    (await page.locator("#connected-status").innerText()).trim(),
    "Online now",
  );
  assert.equal(
    (await page.locator("#access-status").innerText()).trim(),
    "Approved for this site",
  );
  const granted = await page.locator("#capabilities").innerText();
  assert.match(granted, /presence\.read/u);
  assert.doesNotMatch(
    granted,
    /tools\.invoke/u,
    "requested scope was shown as approved",
  );
  assert.deepEqual(errors, []);

  // Live revocation: the owner signs a revocation of the exact accepted grant
  // and publishes it on the same room. A tampered copy must NOT revoke; the real
  // one must clear "Connected now" while "Identity verified" stays historical.
  step("live-revocation-armed");
  const signed = await page.evaluate(async () => {
    const controls = window.__connectAgentControls;
    const state = window.__connectAgent;
    const authorization = state.proof?.claims?.authorization;
    if (!authorization) return { error: "no accepted authorization to revoke" };
    const claim = {
      id: crypto.randomUUID(),
      audience: authorization.audience,
      room: authorization.room,
      walletId: authorization.walletId,
      instanceId: authorization.instanceId,
      sessionId: authorization.sessionId,
      nonce: authorization.nonce,
      expiresAt: Date.now() + 60_000,
      reason: "e2e live revocation",
    };
    const envelope = await controls.siteWallet.sign(
      "agent/access-grant-revocation",
      claim,
    );
    const tampered = structuredClone(envelope);
    tampered.body.payload.nonce = "nonce-tampered-0123456789";
    return { envelope, tampered };
  });
  assert.equal(signed.error, undefined, signed.error);
  assert.ok(signed.envelope?.body?.payload?.id, "revocation id missing");

  await page.evaluate((tampered) => {
    window.__connectAgentControls.siteRoom.notify({
      direction: "in",
      envelope: tampered,
      peer: { id: tampered.body.issuer },
    });
  }, signed.tampered);
  const afterTampered = await expectStable(
    async () => ({
      phase: await page.evaluate(() => window.__connectAgent?.phase),
      online: await page.evaluate(() => window.__connectAgent?.online),
      revoked: await page.evaluate(() => window.__connectAgent?.revoked),
    }),
    { window: 1_000, message: "tampered revocation must be ignored" },
  );
  assert.equal(
    afterTampered.phase,
    "connected",
    "a tampered revocation wrongly revoked the grant",
  );
  assert.equal(afterTampered.online, true);
  assert.equal(afterTampered.revoked, false);
  step("tampered-revocation-ignored");

  await page.evaluate((envelope) => {
    window.__connectAgentControls.siteRoom.notify({
      direction: "in",
      envelope,
      peer: { id: envelope.body.issuer },
    });
  }, signed.envelope);
  await waitFor(
    () => page.evaluate(() => window.__connectAgent?.phase === "revoked"),
    { timeout: 5_000, message: "UI moved to Access revoked" },
  );
  const revoked = await page.evaluate(() => ({
    phase: window.__connectAgent?.phase,
    online: window.__connectAgent?.online,
    accessApproved: window.__connectAgent?.accessApproved,
    identityVerified: window.__connectAgent?.identityVerified,
    revoked: window.__connectAgent?.revoked,
  }));
  assert.equal(revoked.online, false, "revocation left the UI green");
  assert.equal(revoked.accessApproved, false, "grant was still approved");
  assert.equal(revoked.revoked, true);
  assert.equal(
    revoked.identityVerified,
    true,
    "revocation erased the historical identity verification",
  );
  assert.equal(
    (await page.locator("#status-text").innerText()).trim(),
    "ACCESS REVOKED",
  );
  assert.equal(
    (await page.locator("#connected-status").innerText()).trim(),
    "Access revoked",
  );
  assert.equal(
    (await page.locator("#access-status").innerText()).trim(),
    "Revoked",
  );
  assert.match(await page.locator("#action-hint").innerText(), /Re-approve/u);
  step("owner-revocation-applied");

  // Replay of the same signed revocation must be a no-op (no error state).
  await page.evaluate((envelope) => {
    window.__connectAgentControls.siteRoom.notify({
      direction: "in",
      envelope,
      peer: { id: envelope.body.issuer },
    });
  }, signed.envelope);
  const afterReplay = await expectStable(
    async () => ({
      phase: await page.evaluate(() => window.__connectAgent?.phase),
      error: await page.evaluate(() => window.__connectAgent?.error ?? ""),
    }),
    { window: 1_000, message: "revocation replay must be a no-op" },
  );
  assert.equal(afterReplay.phase, "revoked");
  assert.equal(afterReplay.error, "");
  assert.deepEqual(errors, []);
  step("revocation-replay-ignored");

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
    "PASS connect-agent E2E: instructions copied, unexpected peer refused, real signed proof verified, live peer present, Connected shown with granted scopes only, and an owner-signed revocation cleared online while preserving identity verification.",
  );
} catch (error) {
  const message = error?.message ?? String(error);
  console.error(
    message.startsWith("BLOCKED:") ? message : `E2E_FAIL ${message}`,
  );
  process.exitCode = 1;
} finally {
  responder?.close?.();
  await runtime?.close?.().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await server.stop?.();
  server.child?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
