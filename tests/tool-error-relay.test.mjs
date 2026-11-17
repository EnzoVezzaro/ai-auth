// End-to-end check that a site-side invalid-input failure keeps its machine
// code through the wallet's signed tool-response relay and reaches the agent
// as TOOL_UNAVAILABLE (not the generic DENIED).
import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  approvePermissionRequest,
  connectAIAuthPopup,
  createAIAuthAgentClient,
  identityFor,
  mountAIAuthInPageAgent,
  randomNonce,
  registerAIAuthPageActions,
  signEnvelope,
} from "../packages/p2p/index.js";
import { TOOL_ERROR_CODES } from "../packages/p2p/webmcp.js";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

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

async function verifiedConnection() {
  const wallet = await makeWallet("Research assistant");
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
  return { connection: await connectionPromise, popupMessages };
}

test("invalid input keeps TOOL_UNAVAILABLE across the wallet relay to the agent", async (t) => {
  const { connection } = await verifiedConnection();
  t.after(() => connection.close());
  const api = await registerAIAuthPageActions({
    actions: [
      {
        name: "site.strict",
        description: "Needs a string query",
        requiredCapability: "tools.invoke",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
        execute: async (input) => ({ echoed: input.q }),
      },
    ],
    connection,
    authorize: async () => true,
    modelContext: null,
  });

  // 1. Site: the real execute() path returns a typed failure for bad input.
  const failure = await api.execute("site.strict", { q: 42 });
  assert.equal(api.isFailure(failure), true);
  assert.equal(typeof failure.error, "string");
  assert.equal(failure.code, TOOL_ERROR_CODES.TOOL_UNAVAILABLE);

  // 2. Wallet relay: the real app.js handler signs the code onto the wire.
  let relayed;
  const relay = runFragment(
    extractFunction(await appSource(), "handleExternalSiteEvent"),
    {
      TextEncoder,
      debug: () => {},
      filterCatalogTools: (tools) => tools,
      externalSessionActive: () => true,
      state: {
        externalRequest: {},
        consent: { body: { payload: { capabilities: ["tools.invoke"] } } },
        room: {
          send: async (type, payload, options) => {
            relayed = { type, payload, options };
          },
        },
        wallet: { name: "Wallet" },
      },
    },
  );
  await relay.handleExternalSiteEvent({
    type: "ai-auth/site-agent-event",
    event: {
      kind: "tool-response",
      requestId: "request-12345678",
      toWallet: "agent:requester-123456789",
      toSession: "agent-session-1",
      error: failure.error,
      code: failure.code,
    },
  });
  assert.equal(relayed?.type, "agent/action");
  assert.equal(relayed.payload.code, TOOL_ERROR_CODES.TOOL_UNAVAILABLE);

  // 3. Agent: the real agent client maps the relayed code onto the rejection.
  const listeners = new Set();
  let agentRequestId = null;
  const agentRoom = {
    wallet: { id: "agent:requester-123456789", name: "Requester" },
    session: "agent-session-1",
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async send(_type, payload) {
      if (payload?.kind === "tool-request") agentRequestId = payload.requestId;
    },
  };
  const emit = (payload) => {
    for (const listener of [...listeners])
      listener({
        direction: "in",
        envelope: {
          body: {
            type: "agent/action",
            issuer: connection.identity.id,
            payload,
          },
        },
      });
  };
  const client = createAIAuthAgentClient(agentRoom);
  t.after(() => client.close());
  emit({
    kind: "tool-catalog",
    targetWallet: connection.identity.id,
    targetSession: "site-room-session",
    targetNonce: "target-nonce-1234567890",
    session: "site-room-session",
    expiresAt: Date.now() + 60_000,
    tools: [
      {
        name: "site.strict",
        description: "Needs a string query",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
      },
    ],
  });
  const catalog = client.catalogs.find(
    (c) => c.wallet === connection.identity.id,
  );
  assert.ok(catalog, "the site catalog is live on the agent side");
  const pending = client.callTool(catalog, "site.strict", { q: 42 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(agentRequestId, "the agent sent a tool request");
  emit({
    kind: "tool-response",
    requestId: agentRequestId,
    toWallet: agentRoom.wallet.id,
    toSession: agentRoom.session,
    targetWallet: connection.identity.id,
    targetSession: "site-room-session",
    targetNonce: "target-nonce-1234567890",
    error: relayed.payload.error,
    ...(typeof relayed.payload.code === "string"
      ? { code: relayed.payload.code }
      : {}),
  });
  await assert.rejects(
    pending,
    (error) => error.code === TOOL_ERROR_CODES.TOOL_UNAVAILABLE,
  );
});
