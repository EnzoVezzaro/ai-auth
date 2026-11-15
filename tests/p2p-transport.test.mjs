import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  approvePermissionRequest,
  connectAIAuthPopup,
  createSharedRoomTopic,
  identityFor,
  NostrWebRTC,
  P2PRoom,
  registerAIAuthPageActions,
  signEnvelope,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

test("site wallets share the default public space and isolate explicit spaces", async () => {
  const first = await createSharedRoomTopic("https://site.example", "default");
  const sameSite = await createSharedRoomTopic(
    "https://site.example",
    "default",
  );
  const anotherSite = await createSharedRoomTopic(
    "https://other.example",
    "default",
  );
  const anotherSpace = await createSharedRoomTopic(
    "https://site.example",
    "design-team",
  );

  assert.equal(first, sameSite);
  assert.notEqual(first, anotherSite);
  assert.notEqual(first, anotherSpace);
});

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

async function makeVerifiedConnection(capabilities = ["tools.invoke"]) {
  const wallet = await makeWallet("Test site wallet");
  const listeners = new Set();
  const popupMessages = [];
  const popup = {
    closed: false,
    location: {},
    postMessage(message, targetOrigin) {
      popupMessages.push({ message, targetOrigin });
    },
    close() {
      this.closed = true;
    },
  };
  const windowObject = {
    open: () => popup,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const connectionPromise = connectAIAuthPopup({
    walletUrl: "https://wallet.example/",
    capabilities,
    room: "research",
    origin: "https://site.example",
    timeoutMs: 1000,
    windowObject,
  });
  const dispatch = async (data) => {
    for (const listener of listeners)
      await listener({ source: popup, origin: "https://wallet.example", data });
  };
  while (listeners.size === 0)
    await new Promise((resolve) => setImmediate(resolve));
  await dispatch({ type: "ai-auth/connect-ready" });
  const request = popupMessages[0].message.request;
  const consent = await approvePermissionRequest(wallet, request, capabilities);
  await dispatch({ type: "ai-auth/connect-consent", consent });
  return connectionPromise;
}

test("Nostr adapter subscribes with Trystero 0.27 methods and forwards signed events", async () => {
  let messageHandler;
  let peerJoined;
  let peerLeft;
  let transportError;
  let roomListener;
  let left = false;
  let sent = [];
  const coreRoom = {
    origin: "https://site.example",
    room: "research",
    wallet: { name: "Agent" },
    privateMode: false,
    capabilities: null,
    async start() {},
    async send(type) {
      sent.push(type);
    },
    async receive(envelope, source) {
      this.received = { envelope, source };
      return true;
    },
    subscribe(listener) {
      roomListener = listener;
      return () => {
        roomListener = null;
      };
    },
  };
  const transport = {
    makeAction() {
      return {
        onMessage(handler) {
          messageHandler = handler;
          return () => {
            messageHandler = null;
          };
        },
        async send(envelope) {
          sent.push(envelope);
        },
      };
    },
    onPeerJoin(handler) {
      peerJoined = handler;
      return () => {
        peerJoined = null;
      };
    },
    onPeerLeave(handler) {
      peerLeft = handler;
      return () => {
        peerLeft = null;
      };
    },
    onError(handler) {
      transportError = handler;
      return () => {
        transportError = null;
      };
    },
    getPeers: () => ({ peer: {} }),
    async leave() {
      left = true;
    },
  };
  const adapter = new NostrWebRTC(coreRoom, {
    joinRoom: (_config, topic, ...extra) => {
      assert.equal(
        extra.length,
        0,
        "Trystero 0.27 joinRoom accepts two arguments",
      );
      assert.deepEqual(_config.turnConfig, []);
      assert.match(topic, /^ai-auth-v1-[0-9a-f]{64}$/u);
      return transport;
    },
  });
  await adapter.start();
  assert.equal(typeof peerJoined, "function");
  assert.equal(typeof peerLeft, "function");

  const outbound = {
    body: {
      type: "message/text",
      payload: { expiresAt: Date.now() + 30_000 },
    },
  };
  roomListener({ direction: "out", envelope: outbound });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!sent.includes(outbound), "events wait for a direct peer");

  peerJoined({ peerId: "peer" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sent.includes("peer/hello"));
  assert.ok(
    sent.includes(outbound),
    "queued events flush after peer activation",
  );
  assert.ok(sent.includes("Connected to agent peers") === false);

  const envelope = { body: { type: "message/text" }, proof: {} };
  messageHandler(envelope, { peerId: "peer" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coreRoom.received.envelope, envelope);
  assert.equal(coreRoom.received.source.peerId, "peer");

  await adapter.close();
  assert.equal(left, true);
  assert.equal(messageHandler, null);
  assert.equal(peerJoined, null);
  assert.equal(peerLeft, null);
  assert.equal(transportError, null);
});

test("P2P room capability scopes block unapproved send and receive events", async () => {
  const sender = await makeWallet("Sender");
  const receiver = await makeWallet("Receiver");
  const options = {
    origin: "https://site.example",
    capabilities: ["presence.read"],
  };
  const receivingRoom = new P2PRoom(receiver, "research", options);
  const message = await sender.sign("message/text", {
    text: "not approved",
    room: "research",
    origin: options.origin,
    session: crypto.randomUUID(),
    nonce: "a".repeat(32),
    expiresAt: Date.now() + 30_000,
  });
  assert.equal(await receivingRoom.receive(message), false);
  await assert.rejects(
    receivingRoom.send("message/text", { text: "not approved" }),
    /did not approve messages.send/u,
  );
  await receivingRoom.close();
});

test("WebMCP registers only consented actions and signs action lifecycle events", async () => {
  const connection = await makeVerifiedConnection(["tools.invoke"]);
  const registrations = [];
  const events = [];
  const modelContext = {
    registerTool(tool, options) {
      registrations.push({ tool, options });
    },
  };
  const api = await registerAIAuthPageActions({
    connection,
    modelContext,
    actions: [
      {
        name: "workspace.read",
        description: "Read the current workspace.",
        inputSchema: { type: "object", properties: {} },
        requiredCapability: "tools.invoke",
        readOnly: true,
        execute: async () => ({ count: 3 }),
      },
    ],
    publishAction: (event) => events.push(event),
  });
  assert.equal(api.webMcpAvailable, true);
  assert.deepEqual(api.tools, ["workspace.read"]);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].tool.annotations.readOnlyHint, true);
  assert.ok(registrations[0].options.signal instanceof AbortSignal);
  assert.deepEqual(await api.execute("workspace.read"), { count: 3 });
  assert.deepEqual(
    events.map(({ state }) => state),
    ["started", "completed"],
  );
  assert.deepEqual(await api.execute("presence.read"), {
    error: "This action is not approved for this page",
  });
  connection.close();
  assert.equal(registrations[0].options.signal.aborted, true);
  assert.deepEqual(await api.execute("workspace.read"), {
    error: "This action is not approved for this page",
  });
  api.close();
});

test("WebMCP JavaScript fallback hides action and transport secrets", async () => {
  const connection = await makeVerifiedConnection(["tools.invoke"]);
  const events = [];
  const api = await registerAIAuthPageActions({
    connection,
    actions: [
      {
        name: "workspace.read",
        description: "Read the current workspace.",
        inputSchema: { type: "object", properties: {} },
        requiredCapability: "tools.invoke",
        execute: async () => {
          throw new Error("Bearer private-action-token");
        },
      },
    ],
    publishAction: async (event) => {
      events.push(event);
      if (event.state === "failed")
        throw new Error("Bearer private-transport-token");
    },
  });

  assert.equal(api.webMcpAvailable, false);
  assert.deepEqual(api.tools, ["workspace.read"]);
  assert.deepEqual(await api.execute("workspace.read"), {
    error: "This page action failed. Check the site for details.",
  });
  assert.deepEqual(
    events.map(({ state }) => state),
    ["started", "failed"],
  );
  api.close();
  connection.close();
});

test("WebMCP tools require tools.invoke even when presence is approved", async () => {
  const connection = await makeVerifiedConnection(["presence.read"]);
  const registrations = [];
  const modelContext = {
    registerTool(tool) {
      registrations.push(tool);
    },
  };
  const api = await registerAIAuthPageActions({
    connection,
    modelContext,
    actions: [
      {
        name: "workspace.delete",
        description: "Delete a workspace.",
        inputSchema: { type: "object", properties: {} },
        requiredCapability: "tools.invoke",
        execute: async () => ({ deleted: true }),
      },
    ],
  });

  await assert.rejects(
    registerAIAuthPageActions({
      connection: {
        capabilities: ["tools.invoke"],
        consent: { body: { payload: { capabilities: ["tools.invoke"] } } },
      },
      actions: [],
    }),
    /verified, active AI Auth wallet connection/u,
  );
  assert.deepEqual(api.tools, []);
  assert.equal(registrations.length, 0);
  assert.deepEqual(await api.execute("workspace.delete"), {
    error: "This action is not approved for this page",
  });
  api.close();
  connection.close();
  const toolsConnection = await makeVerifiedConnection(["tools.invoke"]);
  await assert.rejects(
    registerAIAuthPageActions({
      connection: toolsConnection,
      actions: [
        {
          name: "workspace.delete",
          description: "Delete a workspace.",
          inputSchema: { type: "object", properties: {} },
          requiredCapability: "presence.read",
          execute: async () => ({ deleted: true }),
        },
      ],
    }),
    /tools\.invoke capability/u,
  );
  toolsConnection.close();
});

test("WebMCP registration expires with its verified wallet connection", async () => {
  const connection = await makeVerifiedConnection(["tools.invoke"]);
  const registrations = [];
  let executions = 0;
  const modelContext = {
    registerTool(tool, options) {
      registrations.push({ tool, options });
    },
  };
  const realNow = Date.now;
  const expiresAt = connection.consent.body.payload.expiresAt;
  let api;
  try {
    Date.now = () => expiresAt - 1;
    api = await registerAIAuthPageActions({
      connection,
      modelContext,
      actions: [
        {
          name: "workspace.read",
          description: "Read the current workspace.",
          inputSchema: { type: "object", properties: {} },
          requiredCapability: "tools.invoke",
          execute: async () => {
            executions += 1;
            return { ok: true };
          },
        },
      ],
    });
    const registrationSignal = registrations[0].options.signal;
    assert.equal(registrationSignal.aborted, false);

    Date.now = () => expiresAt + 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(registrationSignal.aborted, true);
    assert.deepEqual(await api.execute("workspace.read"), {
      error: "This action is not approved for this page",
    });
    assert.equal(executions, 0);
  } finally {
    Date.now = realNow;
    api?.close();
    connection.close();
  }
});

test("WebMCP does not execute if the wallet closes while publishing starts", async () => {
  const connection = await makeVerifiedConnection(["tools.invoke"]);
  const registrations = [];
  let releasePublish;
  let executions = 0;
  const publishStarted = new Promise((resolve) => {
    releasePublish = resolve;
  });
  const api = await registerAIAuthPageActions({
    connection,
    modelContext: {
      registerTool(tool, options) {
        registrations.push({ tool, options });
      },
    },
    actions: [
      {
        name: "workspace.read",
        description: "Read the current workspace.",
        inputSchema: { type: "object", properties: {} },
        requiredCapability: "tools.invoke",
        execute: async () => {
          executions += 1;
          return { ok: true };
        },
      },
    ],
    publishAction: async () => {
      releasePublish();
      await new Promise((resolve) => setImmediate(resolve));
    },
  });

  const execution = api.execute("workspace.read");
  await publishStarted;
  connection.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await execution, {
    error: "This action is not approved for this page",
  });
  assert.equal(executions, 0);
  assert.equal(registrations[0].options.signal.aborted, true);
  api.close();
});

test("popup connection timeout is cleared after signed consent", async () => {
  const wallet = await makeWallet("Popup wallet");
  const listeners = new Set();
  const popupMessages = [];
  const popup = {
    closed: false,
    location: {},
    postMessage(message, targetOrigin) {
      popupMessages.push({ message, targetOrigin });
    },
    close() {
      this.closed = true;
    },
  };
  const windowObject = {
    open: () => popup,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const connectionPromise = connectAIAuthPopup({
    walletUrl: "https://wallet.example/",
    capabilities: ["presence.read"],
    room: "research",
    origin: "https://site.example",
    timeoutMs: 1000,
    windowObject,
  });
  const dispatch = async (data) => {
    for (const listener of listeners)
      await listener({ source: popup, origin: "https://wallet.example", data });
  };
  while (listeners.size === 0)
    await new Promise((resolve) => setImmediate(resolve));
  await dispatch({ type: "ai-auth/connect-ready" });
  const request = popupMessages[0].message.request;
  const consent = await approvePermissionRequest(wallet, request, [
    "presence.read",
  ]);
  await dispatch({ type: "ai-auth/connect-consent", consent });
  const connection = await connectionPromise;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(
    popup.closed,
    false,
    "an active connection outlives its setup timeout",
  );
  assert.equal(
    listeners.size,
    1,
    "collaboration events remain subscribed after approval",
  );
  connection.close();
  assert.equal(popup.closed, true);
  assert.equal(listeners.size, 0);
});

test("verified popup connections close when their signed consent expires", async () => {
  const wallet = await makeWallet("Expiring popup wallet");
  const listeners = new Set();
  const popupMessages = [];
  const popup = {
    closed: false,
    location: {},
    postMessage(message, targetOrigin) {
      popupMessages.push({ message, targetOrigin });
    },
    close() {
      this.closed = true;
    },
  };
  const windowObject = {
    open: () => popup,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const connectionPromise = connectAIAuthPopup({
    walletUrl: "https://wallet.example/",
    capabilities: ["presence.read"],
    origin: "https://site.example",
    timeoutMs: 1000,
    windowObject,
  });
  const dispatch = async (data) => {
    for (const listener of listeners)
      await listener({ source: popup, origin: "https://wallet.example", data });
  };
  while (listeners.size === 0)
    await new Promise((resolve) => setImmediate(resolve));
  await dispatch({ type: "ai-auth/connect-ready" });
  const request = popupMessages[0].message.request;
  const consent = await approvePermissionRequest(wallet, request, [
    "presence.read",
  ]);
  const expiresAt = consent.body.payload.expiresAt;
  const realNow = Date.now;
  let connection;
  try {
    Date.now = () => expiresAt - 1;
    await dispatch({ type: "ai-auth/connect-consent", consent });
    connection = await connectionPromise;
    assert.equal(popup.closed, false);
    assert.equal(listeners.size, 1);

    Date.now = () => expiresAt + 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(popup.closed, true);
    assert.equal(listeners.size, 0);
    assert.throws(
      () =>
        connection.publishAction({
          name: "expired.action",
          state: "started",
          summary: "expired",
        }),
      /connection is closed/u,
    );
  } finally {
    Date.now = realNow;
    connection?.close();
  }
});
