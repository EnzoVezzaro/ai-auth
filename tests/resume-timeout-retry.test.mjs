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
  createSessionStore,
  recordFromConsent,
} from "../packages/p2p/session-store.js";
import { resumeAIAuthSession } from "../packages/p2p/embed.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const ROOM = "research";
const CAPS = ["messages.send", "presence.read"];

// Poll a condition with a deadline instead of assuming a fixed tick.
async function until(check, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error("condition not met before deadline");
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
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
      await fn({ source: popup, origin: "https://wallet.example", data });
  };
  return { win, sentToWallet, fromWallet, handlerCount: () => handlers.size };
}

async function seeded() {
  const store = createSessionStore({ storage: memoryStorage() });
  const wallet = await makeWallet();
  const instanceId = createInstanceId();
  const request = await createPermissionRequest(ORIGIN, CAPS, {
    room: ROOM,
    sessionTtlMs: 30 * 60_000,
    idleTimeoutMs: 10 * 60_000,
  });
  const consent = await approvePermissionRequest(wallet, request, CAPS, {
    agent: {
      instanceId,
      agentType: "coding-agent",
      runtime: { name: "node", version: "22" },
      provider: "acme",
      model: "x",
    },
  });
  const record = recordFromConsent(consent, {
    origin: ORIGIN,
    room: ROOM,
    participant: {
      identity: { id: wallet.id },
      instanceId,
      sessionId: consent.body.payload.requestNonce,
    },
  });
  await store.save(ORIGIN, record);
  return { store, wallet, record };
}

const options = (store, browser, extra = {}) => ({
  walletUrl: "https://wallet.example/",
  origin: ORIGIN,
  room: ROOM,
  capabilities: CAPS,
  windowObject: browser.win,
  sessionStore: store,
  resumeTimeoutMs: 30,
  timeoutMs: 1000,
  ...extra,
});

test("a resume timeout keeps the saved session and offers a retry", async () => {
  const { store, record } = await seeded();
  const browser = fakeBrowser();
  let failure;
  const pending = resumeAIAuthSession(options(store, browser)).catch(
    (error) => (failure = error),
  );
  await until(() => browser.handlerCount() > 0);
  await browser.fromWallet({ type: "ai-auth/connect-ready" });
  await until(() => failure);
  await pending;

  assert.match(
    failure.message,
    /try again|Resume/u,
    "the timeout tells the person they can resume again",
  );
  assert.equal(
    (await store.list(ORIGIN)).length,
    1,
    "a timeout must not delete the saved session",
  );

  // The retained record really is resumable on a second attempt.
  const retryBrowser = fakeBrowser();
  const retry = resumeAIAuthSession(options(store, retryBrowser));
  await until(() => retryBrowser.handlerCount() > 0);
  await retryBrowser.fromWallet({ type: "ai-auth/connect-ready" });
  await until(() =>
    retryBrowser.sentToWallet.some((m) => m.type === "ai-auth/session-resume"),
  );
  await retryBrowser.fromWallet({
    type: "ai-auth/session-resumed",
    sessionId: record.sessionId,
    wallet: { id: record.walletId, name: "Agent" },
    consent: record.consent,
  });
  const connection = await until(() => retry.then((value) => value || false));
  assert.ok(connection, "the retained record resumes on retry");
  connection.close();
});
