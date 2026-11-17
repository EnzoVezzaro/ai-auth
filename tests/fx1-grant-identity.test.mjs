// FX1 session identity: after a renewal the wallet must keep addressing the
// grant store under the stable session id (state.externalRequest.nonce), and
// markEnded must never invent a record for an id that was never saved.
import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  approvePermissionRequest,
  createInstanceId,
  createPermissionRequest,
  identityFor,
  signEnvelope,
} from "../packages/p2p/index.js";
import {
  createGrantStore,
  memoryGrantAdapter,
} from "../packages/p2p/grant-store.js";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const ROOM = "research";
const CAPS = ["presence.read", "messages.send"];

async function waitFor(condition, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail("condition not met before the deadline");
}

async function makeWallet() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const wallet = { id, name: "Agent", publicKey, privateKey: pair.privateKey };
  return {
    ...wallet,
    sign: (type, payload) => signEnvelope(wallet, type, payload),
  };
}

const agent = () => ({
  instanceId: createInstanceId(),
  agentType: "coding-agent",
  runtime: { name: "node", version: "22" },
});

async function originalGrant(wallet) {
  const request = await createPermissionRequest(ORIGIN, CAPS, {
    room: ROOM,
    expiresInMs: 120_000,
    sessionTtlMs: 30 * 60_000,
    idleTimeoutMs: 10 * 60_000,
  });
  return approvePermissionRequest(wallet, request, CAPS, { agent: agent() });
}

async function renewal(wallet, previous) {
  const request = await createPermissionRequest(ORIGIN, CAPS, {
    room: ROOM,
    expiresInMs: 120_000,
    sessionTtlMs: 30 * 60_000,
    idleTimeoutMs: 10 * 60_000,
    renews: previous.body.payload.requestNonce,
  });
  return approvePermissionRequest(wallet, request, ["presence.read"], {
    previousConsent: previous,
    agent: agent(),
  });
}

test("FX1-01 markEnded only updates an existing record, never creating a stray one", async () => {
  const backing = new Map();
  const store = createGrantStore({
    adapter: memoryGrantAdapter({ backing }),
  });
  assert.equal(await store.markEnded(ORIGIN, "never-saved"), false);
  assert.equal(backing.size, 0, "no phantom record is created");
  assert.equal(await store.get(ORIGIN, "never-saved"), null);
});

test("FX1-01 touch and end keep the stable session id after a renewal", async () => {
  const source = await appSource();
  const wallet = await makeWallet();
  const original = await originalGrant(wallet);
  const sessionId = original.body.payload.requestNonce;
  const narrowed = await renewal(wallet, original);
  assert.notEqual(narrowed.body.payload.requestNonce, sessionId);

  let clock = 1000;
  const backing = new Map();
  const grantStore = createGrantStore({
    adapter: memoryGrantAdapter({ backing }),
    now: () => clock,
  });
  // Renewal saved the narrowed consent under the ORIGINAL session id.
  await grantStore.save(narrowed, {
    audience: ORIGIN,
    room: ROOM,
    requestNonce: sessionId,
  });
  clock = 2000;

  const state = {
    externalOrigin: ORIGIN,
    // The wallet advanced its in-memory consent to the renewal envelope.
    consent: narrowed,
    // This identity never changes; a renewal only changes the signed envelope.
    externalRequest: { nonce: sessionId, room: ROOM },
    externalStatus: "sent",
    externalPendingEvents: [],
    lease: { revoke() {} },
    transfers: null,
    room: null,
    rtc: null,
  };
  const sandbox = runFragment(
    [
      extractFunction(source, "touchGrant"),
      extractFunction(source, "markSessionEnded"),
      extractFunction(source, "expireExternalSession"),
    ].join("\n"),
    {
      state,
      grantStore,
      externalHost: { postMessage() {} },
      roomGeneration: 0,
      clearTimeout() {},
      render() {},
    },
  );

  sandbox.touchGrant();
  await waitFor(async () => {
    const record = await grantStore.get(ORIGIN, sessionId);
    return record?.lastActivity === 2000;
  });

  await sandbox.expireExternalSession("ended");
  const stable = await grantStore.get(ORIGIN, sessionId);
  assert.equal(stable?.ended, true, "the stable grant is marked ended");
  assert.equal(
    await grantStore.get(ORIGIN, narrowed.body.payload.requestNonce),
    null,
    "no stray grant is created under the renewal nonce",
  );
});
