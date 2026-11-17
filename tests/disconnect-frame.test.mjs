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
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

async function makeWallet() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const wallet = {
    id,
    name: "Agent",
    publicKey,
    privateKey: pair.privateKey,
  };
  return {
    ...wallet,
    sign: (type, payload) => signEnvelope(wallet, type, payload),
  };
}

// Fake DOM in the shape of tests/embed-connect.test.mjs: the iframe exposes its
// contentWindow as the wallet popup, and the dialog records every remove() call
// so the test can observe exactly when the frame is torn down.
function fakeBrowser() {
  const handlers = new Set();
  const sentToWallet = [];
  const timeline = [];
  let dialogRemovals = 0;
  const popup = {
    postMessage: (data, targetOrigin) => {
      sentToWallet.push({ data, targetOrigin });
      timeline.push(`post:${data?.type}`);
    },
  };
  const node = (tag) => ({
    tag,
    style: {},
    setAttribute() {},
    append() {},
    remove() {
      if (tag === "dialog") {
        dialogRemovals += 1;
        timeline.push("dialog.remove");
      }
    },
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
  const fromWallet = async (data, origin = WALLET_ORIGIN) => {
    for (const fn of [...handlers]) await fn({ source: popup, origin, data });
    await settle();
  };
  return {
    win,
    sentToWallet,
    timeline,
    fromWallet,
    dialogRemovals: () => dialogRemovals,
    handlerCount: () => handlers.size,
  };
}

async function connected(b, wallet) {
  const pending = connectAIAuthModal({
    walletUrl: `${WALLET_ORIGIN}/`,
    origin: ORIGIN,
    room: ROOM,
    capabilities: CAPS,
    windowObject: b.win,
    timeoutMs: 5_000,
  });
  pending.catch(() => {});
  await settle();
  await b.fromWallet({ type: "ai-auth/connect-ready" });
  const request = b.sentToWallet.find(
    (entry) => entry.data?.type === "ai-auth/connect-request",
  ).data.request;
  const consent = await approvePermissionRequest(wallet, request, CAPS, {
    agent: {
      instanceId: createInstanceId(),
      agentType: "coding-agent",
      runtime: { name: "node", version: "22" },
      provider: "acme",
      model: "x",
    },
  });
  await b.fromWallet({
    type: "ai-auth/connect-consent",
    requestNonce: request.nonce,
    consent,
    wallet: { id: wallet.id, name: wallet.name },
  });
  return pending;
}

test("close keeps the wallet frame until session-ended reaches the wallet", async () => {
  const b = fakeBrowser();
  const connection = await connected(b, await makeWallet());
  try {
    connection.close("closed");

    // The frame must survive long enough for the posted message to be delivered.
    assert.equal(
      b.dialogRemovals(),
      0,
      "dialog.remove() is not called synchronously by close()",
    );

    const ended = b.sentToWallet.find(
      (entry) => entry.data?.type === "ai-auth/session-ended",
    );
    assert.ok(ended, "the wallet is told the session ended");
    assert.equal(ended.data.reason, "ended");
    assert.equal(ended.targetOrigin, WALLET_ORIGIN);

    // The teardown is only deferred by a short, bounded delay, never skipped.
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(
      b.dialogRemovals(),
      1,
      "the dialog/iframe is removed once the grace period elapses",
    );
    assert.ok(
      b.timeline.indexOf("post:ai-auth/session-ended") <
        b.timeline.indexOf("dialog.remove"),
      "session-ended is posted before the dialog/iframe is removed",
    );
  } finally {
    connection.close();
  }
});
