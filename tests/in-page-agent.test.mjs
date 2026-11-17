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
  signEnvelope,
} from "../packages/p2p/index.js";
import { until } from "./helpers/wait.mjs";

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

async function makeVerifiedConnection(
  capabilities = ["presence.read", "tools.invoke"],
  walletClaim = true,
  { beforeConsent, roomSession, approveOptions } = {},
) {
  const realNow = Date.now;
  try {
    const wallet = await makeWallet("Research assistant");
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
    const dialog = {
      style: {},
      setAttribute() {},
      append() {},
      addEventListener() {},
      removeEventListener() {},
      showModal() {},
      close() {},
      remove() {
        popup.closed = true;
      },
    };
    const frame = { style: {}, contentWindow: popup };
    const button = { style: {}, setAttribute() {}, addEventListener() {} };
    const windowObject = {
      document: {
        body: { append() {} },
        createElement: (tag) =>
          tag === "dialog" ? dialog : tag === "iframe" ? frame : button,
      },
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
        await listener({
          source: popup,
          origin: "https://wallet.example",
          data,
        });
    };
    while (listeners.size === 0)
      await new Promise((resolve) => setImmediate(resolve));
    await dispatch({ type: "ai-auth/connect-ready" });
    const request = popupMessages[0].message.request;
    await beforeConsent?.(request);
    const consent = await approvePermissionRequest(
      wallet,
      request,
      capabilities,
      approveOptions,
    );
    await dispatch({
      type: "ai-auth/connect-consent",
      consent,
      wallet:
        walletClaim === true
          ? { id: wallet.id, name: "Research assistant" }
          : walletClaim,
    });
    const connection = await connectionPromise;
    if (roomSession)
      await dispatch({
        type: "ai-auth/room-ready",
        requestNonce: request.nonce,
        walletId: wallet.id,
        session: roomSession,
      });
    return {
      connection,
      popupMessages,
      wallet,
      dispatch,
    };
  } finally {
    Date.now = realNow;
  }
}

test("page connection lifecycle reports the verified wallet identity and capabilities", async () => {
  const { connection, wallet } = await makeVerifiedConnection();
  assert.deepEqual(connection.identity, {
    id: wallet.id,
    name: "Research assistant",
  });
  const events = [];
  const stop = connection.onLifecycle((event) => events.push(event));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "connected");
  assert.equal(events[0].label, "Research assistant");
  assert.deepEqual(events[0].identity, {
    id: wallet.id,
    name: "Research assistant",
  });
  assert.deepEqual(
    [...events[0].capabilities],
    ["presence.read", "tools.invoke"],
  );
  assert.equal(events[0].expiresAt, connection.consent.body.payload.expiresAt);

  connection.close();
  assert.deepEqual(events[1], { type: "disconnected", reason: "closed" });
  stop();

  // Subscribing after disconnection reports the terminal state immediately.
  const late = [];
  connection.onLifecycle((event) => late.push(event));
  assert.deepEqual(late, [{ type: "disconnected", reason: "closed" }]);
});

test("lifecycle rejects a wallet claim whose identity is not the consent issuer", async () => {
  const { connection, wallet } = await makeVerifiedConnection(
    ["presence.read"],
    { id: "agent:unrelated-issuer-identity", name: "Impostor" },
  );
  // The signed consent issuer stays authoritative; an unrelated display claim
  // must not become the verified identity or a trustable label.
  assert.equal(connection.identity.id, wallet.id);
  assert.equal(connection.identity.name, null);
  const events = [];
  connection.onLifecycle((event) => events.push(event));
  assert.equal(events[0].type, "connected");
  assert.match(events[0].label, /^Agent /u);
  assert.deepEqual(events[0].identity, { id: wallet.id, name: null });
  connection.close();
});

test("lifecycle fires an expired disconnect when the signed consent expires", async () => {
  const { connection } = await makeVerifiedConnection(["presence.read"], true, {
    approveOptions: { sessionTtlMs: 1_000 },
  });
  const events = [];
  connection.onLifecycle((event) => events.push(event));
  const expiresAt = connection.consent.body.payload.expiresAt;
  const realNow = Date.now;
  try {
    Date.now = () => expiresAt + 1;
    await until(() => events.at(-1)?.reason === "expired", {
      timeout: 3_000,
      message: "expired disconnect event",
    });
    assert.equal(events.at(-1)?.type, "disconnected");
    assert.equal(events.at(-1)?.reason, "expired");
  } finally {
    Date.now = realNow;
    connection.close();
  }
});

test("in-page agents require an explicit human authorization gate", async () => {
  const { connection } = await makeVerifiedConnection(["tools.invoke"]);
  await assert.rejects(
    mountAIAuthInPageAgent({ connection, actions: [] }),
    /explicit human authorization gate/u,
  );
  await assert.rejects(
    mountAIAuthInPageAgent({ connection, actions: [], authorize: "yes" }),
    /explicit human authorization gate/u,
  );
  connection.close();
});

test("in-page agent discovers WebMCP tools and runs only human-authorized actions", async () => {
  const { connection } = await makeVerifiedConnection(["tools.invoke"]);
  const registrations = [];
  const events = [];
  let executions = 0;
  const decisions = [];
  const api = await mountAIAuthInPageAgent({
    connection,
    modelContext: {
      registerTool(tool) {
        registrations.push(tool);
      },
    },
    actions: [
      {
        name: "workspace.read",
        description: "Read the current workspace.",
        inputSchema: { type: "object", properties: {} },
        requiredCapability: "tools.invoke",
        readOnly: true,
        execute: async () => {
          executions += 1;
          return { count: 3 };
        },
      },
    ],
    authorize: (action, input) => {
      decisions.push({ name: action.name, input });
      // The first decision is a human refusal; the second is approval.
      return decisions.length > 1;
    },
    publishAction: (event) => events.push(event),
  });
  assert.equal(api.webMcpAvailable, true);
  assert.deepEqual(api.tools, ["workspace.read"]);
  assert.equal(registrations.length, 1);

  const denied = await api.execute("workspace.read", { scope: "drafts" });
  assert.deepEqual(denied, {
    error: "This action needs explicit human approval",
  });
  assert.equal(executions, 0);
  assert.deepEqual(decisions, [
    { name: "workspace.read", input: { scope: "drafts" } },
  ]);
  assert.deepEqual(
    events.map(({ state }) => state),
    ["denied"],
  );
  assert.equal(events[0].name, "workspace.read");

  const approved = await api.execute("workspace.read");
  assert.deepEqual(approved, { count: 3 });
  assert.equal(executions, 1);
  assert.deepEqual(
    events.slice(1).map(({ state }) => state),
    ["started", "completed"],
  );

  // Stopping the agent aborts the WebMCP registration and blocks execution.
  api.stop();
  assert.equal(registrations.length, 1);
  assert.deepEqual(await api.execute("workspace.read"), {
    error: "This action is not approved for this page",
  });
  assert.equal(executions, 1);
  connection.close();
});

test("in-page agent keeps the JavaScript fallback when WebMCP is unavailable", async () => {
  const { connection, popupMessages } = await makeVerifiedConnection([
    "tools.invoke",
  ]);
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [
      {
        name: "summary.export",
        description: "Export a page summary.",
        inputSchema: { type: "object", properties: {} },
        requiredCapability: "tools.invoke",
        execute: async () => ({ ok: true }),
      },
    ],
    authorize: () => true,
  });
  assert.equal(api.webMcpAvailable, false);
  assert.deepEqual(await api.execute("summary.export"), { ok: true });
  // Default announcements travel the signed agent/action path through the
  // wallet, so peers observe the action lifecycle in the shared session.
  const announced = popupMessages.filter(
    ({ message }) => message.type === "ai-auth/site-action",
  );
  assert.deepEqual(
    announced.map(({ message }) => message.action.state),
    ["started", "completed"],
  );
  api.close();
  connection.close();
});

test("in-page agent scope is limited to wallet-approved capabilities", async () => {
  const { connection } = await makeVerifiedConnection(["presence.read"]);
  const registrations = [];
  const api = await mountAIAuthInPageAgent({
    connection,
    modelContext: {
      registerTool(tool) {
        registrations.push(tool);
      },
    },
    actions: [
      {
        name: "workspace.read",
        description: "Read the current workspace.",
        inputSchema: { type: "object", properties: {} },
        requiredCapability: "tools.invoke",
        execute: async () => ({ count: 3 }),
      },
    ],
    authorize: () => true,
  });
  assert.equal(api.webMcpAvailable, true);
  assert.deepEqual(api.tools, []);
  assert.equal(registrations.length, 0);
  assert.deepEqual(await api.execute("workspace.read"), {
    error: "This action is not approved for this page",
  });
  api.close();
  connection.close();
});

test("in-page agent stops an in-flight execution when the connection closes", async () => {
  const { connection } = await makeVerifiedConnection(["tools.invoke"]);
  let executionSignal;
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [
      {
        name: "long.report",
        description: "Build a long report.",
        inputSchema: { type: "object", properties: {} },
        requiredCapability: "tools.invoke",
        execute: async (input, { signal }) => {
          executionSignal = signal;
          if (signal.aborted) return "aborted";
          await new Promise((resolve) => {
            signal.addEventListener("abort", resolve, { once: true });
          });
          return "stopped";
        },
      },
    ],
    authorize: () => true,
    publishAction: async () => {},
  });
  const running = api.execute("long.report");
  while (!executionSignal)
    await new Promise((resolve) => setImmediate(resolve));
  api.stop();
  assert.equal(executionSignal.aborted, true);
  assert.deepEqual(await running, { error: "The site action was stopped" });
  assert.deepEqual(await api.execute("long.report"), {
    error: "This action is not approved for this page",
  });
  connection.close();
});

test("in-page agent registrations expire with the verified connection", async () => {
  const { connection } = await makeVerifiedConnection(["tools.invoke"], true, {
    approveOptions: { sessionTtlMs: 60_000, idleTimeoutMs: 60_000 },
  });
  const registrations = [];
  let executions = 0;
  const expiresAt = connection.consent.body.payload.expiresAt;
  const realNow = Date.now;
  let api;
  try {
    Date.now = () => expiresAt - 1;
    api = await mountAIAuthInPageAgent({
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
      authorize: () => true,
    });
    const registrationSignal = registrations[0].options.signal;
    assert.equal(registrationSignal.aborted, false);
    Date.now = () => expiresAt + 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
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

test("peer presence accepts a scroll fraction and rejects out-of-range values", async () => {
  const { connection, popupMessages, dispatch } = await makeVerifiedConnection([
    "presence.read",
  ]);
  connection.publishCursor({ x: 0.25, y: 0.5, scroll: 0.75 });
  const cursors = popupMessages.filter(
    ({ message }) => message.type === "ai-auth/site-cursor",
  );
  assert.deepEqual(cursors.at(-1).message.cursor, {
    x: 0.25,
    y: 0.5,
    visible: true,
    scroll: 0.75,
  });
  // An out-of-range scroll value is dropped; it never becomes a signed event.
  const before = popupMessages.length;
  connection.publishCursor({ x: 0.25, y: 0.5, scroll: 2 });
  assert.equal(popupMessages.length, before);

  // Inbound peer presence keeps the same bounds: a valid scroll fraction
  // passes, an invalid one is rejected before it reaches page listeners.
  const peer = await makeWallet("Peer agent");
  const peerSession = "peer-presence-session";
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await peer.sign("peer/hello", {
      label: "Peer agent",
      room: "research",
      origin: "https://site.example",
      session: peerSession,
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    }),
  });
  const received = [];
  const stop = connection.onEvent((envelope) => received.push(envelope));
  const sendPresence = (scroll) =>
    peer.sign("presence/cursor", {
      x: 0.4,
      y: 0.6,
      visible: true,
      ...(scroll === undefined ? {} : { scroll }),
      room: "research",
      origin: "https://site.example",
      session: peerSession,
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    });
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await sendPresence(0.9),
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].body.payload.scroll, 0.9);
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await sendPresence("page-content"),
  });
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await sendPresence(1.5),
  });
  assert.equal(received.length, 1, "invalid scroll payloads are rejected");
  connection.close();
  stop();
});

test("in-page agent discovers WebMCP tools, targets requests, and returns signed-wallet events", async () => {
  const { connection, wallet, popupMessages, dispatch } =
    await makeVerifiedConnection(["tools.invoke", "presence.read"], true, {
      roomSession: "wallet-room-session",
    });
  const executions = [];
  const webmcpTool = {
    name: "site.search",
    description: "Search public site records.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: { matches: { type: "number" } },
    },
    annotations: { readOnlyHint: true },
  };
  const peer = await makeWallet("Peer agent");
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await peer.sign("peer/hello", {
      label: "Peer agent",
      room: "research",
      origin: "https://site.example",
      session: "peer-session-123456",
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    }),
  });
  const api = await mountAIAuthInPageAgent({
    connection,
    modelContext: {
      getTools: () => [webmcpTool],
      executeTool: async (tool, input) => {
        executions.push({ name: tool.name, input });
        return JSON.stringify({ matches: 2 });
      },
    },
    authorize: (_action, input, context) => {
      assert.deepEqual(input, { query: "public" });
      assert.equal(context.requester.id, peer.id);
      return true;
    },
  });
  assert.equal(connection.walletSession, "wallet-room-session");
  const acceptedEvents = [];
  const stopMonitor = connection.onEvent((envelope) =>
    acceptedEvents.push(envelope),
  );

  assert.deepEqual(api.tools, ["site.search"]);
  const published = popupMessages.find(
    ({ message }) => message.type === "ai-auth/site-agent-event",
  );
  assert.deepEqual(published.message.event, {
    kind: "tool-catalog",
    tools: [
      {
        name: "site.search",
        description: "Search public site records.",
        inputSchema: webmcpTool.inputSchema,
        outputSchema: webmcpTool.outputSchema,
        annotations: {
          readOnlyHint: true,
          consequentialHint: false,
          untrustedContentHint: true,
        },
      },
    ],
  });

  const makeRequest = (targetSession) =>
    peer.sign("agent/action", {
      kind: "tool-request",
      requestId: "request-12345678",
      name: "site.search",
      input: { query: "public" },
      targetWallet: wallet.id,
      targetNonce: connection.request.nonce,
      targetSession,
      room: "research",
      origin: "https://site.example",
      session: "peer-session-123456",
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    });

  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await makeRequest("another-wallet-session"),
  });
  assert.equal(executions.length, 0, "requests for another tab are ignored");
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await makeRequest("wallet-room-session"),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    acceptedEvents.length,
    1,
    "the signed request reaches the site bridge",
  );
  assert.equal(
    acceptedEvents[0].body.payload.targetWallet,
    connection.identity.id,
  );
  assert.equal(
    acceptedEvents[0].body.payload.targetNonce,
    connection.request.nonce,
  );
  assert.equal(
    acceptedEvents[0].body.payload.targetSession,
    connection.walletSession,
  );
  assert.equal(api.tools.includes(acceptedEvents[0].body.payload.name), true);
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0], {
    name: "site.search",
    input: { query: "public" },
  });
  const response = popupMessages
    .filter(({ message }) => message.type === "ai-auth/site-agent-event")
    .map(({ message }) => message.event)
    .find((event) => event.kind === "tool-response");
  assert.deepEqual(response, {
    kind: "tool-response",
    requestId: "request-12345678",
    toWallet: peer.id,
    toSession: "peer-session-123456",
    result: { matches: 2 },
  });
  api.close();
  stopMonitor();
  connection.close();
});

test("in-page agent republishes its catalog before the signed catalog expires", async () => {
  const { connection, popupMessages } = await makeVerifiedConnection(
    ["tools.invoke"],
    true,
    { roomSession: "wallet-room-session" },
  );
  const api = await mountAIAuthInPageAgent({
    connection,
    modelContext: {
      getTools: () => [
        {
          name: "site.search",
          description: "Search public site records.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
      executeTool: async () => "{}",
    },
    authorize: () => true,
    catalogRefreshMs: 40,
  });
  const catalogs = () =>
    popupMessages.filter(
      ({ message }) =>
        message.type === "ai-auth/site-agent-event" &&
        message.event?.kind === "tool-catalog",
    ).length;
  const first = catalogs();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(
    catalogs() >= first + 2,
    "the catalog is announced again while connected",
  );
  api.close();
  const afterClose = catalogs();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(
    catalogs(),
    afterClose,
    "no announcements after the agent closes",
  );
  connection.close();
});

test("a tool cancellation only stops the matching signed requester", async () => {
  const { connection, wallet, dispatch } = await makeVerifiedConnection(
    ["tools.invoke"],
    true,
    { roomSession: "wallet-room-session" },
  );
  const requester = await makeWallet("Requesting agent");
  const unrelated = await makeWallet("Unrelated agent");
  let executionSignal;
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [
      {
        name: "site.long-task",
        description: "Run a cancellable site task.",
        inputSchema: { type: "object", properties: {} },
        requiredCapability: "tools.invoke",
        execute: async (_input, { signal }) => {
          executionSignal = signal;
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
          return "stopped";
        },
      },
    ],
    authorize: () => true,
    publishAction: async () => {},
  });
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await requester.sign("agent/action", {
      kind: "tool-catalog",
      tools: [],
      room: "research",
      origin: "https://site.example",
      session: "peer-session-123456",
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    }),
  });
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await unrelated.sign("agent/action", {
      kind: "tool-catalog",
      tools: [],
      room: "research",
      origin: "https://site.example",
      session: "unrelated-session",
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    }),
  });
  const makeEnvelope = (identity, kind, session = "peer-session-123456") =>
    identity.sign("agent/action", {
      kind,
      requestId: "request-12345678",
      ...(kind === "tool-request" ? { name: "site.long-task", input: {} } : {}),
      targetWallet: wallet.id,
      targetNonce: connection.request.nonce,
      targetSession: connection.walletSession,
      room: "research",
      origin: "https://site.example",
      session,
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    });

  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await makeEnvelope(requester, "tool-request"),
  });
  while (!executionSignal)
    await new Promise((resolve) => setImmediate(resolve));
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await makeEnvelope(unrelated, "tool-cancel", "unrelated-session"),
  });
  assert.equal(executionSignal.aborted, false);
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await makeEnvelope(
      requester,
      "tool-cancel",
      "different-session-987654",
    ),
  });
  assert.equal(executionSignal.aborted, false);
  await dispatch({
    type: "ai-auth/collaboration-event",
    envelope: await makeEnvelope(requester, "tool-cancel"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executionSignal.aborted, true);
  api.close();
  connection.close();
});

test("agent client discovers catalogs and accepts results only from the selected site wallet", async () => {
  const site = await makeWallet("Site wallet");
  const agent = await makeWallet("Agent wallet");
  const listeners = new Set();
  const sent = [];
  const room = {
    wallet: agent,
    session: "agent-room-session",
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(type, payload) {
      sent.push({ type, payload });
    },
  };
  const emit = (envelope) => {
    for (const listener of listeners) listener({ direction: "in", envelope });
  };
  const client = createAIAuthAgentClient(room);
  const catalogEnvelope = await site.sign("agent/action", {
    kind: "tool-catalog",
    tools: [
      {
        name: "site.search",
        description: "Search public site records.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    targetWallet: site.id,
    targetNonce: "target-page-nonce-123456789",
    targetSession: "site-room-session",
    room: "research",
    origin: "https://site.example",
    session: "site-room-session",
    nonce: randomNonce(),
    expiresAt: Date.now() + 30_000,
  });
  emit(catalogEnvelope);
  const [catalog] = client.catalogs;
  assert.equal(catalog.wallet, site.id);
  assert.equal(catalog.tools[0].name, "site.search");

  const pending = client.callTool(catalog, "site.search", { query: "hello" });
  assert.equal(sent[0].type, "agent/action");
  assert.deepEqual(sent[0].payload, {
    kind: "tool-request",
    requestId: sent[0].payload.requestId,
    name: "site.search",
    input: { query: "hello" },
    targetWallet: site.id,
    targetSession: "site-room-session",
    targetNonce: "target-page-nonce-123456789",
  });
  const otherWallet = await makeWallet("Unrelated peer");
  emit(
    await otherWallet.sign("agent/action", {
      kind: "tool-response",
      requestId: sent[0].payload.requestId,
      toWallet: agent.id,
      toSession: room.session,
      result: { matches: 999 },
      targetWallet: site.id,
      targetSession: "site-room-session",
      targetNonce: "target-page-nonce-123456789",
      room: "research",
      origin: "https://site.example",
      session: "site-room-session",
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    }),
  );
  emit(
    await site.sign("agent/action", {
      kind: "tool-response",
      requestId: sent[0].payload.requestId,
      toWallet: agent.id,
      toSession: room.session,
      result: { matches: 1 },
      targetWallet: site.id,
      targetSession: "site-room-session",
      targetNonce: "target-page-nonce-123456789",
      room: "research",
      origin: "https://site.example",
      session: "site-room-session",
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    }),
  );
  assert.deepEqual(await pending, { matches: 1 });
  client.close();
});

test("agent cancellation is sent after an in-flight request and rejects locally", async () => {
  const site = await makeWallet("Site wallet");
  const agent = await makeWallet("Agent wallet");
  const listeners = new Set();
  const sent = [];
  let releaseRequest;
  let deferRequest = true;
  const room = {
    wallet: agent,
    session: "agent-room-session",
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(type, payload) {
      sent.push({ type, payload });
      if (payload.kind === "tool-request" && deferRequest)
        return new Promise((resolve) => {
          releaseRequest = resolve;
        });
      return Promise.resolve();
    },
  };
  const emit = (envelope) => {
    for (const listener of listeners) listener({ direction: "in", envelope });
  };
  const client = createAIAuthAgentClient(room, { timeoutMs: 5 });
  emit(
    await site.sign("agent/action", {
      kind: "tool-catalog",
      tools: [
        {
          name: "site.search",
          description: "Search public site records.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      targetWallet: site.id,
      targetNonce: "target-page-nonce-123456789",
      targetSession: "site-room-session",
      room: "research",
      origin: "https://site.example",
      session: "site-room-session",
      nonce: randomNonce(),
      expiresAt: Date.now() + 30_000,
    }),
  );
  const [catalog] = client.catalogs;
  const controller = new AbortController();
  const result = client.callTool(
    catalog,
    "site.search",
    { query: "hello" },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  releaseRequest();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    sent.map(({ payload }) => payload.kind),
    ["tool-request", "tool-cancel"],
  );

  deferRequest = false;
  const timedOut = client.callTool(catalog, "site.search", {
    query: "timeout",
  });
  await assert.rejects(timedOut, /timed out/u);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    sent.slice(2).map(({ payload }) => payload.kind),
    ["tool-request", "tool-cancel"],
    "a local timeout also stops the action in the page",
  );

  deferRequest = true;
  const closed = client.callTool(catalog, "site.search", { query: "close" });
  client.close();
  await assert.rejects(closed, /closed/u);
  releaseRequest();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    sent.slice(4).map(({ payload }) => payload.kind),
    ["tool-request", "tool-cancel"],
    "closing the client also stops an action already running in the page",
  );
});

async function withClock(startAt, run) {
  const realNow = Date.now;
  let offset = 0;
  const base = startAt ?? realNow();
  Date.now = () => base + offset;
  try {
    await run((ms) => {
      offset += ms;
    });
  } finally {
    Date.now = realNow;
    for (const connection of closeAfter.splice(0)) connection.close();
  }
}

const closeAfter = [];
const waitFor = async (check) => {
  for (let tries = 0; tries < 200; tries += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not met");
};

test("a connection outlives the 2 minute handshake window and then expires", async () => {
  // An explicit 30 minute lifetime with the 10 minute idle timeout: the default
  // grant is Never and would not expire at all.
  const { connection, popupMessages } = await makeVerifiedConnection(
    ["presence.read", "tools.invoke"],
    true,
    {
      approveOptions: { sessionTtlMs: 30 * 60_000, idleTimeoutMs: 10 * 60_000 },
    },
  );
  closeAfter.push(connection);
  const events = [];
  connection.onLifecycle((event) => events.push(event));
  const payload = connection.consent.body.payload;
  assert.ok(payload.expiresAt - payload.issuedAt >= 15 * 60_000);
  const sentActions = () =>
    popupMessages.filter(
      ({ message }) => message.type === "ai-auth/site-action",
    );
  await withClock(payload.issuedAt, async (advance) => {
    for (let minute = 0; minute < 14; minute += 1) {
      advance(60_000);
      connection.publishAction({
        name: "work.step",
        state: "progress",
        summary: `minute ${minute + 1}`,
      });
    }
    assert.equal(sentActions().length, 14);
    advance(60_000 * 20);
    assert.throws(
      () =>
        connection.publishAction({
          name: "work.step",
          state: "progress",
          summary: "after expiry",
        }),
      /connection is closed/u,
    );
    assert.equal(sentActions().length, 14);
    assert.equal(events.at(-1).reason, "expired");
  });
});

test("an idle session stops authorizing publishes", async () => {
  const { connection } = await makeVerifiedConnection(["presence.read"], true, {
    approveOptions: { sessionTtlMs: 600_000, idleTimeoutMs: 120_000 },
  });
  closeAfter.push(connection);
  const events = [];
  connection.onLifecycle((event) => events.push(event));
  const issuedAt = connection.consent.body.payload.issuedAt;
  await withClock(issuedAt, async (advance) => {
    advance(100_000);
    connection.publishCursor({ x: 0.1, y: 0.1 });
    advance(100_000);
    connection.publishCursor({ x: 0.2, y: 0.2 });
    advance(125_000);
    connection.publishCursor({ x: 0.3, y: 0.3 });
    assert.deepEqual(events.at(-1), { type: "disconnected", reason: "idle" });
    await assert.rejects(connection.renew(), /no longer active/u);
  });
});

test("expired and ended sessions drop received events and transfers", async () => {
  const { connection, dispatch, popupMessages } = await makeVerifiedConnection(
    ["messages.send", "content.share"],
    true,
    { approveOptions: { sessionTtlMs: 600_000 } },
  );
  closeAfter.push(connection);
  const issuedAt = connection.consent.body.payload.issuedAt;
  const transfers = [];
  connection.transfers.subscribe((transfer) => transfers.push(transfer));
  await withClock(issuedAt, async (advance) => {
    await dispatch({
      type: "ai-auth/transfer-event",
      transfer: { type: "text", text: "hello" },
    });
    assert.equal(transfers.length, 1);
    advance(600_001);
    await dispatch({
      type: "ai-auth/transfer-event",
      transfer: { type: "text", text: "late" },
    });
    assert.equal(transfers.length, 1);
    await assert.rejects(
      connection.transfers.sendText("late"),
      /connection is closed/u,
    );
    assert.equal(
      popupMessages.some(
        ({ message }) => message.type === "ai-auth/transfer-request",
      ),
      false,
    );
  });
});

test("wallet ending the session revokes the connection", async () => {
  const { connection, dispatch } = await makeVerifiedConnection([
    "presence.read",
  ]);
  closeAfter.push(connection);
  const events = [];
  connection.onLifecycle((event) => events.push(event));
  await dispatch({ type: "ai-auth/session-ended", reason: "ended" });
  assert.deepEqual(events.at(-1), { type: "disconnected", reason: "revoked" });
  assert.throws(
    () =>
      connection.publishAction({ name: "a.b", state: "started", summary: "x" }),
    /connection is closed/u,
  );
});

test("renewal requires wallet re-consent and extends the same connection", async () => {
  const { connection, dispatch, popupMessages, wallet } =
    await makeVerifiedConnection(["presence.read", "tools.invoke"], true, {
      approveOptions: { sessionTtlMs: 60_000, idleTimeoutMs: 60_000 },
    });
  closeAfter.push(connection);
  const events = [];
  connection.onLifecycle((event) => events.push(event));
  const first = connection.consent;
  const firstExpiry = first.body.payload.expiresAt;
  await withClock(first.body.payload.issuedAt, async (advance) => {
    advance(50_000);
    const renewing = connection.renew();
    const message = await waitFor(
      () =>
        popupMessages.find(
          ({ message }) => message.type === "ai-auth/renew-request",
        )?.message,
    );
    assert.equal(message.request.renews, first.body.payload.requestNonce);
    assert.deepEqual(message.request.capabilities, [
      "presence.read",
      "tools.invoke",
    ]);
    // Nothing changes until the wallet approves.
    assert.equal(connection.expiresAt, firstExpiry);
    const renewal = await approvePermissionRequest(
      wallet,
      message.request,
      message.request.capabilities,
      { previousConsent: first, sessionTtlMs: 60_000 },
    );
    await dispatch({
      type: "ai-auth/renew-consent",
      requestNonce: message.request.nonce,
      consent: renewal,
    });
    await renewing;
    assert.ok(connection.expiresAt > firstExpiry);
    assert.equal(events.at(-1).type, "renewed");
    advance(30_000);
    connection.publishAction({
      name: "work.step",
      state: "started",
      summary: "ok",
    });
    // Replaying the same renewal consent does nothing.
    const before = connection.expiresAt;
    await dispatch({
      type: "ai-auth/renew-consent",
      requestNonce: message.request.nonce,
      consent: renewal,
    });
    assert.equal(connection.expiresAt, before);
  });
});

test("a renewal that widens scopes or comes from the wrong wallet is refused", async () => {
  const { connection, dispatch, popupMessages, wallet } =
    await makeVerifiedConnection(["presence.read"], true, {
      approveOptions: { sessionTtlMs: 60_000, idleTimeoutMs: 60_000 },
    });
  closeAfter.push(connection);
  const first = connection.consent;
  const firstExpiry = connection.expiresAt;
  const renewing = connection.renew();
  const request = (
    await waitFor(() =>
      popupMessages.find(
        ({ message }) => message.type === "ai-auth/renew-request",
      ),
    )
  ).message.request;
  const forged = await wallet.sign("connect/consent", {
    ...first.body.payload,
    requestNonce: request.nonce,
    renewsNonce: first.body.payload.requestNonce,
    challengeExpiresAt: request.expiresAt,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    capabilities: ["presence.read", "tools.invoke"],
  });
  await dispatch({
    type: "ai-auth/renew-consent",
    requestNonce: request.nonce,
    consent: forged,
  });
  await assert.rejects(renewing, /could not be verified/u);
  assert.equal(connection.expiresAt, firstExpiry);
  assert.deepEqual([...connection.capabilities], ["presence.read"]);

  const second = connection.renew();
  await dispatch({
    type: "ai-auth/renew-rejected",
    requestNonce: (
      await waitFor(
        () =>
          popupMessages
            .filter(({ message }) => message.type === "ai-auth/renew-request")
            .at(1)?.message.request,
      )
    ).nonce,
  });
  await assert.rejects(second, (error) => {
    // An explicit refusal says so, and says the current session still runs.
    assert.match(error.message, /declined/u);
    assert.match(error.message, /Your session is still active until /u);
    return true;
  });
  connection.close();
});
