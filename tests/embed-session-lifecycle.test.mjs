import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  approvePermissionRequest,
  createInstanceId,
  identityFor,
  signEnvelope,
} from "../packages/p2p/index.js";
import { connectAIAuthModal } from "../packages/p2p/embed.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const WALLET_ORIGIN = "https://wallet.example";
const ROOM = "research";
const CAPS = ["presence.read", "messages.send"];
const settle = () => new Promise((r) => setTimeout(r, 15));

// Wait for a condition with a bound instead of a fixed number of ticks.
async function waitFor(condition, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return true;
}

// Resolve to the rejection value, or a sentinel if the promise stays pending.
async function settleOutcome(promise, timeoutMs = 400) {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);
}

async function makeWallet(name = "Agent") {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const identity = { id, name, publicKey, privateKey: pair.privateKey };
  return {
    ...identity,
    sign: (type, payload) => signEnvelope(identity, type, payload),
  };
}

const AGENT = () => ({
  instanceId: createInstanceId(),
  agentType: "coding-agent",
  runtime: { name: "node", version: "22" },
  provider: "acme",
  model: "model-x",
});

// A fake browser that keeps node listeners so cancel/close and wallet
// messages exercise the real embed.js code path.
function fakeBrowser() {
  const windowHandlers = new Set();
  const sentToWallet = [];
  const dialogs = [];
  const popup = { postMessage: (data) => sentToWallet.push(data) };
  const createNode = (tag) => {
    const listeners = new Map();
    const node = {
      tag,
      style: {},
      open: false,
      setAttribute() {},
      append() {},
      remove() {},
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      dispatch(type, event = {}) {
        for (const fn of [...(listeners.get(type) ?? [])])
          fn({ preventDefault() {}, ...event });
      },
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
        this.dispatch("close");
      },
      ...(tag === "iframe" ? { contentWindow: popup } : {}),
    };
    if (tag === "dialog") dialogs.push(node);
    return node;
  };
  const document = {
    body: createNode("body"),
    activeElement: null,
    createElement: createNode,
  };
  const win = {
    document,
    addEventListener: (type, fn) =>
      type === "message" && windowHandlers.add(fn),
    removeEventListener: (type, fn) => windowHandlers.delete(fn),
  };
  const fromWallet = async (data, origin = WALLET_ORIGIN) => {
    for (const fn of [...windowHandlers])
      await fn({ source: popup, origin, data });
    await settle();
  };
  return {
    win,
    sentToWallet,
    fromWallet,
    dialogs,
    get dialog() {
      return dialogs.at(-1);
    },
    handlerCount: () => windowHandlers.size,
  };
}

async function startConnect(
  b,
  { caps = CAPS, timeoutMs = 5000, sessionTtlMs, idleTimeoutMs } = {},
) {
  const pending = connectAIAuthModal({
    walletUrl: `${WALLET_ORIGIN}/`,
    capabilities: caps,
    room: ROOM,
    origin: ORIGIN,
    windowObject: b.win,
    timeoutMs,
    ...(sessionTtlMs !== undefined ? { sessionTtlMs } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
  });
  pending.catch(() => {});
  const appeared = await waitFor(() => b.dialogs.length > 0);
  assert.ok(appeared, "the modal opens");
  await b.fromWallet({ type: "ai-auth/connect-ready" });
  const request = b.sentToWallet.find(
    (m) => m.type === "ai-auth/connect-request",
  ).request;
  return { pending, request };
}

async function approve(b, wallet, request, consentOptions = {}) {
  const consent = await approvePermissionRequest(
    wallet,
    request,
    request.capabilities,
    { agent: AGENT(), ...consentOptions },
  );
  await b.fromWallet({
    type: "ai-auth/connect-consent",
    requestNonce: request.nonce,
    consent,
    wallet: { id: wallet.id, name: wallet.name },
  });
  return consent;
}

// ---- C1-01 / 03-03: Never-grant expiry timer --------------------------------

test("C1-01: a Never grant does not arm a repeating 1ms expiry timer", async (t) => {
  const b = fakeBrowser();
  const wallet = await makeWallet();
  const timerSpy = t.mock.method(globalThis, "setTimeout");
  const { pending, request } = await startConnect(b);
  await approve(b, wallet, request); // no sessionTtlMs -> Never -> deadline null
  const connection = await pending;
  t.after(() => connection.close());

  timerSpy.mock.resetCalls();
  await new Promise((r) => setTimeout(r, 60));
  const fastTimers = timerSpy.mock.calls.filter((c) => c.arguments[1] === 1);
  assert.equal(
    fastTimers.length,
    0,
    "a null deadline must not re-arm a 1ms setTimeout forever",
  );
});

test("C1-01: a long deadline clamps the expiry delay to the setTimeout maximum", async (t) => {
  const b = fakeBrowser();
  const wallet = await makeWallet();
  const timerSpy = t.mock.method(globalThis, "setTimeout");
  const { pending, request } = await startConnect(b, {
    sessionTtlMs: 3_600_000,
    idleTimeoutMs: null,
  });
  await approve(b, wallet, request);
  const connection = await pending;
  t.after(() => connection.close());

  const expiryCall = timerSpy.mock.calls
    .filter((c) => c.arguments[1] > 100_000)
    .sort((a, b2) => b2.arguments[1] - a.arguments[1])[0];
  assert.ok(expiryCall, "an expiry timer was armed for the session lifetime");
  const scheduleExpiry = expiryCall.arguments[0];
  timerSpy.mock.resetCalls();

  // Move the deadline far beyond setTimeout's 32-bit signed maximum.
  const realNow = Date.now;
  t.mock.method(Date, "now", () => realNow() - 2_500_000_000);
  scheduleExpiry();
  const delays = timerSpy.mock.calls.map((c) => c.arguments[1]);
  assert.ok(
    delays.includes(2_147_483_647),
    `long waits must clamp to 2147483647ms, got ${JSON.stringify(delays)}`,
  );
});

// ---- C1-02: Escape during a renewal -----------------------------------------

async function connectedWithRenew(t) {
  const b = fakeBrowser();
  const wallet = await makeWallet();
  const { pending, request } = await startConnect(b);
  const consent = await approve(b, wallet, request);
  const connection = await pending;
  return { b, wallet, request, consent, connection };
}

async function startRenewal(b, connection) {
  const renewing = connection.renew();
  // The session may reject this renewal before the caller observes it; keep
  // the rejection handled while preserving the original promise to assert on.
  void renewing.catch(() => {});
  await waitFor(() =>
    b.sentToWallet.some((m) => m.type === "ai-auth/renew-request"),
  );
  return { renewing };
}

test("C1-02: Escape during a renewal declines only the renewal, not the session", async (t) => {
  const { b, connection } = await connectedWithRenew(t);
  t.after(() => connection.close());
  const disconnects = [];
  connection.onDisconnect(() => disconnects.push("disconnect"));

  const { renewing } = await startRenewal(b, connection);
  assert.equal(b.dialog.open, true, "renewal re-opens the dialog");

  b.dialog.dispatch("cancel"); // Escape / the modal Cancel button
  const outcome = await settleOutcome(renewing);
  assert.ok(outcome instanceof Error, "the renewal promise settles");
  assert.equal(outcome.code, "renewal-declined");
  assert.equal(b.dialog.open, false, "only the renewal dialog closes");
  assert.deepEqual(disconnects, [], "the active session is not disconnected");
  assert.doesNotThrow(() => connection.publishCursor({ x: 0.5, y: 0.5 }));
});

// ---- FX1-05: a second renew() while one is pending --------------------------

test("FX1-05 a rapid second renew() joins the pending renewal", async (t) => {
  const { b, connection } = await connectedWithRenew(t);
  t.after(() => connection.close());

  // Both calls start in the same tick, before the async challenge helper has
  // resolved and published the first pendingRenewal.
  const first = connection.renew();
  const second = connection.renew();
  void first.catch(() => {});
  void second.catch(() => {});
  await waitFor(() =>
    b.sentToWallet.some((m) => m.type === "ai-auth/renew-request"),
  );

  const outcome = await settleOutcome(second, 300);
  assert.equal(
    outcome,
    "timeout",
    `the second renew() must stay pending with the first, not fail: ${outcome}`,
  );
  assert.equal(
    b.sentToWallet.filter((m) => m.type === "ai-auth/renew-request").length,
    1,
    "only one renewal request is posted",
  );
});

// ---- C1-03: renew() must settle on close/expiry/revoke -----------------------

test("C1-03: closing the session rejects a pending renew() so Extend re-enables", async (t) => {
  const { b, connection } = await connectedWithRenew(t);
  const { renewing } = await startRenewal(b, connection);

  connection.close("closed");
  const outcome = await settleOutcome(renewing);
  assert.ok(
    outcome instanceof Error,
    "renew() rejects when the session closes",
  );
  assert.match(outcome.message, /clos|declin|end|active/u);
});

test("C1-03: a wallet-ended session also rejects a pending renew()", async (t) => {
  const { b, wallet, request, connection } = await connectedWithRenew(t);
  const { renewing } = await startRenewal(b, connection);

  await b.fromWallet({
    type: "ai-auth/session-ended",
    reason: "ended",
    requestNonce: request.nonce,
    walletId: wallet.id,
  });
  const outcome = await settleOutcome(renewing);
  assert.ok(
    outcome instanceof Error,
    "renew() rejects when the wallet ends it",
  );
});

// ---- C1-04: wallet-setup must re-arm the approval timeout --------------------

test("C1-04: abandoning wallet creation rejects the ready promise", async (t) => {
  const b = fakeBrowser();
  const { pending } = await startConnect(b, { timeoutMs: 120 });
  await b.fromWallet({ type: "ai-auth/wallet-setup" });

  const outcome = await settleOutcome(pending, 1000);
  assert.ok(
    outcome instanceof Error,
    "wallet-setup must re-arm a timeout that rejects an abandoned creation",
  );
  assert.match(outcome.message, /approval window/u);
});
