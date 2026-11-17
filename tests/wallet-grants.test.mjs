import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import {
  approvePermissionRequest,
  createInstanceId,
  createPermissionRequest,
  identityFor,
  signEnvelope,
} from "../packages/p2p/index.js";
import { canResumeStoredSession } from "../packages/p2p/resume-verification.js";
import {
  createGrantStore,
  indexedDbGrantAdapter,
  memoryGrantAdapter,
} from "../packages/p2p/grant-store.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const ROOM = "research";
const CAPS = ["messages.send", "presence.read"];
const MINUTE = 60_000;

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

async function grantConsent(wallet, { idleTimeoutMs = 10 * MINUTE } = {}) {
  const request = await createPermissionRequest(ORIGIN, CAPS, {
    room: ROOM,
    expiresInMs: 120_000,
    sessionTtlMs: 30 * MINUTE,
    idleTimeoutMs,
  });
  return approvePermissionRequest(wallet, request, CAPS, {
    agent: {
      instanceId: createInstanceId(),
      agentType: "coding-agent",
      runtime: { name: "node", version: "22" },
      provider: "acme",
      model: "x",
    },
  });
}

function resumeOptions(consent, store, overrides = {}) {
  return {
    audience: ORIGIN,
    sessionId: consent.body.payload.requestNonce,
    room: ROOM,
    walletId: consent.body.issuer,
    store,
    now: consent.body.payload.issuedAt + MINUTE,
    ...overrides,
  };
}

async function storedGrant(options = {}) {
  const wallet = await makeWallet();
  const consent = await grantConsent(wallet, options);
  const backing = new Map();
  const store = createGrantStore({
    adapter: memoryGrantAdapter({ backing }),
    now: () => consent.body.payload.issuedAt,
  });
  await store.save(consent, { audience: ORIGIN, room: ROOM });
  return { wallet, consent, backing, store };
}

test("an approved grant survives a simulated wallet reload", async () => {
  const { consent, backing } = await storedGrant();
  const nonce = consent.body.payload.requestNonce;
  // A new adapter over the same backing models a new wallet page instance.
  const reloaded = createGrantStore({
    adapter: memoryGrantAdapter({ backing }),
  });
  const record = await reloaded.get(ORIGIN, nonce);
  assert.ok(record, "a new adapter over the same backing reads the grant");
  assert.deepEqual(record.consent, consent);
  assert.equal(record.audience, ORIGIN);
  assert.equal(record.room, ROOM);
  assert.deepEqual(record.capabilities, CAPS);
  assert.equal(record.expiresAt, consent.body.payload.expiresAt);
  assert.equal(record.idleTimeoutMs, 10 * MINUTE);
  assert.equal(record.issuedAt, consent.body.payload.issuedAt);
  assert.equal(record.lastActivity, consent.body.payload.issuedAt);
  assert.equal(record.ended, false);
});

test("an ended grant is refused on resume", async () => {
  const { consent, store } = await storedGrant();
  const nonce = consent.body.payload.requestNonce;
  assert.equal(
    await canResumeStoredSession(consent, resumeOptions(consent, store)),
    true,
    "a live durable grant can be confirmed",
  );
  await store.markEnded(ORIGIN, nonce);
  assert.equal((await store.get(ORIGIN, nonce)).ended, true);
  assert.equal(
    await canResumeStoredSession(consent, resumeOptions(consent, store)),
    false,
    "the durable ended flag is read on resume",
  );
});

test("an idle-timed-out grant is refused but fresh activity keeps it valid", async () => {
  // A 30s idle window keeps every probe inside the signed descriptor's own
  // 2-minute lifetime, so this isolates the idle rule.
  const { consent, store } = await storedGrant({ idleTimeoutMs: 30_000 });
  const nonce = consent.body.payload.requestNonce;
  const issuedAt = consent.body.payload.issuedAt;
  assert.equal(
    await canResumeStoredSession(
      consent,
      resumeOptions(consent, store, { now: issuedAt + 10_000 }),
    ),
    true,
    "a grant within its idle timeout is not refused",
  );
  assert.equal(
    await canResumeStoredSession(
      consent,
      resumeOptions(consent, store, { now: issuedAt + 45_000 }),
    ),
    false,
    "the existing idle check still refuses a stale grant",
  );
  await store.touch(ORIGIN, nonce, issuedAt + 45_000);
  assert.equal(
    await canResumeStoredSession(
      consent,
      resumeOptions(consent, store, { now: issuedAt + 60_000 }),
    ),
    true,
    "recent activity recorded in the durable grant keeps it resumable",
  );
});

test("resume reuses the exact saved envelope and grants no new scope", async () => {
  const { wallet, consent, store } = await storedGrant();
  const widened = await wallet.sign("connect/consent", {
    ...consent.body.payload,
    capabilities: [...CAPS, "tools.invoke"],
  });
  assert.equal(
    await canResumeStoredSession(widened, resumeOptions(widened, store)),
    false,
    "a consent that differs from the saved envelope is refused",
  );
});

test("the IndexedDB adapter persists grants and ended flags across instances", async () => {
  const factory = new IDBFactory();
  const wallet = await makeWallet();
  const consent = await grantConsent(wallet);
  const nonce = consent.body.payload.requestNonce;
  const first = createGrantStore({
    adapter: indexedDbGrantAdapter({ factory }),
  });
  await first.save(consent, { audience: ORIGIN, room: ROOM });

  const reloaded = createGrantStore({
    adapter: indexedDbGrantAdapter({ factory }),
  });
  const record = await reloaded.get(ORIGIN, nonce);
  assert.ok(record, "the thin IndexedDB wrapper reads the saved grant");
  assert.deepEqual(record.consent, consent);
  assert.equal(record.ended, false);

  await reloaded.markEnded(ORIGIN, nonce);
  const afterEnd = createGrantStore({
    adapter: indexedDbGrantAdapter({ factory }),
  });
  assert.equal((await afterEnd.get(ORIGIN, nonce)).ended, true);
  assert.equal(
    await canResumeStoredSession(consent, resumeOptions(consent, afterEnd)),
    false,
  );
});
