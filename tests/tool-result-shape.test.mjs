// A site tool that returns `undefined` must be reported as an empty success,
// not as a failure with a TOOL_UNAVAILABLE error.
import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  approvePermissionRequest,
  connectAIAuthPopup,
  identityFor,
  mountAIAuthInPageAgent,
  randomNonce,
  signEnvelope,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

async function makeWallet(name) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const id = await identityFor(publicKey);
  return {
    id,
    name,
    publicKey,
    privateKey: keys.privateKey,
    sign: (type, payload) =>
      signEnvelope(
        { id, publicKey, privateKey: keys.privateKey },
        type,
        payload,
      ),
  };
}

async function connected() {
  const wallet = await makeWallet("Wallet");
  const listeners = new Set();
  const popupMessages = [];
  const popup = {
    closed: false,
    location: {},
    postMessage(message) {
      popupMessages.push({ message });
    },
    close() {
      this.closed = true;
    },
  };
  const dialog = {
    style: {},
    setAttribute() {},
    append() {},
    addEventListener() {},
    removeEventListener() {},
    showModal() {},
    close() {},
    remove() {},
  };
  const windowObject = {
    document: {
      body: { append() {} },
      createElement: (tag) =>
        tag === "dialog"
          ? dialog
          : tag === "iframe"
            ? { style: {}, contentWindow: popup }
            : { style: {}, setAttribute() {}, addEventListener() {} },
    },
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  };
  const connectionPromise = connectAIAuthPopup({
    walletUrl: "https://wallet.example/",
    capabilities: ["tools.invoke"],
    room: "research",
    origin: "https://site.example",
    timeoutMs: 1000,
    windowObject,
  });
  while (listeners.size === 0)
    await new Promise((resolve) => setImmediate(resolve));
  const dispatch = async (data) => {
    for (const listener of [...listeners])
      await listener({ source: popup, origin: "https://wallet.example", data });
  };
  await dispatch({ type: "ai-auth/connect-ready" });
  const request = popupMessages[0].message.request;
  const consent = await approvePermissionRequest(wallet, request, [
    "tools.invoke",
  ]);
  await dispatch({
    type: "ai-auth/connect-consent",
    consent,
    wallet: { id: wallet.id, name: wallet.name },
  });
  return {
    connection: await connectionPromise,
    popupMessages,
    wallet,
    dispatch,
  };
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};

test("void tool result is an empty success on the signed response path", async (t) => {
  const { connection, popupMessages, wallet, dispatch } = await connected();
  t.after(() => connection.close());
  const api = await mountAIAuthInPageAgent({
    connection,
    modelContext: null,
    actions: [
      {
        name: "site.void",
        description: "Returns nothing",
        requiredCapability: "tools.invoke",
        inputSchema: { type: "object", properties: {} },
        execute: async () => undefined,
      },
    ],
    authorize: async () => true,
  });
  t.after(() => api.close());
  const peer = await makeWallet("Peer");
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await peer.sign("agent/action", {
      kind: "tool-request",
      requestId: "request-void-1234567",
      name: "site.void",
      input: {},
      targetWallet: wallet.id,
      targetNonce: connection.request.nonce,
      targetSession: connection.walletSession,
      room: "research",
      origin: "https://site.example",
      session: "peer-session-123456",
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    }),
  });
  await until(() =>
    popupMessages.some(
      ({ message }) =>
        message.type === "ai-auth/site-agent-event" &&
        message.event?.kind === "tool-response",
    ),
  );
  const response = popupMessages.find(
    ({ message }) =>
      message.type === "ai-auth/site-agent-event" &&
      message.event?.kind === "tool-response",
  ).message.event;
  assert.equal(response.error, undefined, "a void result is not an error");
  assert.ok(
    Object.hasOwn(response, "result"),
    "a void result still carries a result field",
  );
  assert.deepEqual(response.result, null, "void maps to empty JSON success");
});
