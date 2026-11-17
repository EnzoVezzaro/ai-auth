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
  agentKeyFor,
  createSessionStore,
  listResumableSessions,
  recordFromConsent,
  verifyStoredConsent,
} from "../packages/p2p/session-store.js";
import {
  connectAIAuthModal,
  resumeAIAuthSession,
} from "../packages/p2p/embed.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const OTHER_ORIGIN = "https://other.example";
const ROOM = "research";
const CAPS = ["messages.send", "presence.read"];
const MINUTE = 60_000;

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

async function makeWallet(name = "Agent") {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const wallet = { id, name, publicKey, privateKey: pair.privateKey };
  return {
    ...wallet,
    sign: (type, payload) => signEnvelope(wallet, type, payload),
  };
}

function agent(instanceId = createInstanceId()) {
  return {
    instanceId,
    agentType: "coding-agent",
    runtime: { name: "node", version: "22" },
    provider: "acme",
    model: "model-x",
  };
}

async function makeGrant(
  wallet,
  {
    origin = ORIGIN,
    room = ROOM,
    capabilities = CAPS,
    ttlMs = 30 * MINUTE,
    instanceId = createInstanceId(),
  } = {},
) {
  const request = await createPermissionRequest(origin, capabilities, {
    room,
    expiresInMs: 120_000,
    sessionTtlMs: ttlMs,
    idleTimeoutMs: 10 * MINUTE,
  });
  const consent = await approvePermissionRequest(
    wallet,
    request,
    capabilities,
    { agent: agent(instanceId) },
  );
  const participant = {
    identity: { id: wallet.id },
    instanceId,
    sessionId: consent.body.payload.requestNonce,
  };
  return { request, consent, participant };
}

function recordFor(grant, overrides = {}) {
  return recordFromConsent(grant.consent, {
    origin: ORIGIN,
    room: ROOM,
    participant: grant.participant,
    ...overrides,
  });
}

// A real signed renewal: it carries its own request nonce but links back to the
// original session, which stays the record's stable id.
async function renewConsent(wallet, previous, capabilities = CAPS) {
  const request = await createPermissionRequest(ORIGIN, capabilities, {
    room: ROOM,
    expiresInMs: 120_000,
    sessionTtlMs: 30 * MINUTE,
    idleTimeoutMs: 10 * MINUTE,
    renews: previous.body.payload.requestNonce,
  });
  return approvePermissionRequest(wallet, request, capabilities, {
    previousConsent: previous,
    agent: agent(),
  });
}

// ---- R2: per-agent session records -----------------------------------------

test("R2 a session record round-trips through the store", async () => {
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  const grant = await makeGrant(await makeWallet());
  const record = recordFor(grant);
  await store.save(ORIGIN, record);

  const [loaded] = await store.list(ORIGIN);
  assert.equal(loaded.walletId, record.walletId);
  assert.equal(loaded.agentKey, record.agentKey);
  assert.equal(loaded.sessionId, record.sessionId);
  assert.equal(loaded.expiresAt, record.expiresAt);
  assert.equal(loaded.idleTimeoutMs, record.idleTimeoutMs);
  assert.deepEqual(loaded.capabilities, CAPS);
  assert.equal(loaded.room, ROOM);
  assert.deepEqual(loaded.consent, grant.consent);
  assert.equal(loaded.audience, ORIGIN);
});

test("R2 two agents in one browser keep separate records", async () => {
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  const first = recordFor(await makeGrant(await makeWallet("First")));
  const second = recordFor(await makeGrant(await makeWallet("Second")));
  assert.notEqual(first.agentKey, second.agentKey);

  await store.save(ORIGIN, first);
  await store.save(ORIGIN, second);
  assert.equal((await store.list(ORIGIN)).length, 2);

  await store.remove(ORIGIN, first.agentKey);
  const remaining = await store.list(ORIGIN);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].agentKey, second.agentKey);
});

test("R2 the same wallet with a different instance keeps a separate record", async () => {
  const wallet = await makeWallet();
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  const one = recordFor(
    await makeGrant(wallet, { instanceId: "inst:aaaaaaaaaaaaaaaaaaaaaa" }),
  );
  const two = recordFor(
    await makeGrant(wallet, { instanceId: "inst:bbbbbbbbbbbbbbbbbbbbbb" }),
  );
  await store.save(ORIGIN, one);
  await store.save(ORIGIN, two);
  assert.equal((await store.list(ORIGIN)).length, 2);
});

test("R2 an expired record is dropped from the store", async () => {
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  const grant = await makeGrant(await makeWallet(), { ttlMs: 1_000 });
  await store.save(ORIGIN, recordFor(grant));

  const before = Date.now() + 2_000;
  assert.equal((await store.list(ORIGIN, { now: before })).length, 0);
  assert.equal(
    storage.map.size,
    0,
    "the expired record is deleted, not just hidden",
  );
});

test("R2 a record whose audience is another origin is ignored and deleted", async () => {
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  const grant = await makeGrant(await makeWallet());
  const record = recordFor(grant, {
    origin: OTHER_ORIGIN,
    audience: OTHER_ORIGIN,
  });
  await store.save(ORIGIN, record);

  assert.equal((await store.list(ORIGIN)).length, 0);
  assert.equal(storage.map.size, 0);
});

test("R2 records for different origins never mix", async () => {
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  const a = recordFor(await makeGrant(await makeWallet("A")));
  const b = recordFor(
    await makeGrant(await makeWallet("B"), { origin: OTHER_ORIGIN }),
    {
      origin: OTHER_ORIGIN,
      audience: OTHER_ORIGIN,
    },
  );
  await store.save(ORIGIN, a);
  await store.save(OTHER_ORIGIN, b);

  assert.equal((await store.list(ORIGIN)).length, 1);
  assert.equal((await store.list(OTHER_ORIGIN)).length, 1);
  assert.notEqual(
    (await store.list(ORIGIN))[0].walletId,
    (await store.list(OTHER_ORIGIN))[0].walletId,
  );
});

test("R2 the agent key is stable for one wallet identity and instance", () => {
  const key = agentKeyFor({ walletId: "agent:abc", instanceId: "inst:xyz" });
  assert.equal(
    key,
    agentKeyFor({ walletId: "agent:abc", instanceId: "inst:xyz" }),
  );
  assert.notEqual(
    key,
    agentKeyFor({ walletId: "agent:abc", instanceId: "inst:other" }),
  );
  assert.notEqual(
    key,
    agentKeyFor({ walletId: "agent:other", instanceId: "inst:xyz" }),
  );
});

// ---- verifying a stored (public) consent -----------------------------------

test("stored consent verification accepts a genuine, unexpired grant", async () => {
  const grant = await makeGrant(await makeWallet());
  assert.equal(
    await verifyStoredConsent(grant.consent, {
      origin: ORIGIN,
      walletId: grant.consent.body.issuer,
    }),
    true,
  );
});

test("stored consent verification rejects a tampered, wrong-origin or expired grant", async () => {
  const wallet = await makeWallet();
  const grant = await makeGrant(wallet);
  const now = Date.now();
  assert.equal(
    await verifyStoredConsent(grant.consent, {
      origin: OTHER_ORIGIN,
      walletId: wallet.id,
      now,
    }),
    false,
  );
  assert.equal(
    await verifyStoredConsent(grant.consent, {
      origin: ORIGIN,
      walletId: "agent:someone-else",
      now,
    }),
    false,
  );
  assert.equal(
    await verifyStoredConsent(grant.consent, {
      origin: ORIGIN,
      walletId: wallet.id,
      now: grant.consent.body.payload.expiresAt + 1,
    }),
    false,
  );

  const tampered = structuredClone(grant.consent);
  tampered.body.payload.capabilities = ["tools.invoke"];
  assert.equal(
    await verifyStoredConsent(tampered, {
      origin: ORIGIN,
      walletId: wallet.id,
      now,
    }),
    false,
  );
});

test("R2 an idle-timed-out record is dropped but a touched one survives", async () => {
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  const wallet = await makeWallet();
  const grant = await makeGrant(wallet, { ttlMs: 60 * MINUTE });
  const record = recordFor(grant);
  assert.ok(Number.isFinite(record.lastActivity));
  await store.save(ORIGIN, record);

  const at = record.lastActivity + 11 * MINUTE;
  assert.equal((await store.list(ORIGIN, { now: at })).length, 0);

  await store.save(ORIGIN, record);
  assert.equal(store.touch(ORIGIN, record.agentKey, at - MINUTE), true);
  assert.equal((await store.list(ORIGIN, { now: at })).length, 1);
});

test("R2 the site record carries only public data", async () => {
  const grant = await makeGrant(await makeWallet());
  const record = recordFor(grant);
  const json = JSON.stringify(record);
  assert.ok(record.publicKey, "the public key from the signed proof is stored");
  assert.deepEqual(record.publicKey, grant.consent.proof.publicKey);
  assert.ok(!json.includes("privateKey"));
  assert.ok(!json.includes("passphrase"));
});

test("R2 a record written by one store is readable by a second store after a restart", async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  try {
    const first = createSessionStore();
    const record = recordFor(await makeGrant(await makeWallet()));
    await first.save(ORIGIN, record);

    // A new store instance models a new tab or a browser restart over the
    // same durable, origin-scoped storage.
    const second = createSessionStore();
    const [loaded] = await second.list(ORIGIN);
    assert.ok(loaded, "the second instance reads the first instance's record");
    assert.equal(loaded.agentKey, record.agentKey);
    assert.equal(loaded.savedAt, record.savedAt);
  } finally {
    delete globalThis.localStorage;
  }
});

test("R2 the store defaults to localStorage, never sessionStorage", async () => {
  const session = memoryStorage();
  const local = memoryStorage();
  globalThis.sessionStorage = session;
  globalThis.localStorage = local;
  try {
    const store = createSessionStore();
    const record = recordFor(await makeGrant(await makeWallet()));
    await store.save(ORIGIN, record);
    assert.equal(local.map.size, 1, "the durable backing is localStorage");
    assert.equal(session.map.size, 0, "sessionStorage is never used");
  } finally {
    delete globalThis.sessionStorage;
    delete globalThis.localStorage;
  }
});

test("R2 an invalid signature in a stored record is dropped", async () => {
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  const grant = await makeGrant(await makeWallet());
  const tamperedConsent = structuredClone(grant.consent);
  tamperedConsent.body.payload.capabilities.push("tools.invoke");
  const record = { ...recordFor(grant), consent: tamperedConsent };
  await store.save(ORIGIN, record);

  assert.equal((await store.list(ORIGIN)).length, 0);
  assert.equal(storage.map.size, 0);
});

// ---- R1: explicit, wallet-confirmed restore --------------------------------

function fakeBrowser() {
  const handlers = new Set();
  const sentToWallet = [];
  const popup = { postMessage: (data) => sentToWallet.push(data) };
  const node = (tag) => ({
    tag,
    style: {},
    setAttribute() {},
    append() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    showModal() {},
    close() {},
    ...(tag === "iframe" ? { contentWindow: popup } : {}),
  });
  const win = {
    document: { body: node("body"), createElement: node },
    addEventListener: (type, fn) => type === "message" && handlers.add(fn),
    removeEventListener: (type, fn) => handlers.delete(fn),
  };
  const fromWallet = async (data, origin = "https://wallet.example") => {
    for (const fn of [...handlers]) await fn({ source: popup, origin, data });
    await new Promise((r) => setTimeout(r, 10));
  };
  return { win, sentToWallet, fromWallet, handlerCount: () => handlers.size };
}

async function waitForHandler(browser) {
  for (let i = 0; i < 100 && browser.handlerCount() === 0; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(browser.handlerCount() > 0, "the wallet listener is registered");
}

async function seededStore() {
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  const wallet = await makeWallet();
  const grant = await makeGrant(wallet);
  const record = recordFor(grant);
  await store.save(ORIGIN, record);
  return { store, storage, wallet, grant, record };
}

function resumeOptions(ctx, browser, extra = {}) {
  return {
    walletUrl: "https://wallet.example/",
    origin: ORIGIN,
    room: ROOM,
    capabilities: CAPS,
    windowObject: browser.win,
    sessionStore: ctx.store,
    resumeTimeoutMs: 200,
    timeoutMs: 5_000,
    ...extra,
  };
}

test("R1 listResumableSessions offers a stored session for the Resume action", async () => {
  const ctx = await seededStore();
  const found = await listResumableSessions(ctx.store, {
    origin: ORIGIN,
    room: ROOM,
    capabilities: CAPS,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].agentKey, ctx.record.agentKey);
  assert.equal(
    (
      await listResumableSessions(ctx.store, {
        origin: ORIGIN,
        room: "another-room",
      })
    ).length,
    0,
  );
});

test("R1 restore resumes without a new consent when the wallet confirms", async () => {
  const ctx = await seededStore();
  const browser = fakeBrowser();
  const promise = resumeAIAuthSession(resumeOptions(ctx, browser));
  await waitForHandler(browser);
  await browser.fromWallet({ type: "ai-auth/connect-ready" });

  const resumeMessage = browser.sentToWallet.find(
    (m) => m.type === "ai-auth/session-resume",
  );
  assert.ok(resumeMessage, "the wallet is asked to resume the saved session");
  assert.equal(resumeMessage.sessionId, ctx.record.sessionId);
  assert.equal(resumeMessage.walletId, ctx.record.walletId);
  assert.equal(resumeMessage.audience, ORIGIN);
  assert.deepEqual(resumeMessage.capabilities, CAPS);
  assert.equal(
    browser.sentToWallet.some((m) => m.type === "ai-auth/connect-request"),
    false,
    "no fresh consent request is sent",
  );

  await browser.fromWallet({
    type: "ai-auth/session-resumed",
    sessionId: ctx.record.sessionId,
    wallet: { id: ctx.wallet.id, name: ctx.wallet.name },
    consent: ctx.record.consent,
  });
  const connection = await promise;
  try {
    assert.deepEqual(connection.consent, ctx.record.consent);
    assert.equal(connection.expiresAt, ctx.record.expiresAt);
    assert.deepEqual([...connection.capabilities], CAPS);
    assert.equal(connection.consent.body.issuer, ctx.wallet.id);
    const events = [];
    connection.onLifecycle((event) => events.push(event));
    assert.equal(events[0].identity.id, ctx.wallet.id);
    assert.equal((await ctx.store.list(ORIGIN)).length, 1);
  } finally {
    connection?.close?.();
  }
});

test("FX1-02 resume aligns the site request nonce with the stored session id", async () => {
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  const wallet = await makeWallet();
  const grant = await makeGrant(wallet);
  const sessionId = grant.consent.body.payload.requestNonce;
  const renewed = await renewConsent(wallet, grant.consent);
  assert.notEqual(renewed.body.payload.requestNonce, sessionId);
  const record = recordFromConsent(renewed, {
    origin: ORIGIN,
    room: ROOM,
    participant: { instanceId: sessionId, sessionId },
  });
  await store.save(ORIGIN, record);

  const browser = fakeBrowser();
  const promise = resumeAIAuthSession(resumeOptions({ store }, browser));
  promise.catch(() => {});
  await waitForHandler(browser);
  await browser.fromWallet({ type: "ai-auth/connect-ready" });
  await browser.fromWallet({
    type: "ai-auth/session-resumed",
    sessionId,
    wallet: { id: wallet.id, name: wallet.name },
    consent: renewed,
  });
  const connection = await promise;
  try {
    assert.equal(
      connection.request.nonce,
      sessionId,
      "the site must route tool and room-ready traffic with the resumed session id",
    );
  } finally {
    connection.close();
  }
});

test("R1 restore drops the record when the wallet says the session ended or was revoked", async () => {
  for (const reason of ["ended", "revoked"]) {
    const ctx = await seededStore();
    const browser = fakeBrowser();
    const promise = resumeAIAuthSession(resumeOptions(ctx, browser));
    const rejection = assert.rejects(promise, /session|resume|connect/u);
    await waitForHandler(browser);
    await browser.fromWallet({ type: "ai-auth/connect-ready" });
    await browser.fromWallet({ type: "ai-auth/session-ended", reason });
    await rejection;
    assert.equal(
      (await ctx.store.list(ORIGIN)).length,
      0,
      `${reason} record dropped`,
    );
    assert.equal(browser.handlerCount(), 0, "the failed restore cleans up");
  }
});

test("R1 restore keeps the record and offers a retry when the wallet times out", async () => {
  const ctx = await seededStore();
  const browser = fakeBrowser();
  const promise = resumeAIAuthSession(
    resumeOptions(ctx, browser, { resumeTimeoutMs: 30 }),
  );
  const rejection = assert.rejects(promise, /try again|Resume/u);
  await waitForHandler(browser);
  await browser.fromWallet({ type: "ai-auth/connect-ready" });
  await rejection;
  // A timeout is a slow wallet, not a refusal: the saved session stays.
  assert.equal((await ctx.store.list(ORIGIN)).length, 1);
});

test("R1 restore refuses a wallet response that widens the stored scopes", async () => {
  const ctx = await seededStore();
  const browser = fakeBrowser();
  const promise = resumeAIAuthSession(resumeOptions(ctx, browser));
  const rejection = assert.rejects(promise, /scope|permission|resume|verif/u);
  await waitForHandler(browser);
  await browser.fromWallet({ type: "ai-auth/connect-ready" });
  const widened = await makeGrant(ctx.wallet, {
    capabilities: [...CAPS, "tools.invoke"],
  });
  await browser.fromWallet({
    type: "ai-auth/session-resumed",
    sessionId: ctx.record.sessionId,
    wallet: { id: ctx.wallet.id, name: ctx.wallet.name },
    consent: widened.consent,
  });
  await rejection;
  assert.equal((await ctx.store.list(ORIGIN)).length, 0);
});

test("R1 a normal connect never resumes silently from stored records", async () => {
  const ctx = await seededStore();
  const browser = fakeBrowser();
  const pending = connectAIAuthModal({
    walletUrl: "https://wallet.example/",
    origin: ORIGIN,
    room: ROOM,
    capabilities: CAPS,
    windowObject: browser.win,
    sessionStore: ctx.store,
    timeoutMs: 5_000,
  });
  pending.catch(() => {});
  await waitForHandler(browser);
  await browser.fromWallet({ type: "ai-auth/connect-ready" });
  assert.equal(
    browser.sentToWallet.some((m) => m.type === "ai-auth/session-resume"),
    false,
    "only an explicit Resume action asks the wallet to resume",
  );
  assert.ok(
    browser.sentToWallet.some((m) => m.type === "ai-auth/connect-request"),
    "a normal connect asks for fresh consent",
  );
  pending.catch(() => {});
});
