// Regression coverage for renewal and grant integrity (findings 03-01, 03-02,
// 03-04, 03-05 and WA-04). Every test drives the real modules with real signed
// envelopes: the wallet grant store, the resume verifiers, the site session
// store and the real app.js handler source text.
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
  canResumeSession,
  canResumeStoredSession,
} from "../packages/p2p/resume-verification.js";
import {
  createGrantStore,
  memoryGrantAdapter,
} from "../packages/p2p/grant-store.js";
import {
  createSessionStore,
  recordFromConsent,
  verifyStoredConsent,
} from "../packages/p2p/session-store.js";
import { resumeAIAuthSession } from "../packages/p2p/embed.js";
import {
  appSource,
  memoryStorage,
  runFragment,
} from "./helpers/app-source.mjs";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const WALLET_ORIGIN = "https://wallet.example";
const ROOM = "research";
const CAPS = ["presence.read", "messages.send"];
const MINUTE = 60_000;
const EIGHT_DAYS = 8 * 24 * 60 * MINUTE;

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
  provider: "acme",
  model: "model-x",
});

async function grant(wallet, { capabilities = CAPS, withAgent = true } = {}) {
  const request = await createPermissionRequest(ORIGIN, capabilities, {
    room: ROOM,
    expiresInMs: 120_000,
    sessionTtlMs: 30 * MINUTE,
    idleTimeoutMs: 10 * MINUTE,
  });
  return approvePermissionRequest(wallet, request, capabilities, {
    ...(withAgent ? { agent: agent() } : {}),
  });
}

async function neverGrant(wallet) {
  const request = await createPermissionRequest(ORIGIN, CAPS, {
    room: ROOM,
    expiresInMs: 120_000,
    sessionTtlMs: null,
    idleTimeoutMs: null,
  });
  return approvePermissionRequest(wallet, request, CAPS, {});
}

// A real renewal: its own request nonce, renewsNonce pointing at the original
// session, and capabilities that can only be a subset of the original.
async function renew(wallet, previous, capabilities) {
  const request = await createPermissionRequest(
    ORIGIN,
    previous.body.payload.capabilities,
    {
      room: ROOM,
      expiresInMs: 120_000,
      sessionTtlMs: 30 * MINUTE,
      idleTimeoutMs: 10 * MINUTE,
      renews: previous.body.payload.requestNonce,
    },
  );
  return approvePermissionRequest(wallet, request, capabilities, {
    previousConsent: previous,
    agent: agent(),
  });
}

function resumeOpts(sessionId, consent, store, overrides = {}) {
  return {
    audience: ORIGIN,
    sessionId,
    room: ROOM,
    walletId: consent.body.issuer,
    store,
    now: consent.body.payload.issuedAt + MINUTE,
    ...overrides,
  };
}

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
  const fromWallet = async (data) => {
    for (const fn of [...handlers])
      await fn({ source: popup, origin: WALLET_ORIGIN, data });
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const waitForHandler = async () => {
    for (let i = 0; i < 100 && handlers.size === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(handlers.size > 0, "the wallet listener is registered");
  };
  return { win, sentToWallet, fromWallet, waitForHandler };
}

// ---- 03-01: renewal retires the superseded, broader consent ----------------

test("03-01 renewal replaces the stored grant so the old broad consent cannot resume", async () => {
  const wallet = await makeWallet();
  const original = await grant(wallet);
  const sessionId = original.body.payload.requestNonce;
  const backing = new Map();
  const store = createGrantStore({ adapter: memoryGrantAdapter({ backing }) });
  await store.save(original, { audience: ORIGIN, room: ROOM });
  const narrowed = await renew(wallet, original, ["presence.read"]);
  assert.equal(narrowed.body.payload.renewsNonce, sessionId);

  // The renewal replaces the record at the ORIGINAL session id, never creating
  // a second grant under its own request nonce.
  await store.save(narrowed, {
    audience: ORIGIN,
    room: ROOM,
    requestNonce: sessionId,
  });

  assert.equal(
    await canResumeStoredSession(
      original,
      resumeOpts(sessionId, original, store),
    ),
    false,
    "the superseded broader consent no longer resumes",
  );
  assert.equal(
    (await store.get(ORIGIN, narrowed.body.payload.requestNonce)) === null,
    true,
    "no grant is left under the renewal request nonce",
  );
});

// ---- 03-02: the renewed consent survives a site/wallet reload --------------

test("03-02 the renewed consent resumes from the durable grant after a reload", async () => {
  const wallet = await makeWallet();
  const original = await grant(wallet);
  const sessionId = original.body.payload.requestNonce;
  const backing = new Map();
  const store = createGrantStore({ adapter: memoryGrantAdapter({ backing }) });
  await store.save(original, { audience: ORIGIN, room: ROOM });
  const narrowed = await renew(wallet, original, ["presence.read"]);
  await store.save(narrowed, {
    audience: ORIGIN,
    room: ROOM,
    requestNonce: sessionId,
  });

  const reloaded = createGrantStore({
    adapter: memoryGrantAdapter({ backing }),
  });
  assert.equal(
    await canResumeStoredSession(
      narrowed,
      resumeOpts(sessionId, narrowed, reloaded),
    ),
    true,
    "the renewed consent resumes after a simulated wallet reload",
  );
});

test("03-02 a renewed site record resumes after a refresh without a new consent", async () => {
  const wallet = await makeWallet();
  const original = await grant(wallet);
  const sessionId = original.body.payload.requestNonce;
  const narrowed = await renew(wallet, original, ["presence.read"]);
  const record = recordFromConsent(narrowed, {
    origin: ORIGIN,
    room: ROOM,
    participant: {
      identity: { id: wallet.id },
      instanceId: sessionId,
      sessionId,
    },
  });
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  await store.save(ORIGIN, record);
  const browser = fakeBrowser();
  const promise = resumeAIAuthSession({
    walletUrl: `${WALLET_ORIGIN}/`,
    origin: ORIGIN,
    room: ROOM,
    capabilities: ["presence.read"],
    windowObject: browser.win,
    sessionStore: store,
    resumeTimeoutMs: 1_000,
    timeoutMs: 5_000,
  });
  promise.catch(() => {});
  await browser.waitForHandler();
  await browser.fromWallet({ type: "ai-auth/connect-ready" });

  const message = browser.sentToWallet.find(
    (entry) => entry.type === "ai-auth/session-resume",
  );
  assert.ok(message, "the site asks to resume the saved session");
  assert.equal(message.sessionId, sessionId, "the stable id is used");
  assert.deepEqual(message.consent, narrowed, "the renewed consent is sent");

  await browser.fromWallet({
    type: "ai-auth/session-resumed",
    sessionId,
    wallet: { id: wallet.id, name: wallet.name },
    consent: narrowed,
  });
  const connection = await promise;
  try {
    assert.deepEqual(connection.consent, narrowed);
    assert.deepEqual([...connection.capabilities], ["presence.read"]);
  } finally {
    connection?.close?.();
  }
});

test("03-02 repeated renewals still resume under the original session id", async () => {
  const wallet = await makeWallet();
  const original = await grant(wallet);
  const sessionId = original.body.payload.requestNonce;
  const backing = new Map();
  const store = createGrantStore({ adapter: memoryGrantAdapter({ backing }) });
  await store.save(original, { audience: ORIGIN, room: ROOM });
  const first = await renew(wallet, original, ["presence.read"]);
  await store.save(first, {
    audience: ORIGIN,
    room: ROOM,
    requestNonce: sessionId,
  });
  const second = await renew(wallet, first, ["presence.read"]);
  assert.notEqual(second.body.payload.renewsNonce, sessionId);
  await store.save(second, {
    audience: ORIGIN,
    room: ROOM,
    requestNonce: sessionId,
  });

  assert.equal(
    await canResumeStoredSession(
      second,
      resumeOpts(sessionId, second, store, {
        now: second.body.payload.issuedAt + MINUTE,
      }),
    ),
    true,
    "the latest consent resumes even after several renewals",
  );
  assert.equal(
    await canResumeStoredSession(
      first,
      resumeOpts(sessionId, first, store, {
        now: second.body.payload.issuedAt + MINUTE,
      }),
    ),
    false,
    "an earlier renewal is superseded too",
  );
});

// ---- FX1-03: the site accepts a second renewal on resume --------------------

test("FX1-03 a twice-renewed consent still resumes on the site side", async () => {
  const wallet = await makeWallet();
  const original = await grant(wallet);
  const sessionId = original.body.payload.requestNonce;
  const first = await renew(wallet, original, ["presence.read"]);
  const second = await renew(wallet, first, ["presence.read"]);
  // The second renewal chains to the first renewal nonce, not to the stable id.
  assert.notEqual(second.body.payload.renewsNonce, sessionId);
  const record = recordFromConsent(second, {
    origin: ORIGIN,
    room: ROOM,
    participant: {
      identity: { id: wallet.id },
      instanceId: sessionId,
      sessionId,
    },
  });
  const store = createSessionStore({ storage: memoryStorage() });
  await store.save(ORIGIN, record);

  const browser = fakeBrowser();
  const promise = resumeAIAuthSession({
    walletUrl: `${WALLET_ORIGIN}/`,
    origin: ORIGIN,
    room: ROOM,
    capabilities: ["presence.read"],
    windowObject: browser.win,
    sessionStore: store,
    resumeTimeoutMs: 1000,
    timeoutMs: 5000,
  });
  promise.catch(() => {});
  await browser.waitForHandler();
  await browser.fromWallet({ type: "ai-auth/connect-ready" });
  await browser.fromWallet({
    type: "ai-auth/session-resumed",
    sessionId,
    wallet: { id: wallet.id, name: wallet.name },
    consent: second,
  });
  const connection = await promise;
  try {
    assert.deepEqual(
      connection.consent,
      second,
      "the exact stored envelope is accepted regardless of the renewal chain",
    );
  } finally {
    connection.close();
  }
});

// ---- 03-04: Never has no resume age cap; a timed grant still expires -------

test("03-04 a Never grant older than seven days still resumes, an expired one does not", async () => {
  const wallet = await makeWallet();
  const never = await neverGrant(wallet);
  assert.equal(never.body.payload.expiresAt, null);
  const neverId = never.body.payload.requestNonce;
  const timed = await grant(wallet, { withAgent: false });
  const timedId = timed.body.payload.requestNonce;
  const backing = new Map();
  const store = createGrantStore({ adapter: memoryGrantAdapter({ backing }) });
  await store.save(never, { audience: ORIGIN, room: ROOM });
  await store.save(timed, { audience: ORIGIN, room: ROOM });
  const oldNow = never.body.payload.issuedAt + EIGHT_DAYS;

  assert.equal(
    await canResumeSession(
      never,
      resumeOpts(neverId, never, store, { now: oldNow }),
    ),
    true,
    "a Never grant has no resumable age cap",
  );
  assert.equal(
    await canResumeStoredSession(
      never,
      resumeOpts(neverId, never, store, { now: oldNow }),
    ),
    true,
    "the wallet's durable Never grant still confirms the resume",
  );
  assert.equal(
    await verifyStoredConsent(never, {
      origin: ORIGIN,
      walletId: wallet.id,
      room: ROOM,
      now: oldNow,
    }),
    true,
    "the site re-verification keeps a Never consent too",
  );
  assert.equal(
    await canResumeStoredSession(
      timed,
      resumeOpts(timedId, timed, store, { now: oldNow }),
    ),
    false,
    "a timed grant still cannot resume once expired",
  );
});

test("03-04 the site still offers a Never session record older than seven days", async () => {
  const wallet = await makeWallet();
  const never = await neverGrant(wallet);
  const record = recordFromConsent(never, {
    origin: ORIGIN,
    room: ROOM,
    participant: {
      identity: { id: wallet.id },
      instanceId: never.body.payload.requestNonce,
    },
  });
  const storage = memoryStorage();
  const store = createSessionStore({ storage });
  await store.save(ORIGIN, record);
  const found = await store.list(ORIGIN, {
    now: record.lastActivity + EIGHT_DAYS,
    room: ROOM,
  });
  assert.equal(found.length, 1, "an old Never record is still resumable");
});

// ---- app.js handler source extraction --------------------------------------

function extractHandler(source, needle) {
  const at = source.indexOf(needle);
  assert.ok(at >= 0, `app.js has no branch containing ${needle}`);
  let start = -1;
  for (const candidate of ["async (event) => {", "async () => {"]) {
    const found = source.lastIndexOf(candidate, at);
    if (found > start) start = found;
  }
  assert.ok(start >= 0, `no async handler before ${needle}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced app.js handler");
}

async function runRenewHandler(overrides = {}) {
  const source = await appSource();
  const wallet = await makeWallet();
  const original = await grant(wallet);
  const narrowed = await renew(wallet, original, ["presence.read"]);
  const sessionId = original.body.payload.requestNonce;
  const calls = [];
  const failures = [];
  const grantStore = {
    async save(consent, options) {
      calls.push({ call: "save", consent, options });
      if (overrides.saveThrows) throw new Error("IndexedDB unavailable");
    },
    async markEnded(audience, id) {
      calls.push({ call: "markEnded", audience, id });
    },
  };
  const externalHost = {
    postMessage(data, origin) {
      calls.push({ call: "post", data, origin });
    },
  };
  const state = {
    wallet,
    renewal: {
      nonce: "renew-nonce",
      capabilities: ["presence.read"],
      room: ROOM,
    },
    consent: original,
    externalRequest: { nonce: sessionId, room: ROOM },
    externalOrigin: ORIGIN,
    lease: { renew: () => true },
  };
  const sandbox = runFragment(
    `async function handler() { return (${extractHandler(
      source,
      "const renewal = state.renewal;",
    )})(); }`,
    {
      state,
      grantStore,
      externalHost,
      WALLET_REQUIRED_MESSAGE: "Create your wallet first, then connect.",
      externalSessionActive: () => true,
      approvePermissionRequest: async () => narrowed,
      defaultSessionTtl: () => 30 * MINUTE,
      sessionLimits: () => ({}),
      scheduleSessionExpiry() {},
      appendActivity: async () => {},
      render() {},
      fail(error) {
        failures.push(error);
      },
    },
  );
  await sandbox.handler();
  return { calls, failures, state, narrowed, sessionId };
}

// ---- WA-04: persist the renewed grant before telling the site --------------

test("WA-04 the renewed grant is saved before renew-consent is posted", async () => {
  const { calls, state, narrowed, sessionId } = await runRenewHandler();
  const save = calls.find((entry) => entry.call === "save");
  const post = calls.find((entry) => entry.call === "post");
  assert.ok(save, "the renewed grant is persisted");
  assert.ok(post, "the site is told about the renewal");
  assert.ok(
    calls.indexOf(save) < calls.indexOf(post),
    "persistence happens before the site is told",
  );
  assert.equal(save.options.requestNonce, sessionId, "the original id is used");
  assert.equal(post.data.type, "ai-auth/renew-consent");
  assert.deepEqual(post.data.consent, narrowed);
  assert.deepEqual(state.consent, narrowed, "the wallet advances its consent");
});

// ---- 03-05: a storage failure never blocks connect or renewal --------------

test("03-05 a grant-store failure still posts renewal and disables resume", async () => {
  const { calls, failures, sessionId } = await runRenewHandler({
    saveThrows: true,
  });
  assert.equal(
    failures.length,
    0,
    "a storage failure does not fail the renewal",
  );
  const post = calls.find((entry) => entry.call === "post");
  assert.ok(post, "the site is still told about the renewal");
  const ended = calls.find((entry) => entry.call === "markEnded");
  assert.ok(ended, "resume is disabled when the grant cannot be persisted");
  assert.equal(ended.id, sessionId, "the original session id is retired");
});

test("03-05 a grant-store failure on fresh connect still posts consent", async () => {
  const source = await appSource();
  const wallet = await makeWallet();
  const consent = await grant(wallet);
  const calls = [];
  const failures = [];
  const grantStore = {
    async save() {
      calls.push("save");
      throw new Error("IndexedDB unavailable");
    },
  };
  const externalHost = {
    postMessage(data) {
      calls.push(data.type);
    },
  };
  const event = {
    preventDefault() {},
    currentTarget: {
      querySelectorAll: () => CAPS.map((value) => ({ value })),
      querySelector: () => ({ value: "never" }),
    },
  };
  const state = {
    wallet,
    externalOrigin: ORIGIN,
    externalRequest: { nonce: "connect-nonce", version: 2, room: ROOM },
    externalStatus: null,
    externalSource: externalHost,
  };
  const sandbox = runFragment(
    `async function handler(event) { return (${extractHandler(
      source,
      "// Save the signed grant before the site is told",
    )})(event); }`,
    {
      state,
      event,
      grantStore,
      externalHost,
      WALLET_REQUIRED_MESSAGE: "Create your wallet first, then connect.",
      approvePermissionRequest: async () => consent,
      parseSessionTtl: (value) => (value === "never" ? null : Number(value)),
      pageInstanceId: "instance-1",
      SessionLease: class {
        constructor() {}
      },
      scheduleSessionExpiry() {},
      clearTimeout() {},
      startRoom: async () => {},
      toast() {},
      appendActivity: async () => {},
      render() {},
      fail(error) {
        failures.push(error);
      },
    },
  );
  await sandbox.handler(event);
  assert.equal(
    failures.length,
    0,
    "a storage failure does not fail the connect",
  );
  assert.deepEqual(calls, ["save", "ai-auth/connect-consent"]);
  assert.deepEqual(state.consent, consent, "the wallet advances its consent");
});
