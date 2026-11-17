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
import { connectAIAuthModal } from "../packages/p2p/embed.js";
import { canResumeStoredSession } from "../packages/p2p/resume-verification.js";
import {
  createGrantStore,
  memoryGrantAdapter,
} from "../packages/p2p/grant-store.js";
import {
  appSource,
  extractFunction,
  extractIfContaining,
  runFragment,
} from "./helpers/app-source.mjs";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const WALLET_ORIGIN = "https://wallet.example";
const ROOM = "research";
const CAPS = ["presence.read", "messages.send"];
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

async function makeGrant(wallet) {
  const request = await createPermissionRequest(ORIGIN, CAPS, {
    room: ROOM,
    expiresInMs: 120_000,
    sessionTtlMs: 30 * MINUTE,
    idleTimeoutMs: 10 * MINUTE,
  });
  const consent = await approvePermissionRequest(wallet, request, CAPS, {
    agent: {
      instanceId: createInstanceId(),
      agentType: "coding-agent",
      runtime: { name: "node", version: "22" },
      provider: "acme",
      model: "x",
    },
  });
  return consent;
}

// A popup that records both the payload and the exact target origin, so a "*"
// wildcard cannot slip through unnoticed.
function browser() {
  const handlers = new Set();
  const sent = [];
  const popup = {
    postMessage: (data, targetOrigin) => sent.push({ data, targetOrigin }),
  };
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
  return {
    win,
    sent,
    fromWallet: async (data) => {
      for (const fn of [...handlers])
        await fn({ source: popup, origin: WALLET_ORIGIN, data });
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    waitForHandler: async () => {
      for (let i = 0; i < 100 && handlers.size === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(handlers.size > 0, "the wallet listener is registered");
    },
  };
}

async function completeConnect(page, wallet) {
  const pending = connectAIAuthModal({
    walletUrl: `${WALLET_ORIGIN}/`,
    origin: ORIGIN,
    room: ROOM,
    capabilities: CAPS,
    windowObject: page.win,
    timeoutMs: 5_000,
  });
  pending.catch(() => {});
  await page.waitForHandler();
  await page.fromWallet({ type: "ai-auth/connect-ready" });
  const request = page.sent.find(
    (entry) => entry.data?.type === "ai-auth/connect-request",
  );
  assert.ok(request, "the site asks the wallet for consent");
  const consent = await approvePermissionRequest(
    wallet,
    request.data.request,
    CAPS,
    {
      agent: {
        instanceId: createInstanceId(),
        agentType: "coding-agent",
        runtime: { name: "node", version: "22" },
        provider: "acme",
        model: "x",
      },
    },
  );
  await page.fromWallet({
    type: "ai-auth/connect-consent",
    consent,
    wallet: { id: wallet.id, name: wallet.name },
  });
  return pending;
}

test("a site close tells the wallet the session ended at the exact wallet origin", async () => {
  const page = browser();
  const connection = await completeConnect(page, await makeWallet());
  try {
    connection.close("closed");
    const ended = page.sent.find(
      (entry) => entry.data?.type === "ai-auth/session-ended",
    );
    assert.ok(ended, "the wallet is told the site ended the session");
    assert.equal(ended.data.reason, "ended");
    assert.equal(ended.targetOrigin, WALLET_ORIGIN);
  } finally {
    connection.close();
  }
});

test("a revoked site close also revokes at the wallet", async () => {
  const page = browser();
  const connection = await completeConnect(page, await makeWallet());
  try {
    connection.close("revoked");
    const ended = page.sent.find(
      (entry) => entry.data?.type === "ai-auth/session-ended",
    );
    assert.ok(ended, "a revoked session is reported to the wallet");
    assert.equal(ended.data.reason, "ended");
    assert.equal(ended.targetOrigin, WALLET_ORIGIN);
  } finally {
    connection.close();
  }
});

test("the wallet records a site-ended session and can no longer resume it", async () => {
  const wallet = await makeWallet();
  const consent = await makeGrant(wallet);
  const sessionId = consent.body.payload.requestNonce;
  const source = await appSource();
  const backing = new Map();
  const grantStore = createGrantStore({
    adapter: memoryGrantAdapter({ backing }),
  });
  await grantStore.save(consent, { audience: ORIGIN, room: ROOM });
  const externalHost = { postMessage() {} };
  const sandbox = runFragment(
    [
      extractFunction(source, "markSessionEnded"),
      extractFunction(source, "expireExternalSession"),
      `async function handle(event) { ${extractIfContaining(
        source,
        'event.data?.type === "ai-auth/session-ended"',
      )} }`,
    ].join("\n"),
    {
      grantStore,
      externalHost,
      roomGeneration: 0,
      clearTimeout() {},
      render() {},
      state: {
        consent,
        externalStatus: "sent",
        externalSource: externalHost,
        externalOrigin: ORIGIN,
        externalRequest: { audience: ORIGIN },
        externalPendingEvents: [],
        lease: { revoke() {} },
        transfers: { close() {} },
        rtc: { close() {} },
      },
    },
  );

  // This is the payload embed.js posts when the site calls close("closed").
  await sandbox.handle({
    source: externalHost,
    origin: ORIGIN,
    data: { type: "ai-auth/session-ended", reason: "ended" },
  });
  const record = await grantStore.get(ORIGIN, sessionId);
  assert.equal(record.ended, true, "the wallet flips the durable ended flag");
  assert.equal(
    await canResumeStoredSession(consent, {
      audience: ORIGIN,
      sessionId,
      room: ROOM,
      walletId: wallet.id,
      store: createGrantStore({ adapter: memoryGrantAdapter({ backing }) }),
      now: Date.now(),
    }),
    false,
    "a site-ended session cannot be resumed",
  );
});

test("a session-ended message from another source or origin is ignored", async () => {
  const wallet = await makeWallet();
  const consent = await makeGrant(wallet);
  const source = await appSource();
  const backing = new Map();
  const grantStore = createGrantStore({
    adapter: memoryGrantAdapter({ backing }),
  });
  const sessionId = consent.body.payload.requestNonce;
  await grantStore.save(consent, { audience: ORIGIN, room: ROOM });
  const sandbox = runFragment(
    [
      extractFunction(source, "markSessionEnded"),
      `async function handle(event) { ${extractIfContaining(
        source,
        'event.data?.type === "ai-auth/session-ended"',
      )} }`,
    ].join("\n"),
    {
      grantStore,
      externalHost: "opener",
      state: {
        consent,
        externalOrigin: ORIGIN,
        externalRequest: { audience: ORIGIN },
      },
    },
  );
  const data = { type: "ai-auth/session-ended", reason: "ended" };
  await sandbox.handle({ source: "other-window", origin: ORIGIN, data });
  await sandbox.handle({
    source: "opener",
    origin: "https://evil.example",
    data,
  });
  assert.equal(
    (await grantStore.get(ORIGIN, sessionId)).ended,
    false,
    "untrusted session-ended messages do not flip the durable ended flag",
  );
});
