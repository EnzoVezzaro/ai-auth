import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  CONSENT_VERSION,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_TTL_MS,
  createAgentDescriptor,
  createInstanceId,
  identityFor,
  sessionLimits,
  verifyAgentDescriptor,
  verifyConsentAgent,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const ROOM = "research";
const NONCE = "nonce-0123456789abcdef";
const NOW = 1_800_000_000_000;

async function makeWallet() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    id: await identityFor(publicKey),
    publicKey,
    privateKey: keys.privateKey,
  };
}

// Defaults keep nonce and sessionId equal to the request nonce so descriptor
// verification succeeds; individual tests override one field to force a branch.
function makeDescriptor(wallet, extra = {}) {
  return createAgentDescriptor(wallet, {
    instanceId: createInstanceId(),
    agentType: "coding-agent",
    runtime: { name: "node", version: "22" },
    provider: "acme",
    model: "model-x",
    sessionId: NONCE,
    origin: ORIGIN,
    room: ROOM,
    capabilities: ["messages.send"],
    nonce: NONCE,
    now: NOW,
    ...extra,
  });
}

function consentFor(wallet, descriptor, extra = {}) {
  return {
    body: {
      issuer: wallet.id,
      payload: {
        version: CONSENT_VERSION,
        agentDescriptor: descriptor,
        capabilities: ["messages.send"],
        ...extra,
      },
    },
  };
}

const request = { nonce: NONCE, room: ROOM };
const options = (wallet, extra = {}) => ({
  expectedOrigin: ORIGIN,
  expectedWallet: wallet.id,
  now: NOW + 1000,
  ...extra,
});

test("no descriptor: ok with a null participant", async () => {
  assert.deepEqual(await verifyConsentAgent({}, {}, {}), {
    ok: true,
    participant: null,
  });
});

test("a descriptor on a non-v2 consent is not allowed", async () => {
  const consent = { body: { payload: { version: 1, agentDescriptor: {} } } };
  assert.deepEqual(await verifyConsentAgent(consent, request, {}), {
    ok: false,
    reason: "descriptor-not-allowed",
  });
});

test("a valid descriptor yields a frozen, unattested participant", async () => {
  const wallet = await makeWallet();
  const descriptor = await makeDescriptor(wallet);
  const result = await verifyConsentAgent(
    consentFor(wallet, descriptor),
    request,
    options(wallet),
  );
  assert.equal(result.ok, true);
  assert.equal(result.participant.identity.id, wallet.id);
  assert.equal(result.participant.sessionId, NONCE);
  assert.equal(result.participant.claimsAttested, false);
  assert.ok(Object.isFrozen(result.participant));
});

test("a descriptor from another wallet is a mismatch", async () => {
  const wallet = await makeWallet();
  const other = await makeWallet();
  const consent = consentFor(wallet, await makeDescriptor(wallet));
  const result = await verifyConsentAgent(consent, request, options(other));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "descriptor-mismatch");
});

test("a descriptor whose sessionId differs from the request nonce is a mismatch", async () => {
  const wallet = await makeWallet();
  // nonce matches the request (so verifyAgentDescriptor passes), sessionId does not.
  const descriptor = await makeDescriptor(wallet, {
    sessionId: "different-session",
  });
  const result = await verifyConsentAgent(
    consentFor(wallet, descriptor),
    request,
    options(wallet),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "descriptor-mismatch");
});

test("a descriptor capability outside the consent is a mismatch", async () => {
  const wallet = await makeWallet();
  const descriptor = await makeDescriptor(wallet);
  const consent = consentFor(wallet, descriptor, {
    capabilities: ["tools.invoke"],
  });
  const result = await verifyConsentAgent(consent, request, options(wallet));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "descriptor-mismatch");
});

test("an expired descriptor propagates verifyAgentDescriptor's reason", async () => {
  const wallet = await makeWallet();
  const descriptor = await makeDescriptor(wallet, { ttlMs: 60_000 });
  const later = NOW + 61_000;
  const expected = await verifyAgentDescriptor(descriptor, {
    expectedOrigin: ORIGIN,
    expectedRoom: ROOM,
    expectedNonce: NONCE,
    now: later,
  });
  assert.equal(expected.ok, false);
  const result = await verifyConsentAgent(
    consentFor(wallet, descriptor),
    request,
    options(wallet, { now: later }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, expected.reason);
});

test("empty request uses the 30-minute TTL default and a bounded idle default", async () => {
  const limits = sessionLimits({});
  // 30-minute default is the exported constant.
  assert.equal(DEFAULT_SESSION_TTL_MS, 30 * 60 * 1000);
  assert.equal(limits.maxSessionTtlMs, DEFAULT_SESSION_TTL_MS);
  assert.equal(
    limits.maxIdleTimeoutMs,
    Math.min(DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_SESSION_TTL_MS),
  );
});

test("sessionPolicy never and a null sessionTtlMs allow no session bounds", async () => {
  assert.deepEqual(sessionLimits({ sessionPolicy: "never" }), {
    maxSessionTtlMs: null,
    maxIdleTimeoutMs: null,
  });
  assert.deepEqual(sessionLimits({ sessionTtlMs: null }), {
    maxSessionTtlMs: null,
    maxIdleTimeoutMs: null,
  });
});

test("numeric sessionTtlMs caps the grant and idleTimeoutMs is used as given", async () => {
  assert.deepEqual(
    sessionLimits({ sessionTtlMs: 45_000, idleTimeoutMs: 20_000 }),
    { maxSessionTtlMs: 45_000, maxIdleTimeoutMs: 20_000 },
  );
});
