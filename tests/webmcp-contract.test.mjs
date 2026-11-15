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

globalThis.crypto ??= webcrypto;

const SITE_ORIGIN = "https://site.example";
const ROOM = "research";
const PEER_SESSION = "peer-session-123456";
const WALLET_SESSION = "wallet-room-session";

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

function makeFakeWindow() {
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
  const dispatch = async (data) => {
    for (const listener of [...listeners])
      await listener({ source: popup, origin: "https://wallet.example", data });
  };
  return { windowObject, popupMessages, listeners, dispatch };
}

const roomReady = (connection, session) => ({
  type: "ai-auth/room-ready",
  requestNonce: connection.request.nonce,
  walletId: connection.identity.id,
  session,
});

// Connects a site to a wallet-approved page connection. With `roomSession`,
// the wallet reports the room as ready before the helper returns. Callers
// must close the returned connection (use t.after).
async function makeVerifiedConnection(
  capabilities = ["tools.invoke"],
  { roomSession } = {},
) {
  const wallet = await makeWallet("Research assistant");
  const { windowObject, popupMessages, listeners, dispatch } = makeFakeWindow();
  const connectionPromise = connectAIAuthPopup({
    walletUrl: "https://wallet.example/",
    capabilities,
    room: ROOM,
    origin: SITE_ORIGIN,
    timeoutMs: 1000,
    windowObject,
  });
  while (listeners.size === 0)
    await new Promise((resolve) => setImmediate(resolve));
  await dispatch({ type: "ai-auth/connect-ready" });
  const request = popupMessages[0].message.request;
  const consent = await approvePermissionRequest(wallet, request, capabilities);
  await dispatch({
    type: "ai-auth/connect-consent",
    consent,
    wallet: { id: wallet.id, name: "Research assistant" },
  });
  const connection = await connectionPromise;
  if (roomSession) await dispatch(roomReady(connection, roomSession));
  return { connection, popupMessages, wallet, dispatch };
}

const collaboration = (envelope) => ({
  type: "ai-auth/collaboration-event",
  envelope,
});

// A signed peer request or cancel, targeted at this page connection.
async function peerEnvelope(
  peer,
  connection,
  {
    kind = "tool-request",
    requestId = "request-12345678",
    name = "site.count",
    input = {},
    session = PEER_SESSION,
  } = {},
) {
  return peer.sign("agent/action", {
    kind,
    requestId,
    ...(kind === "tool-request" ? { name, input } : {}),
    targetWallet: connection.identity.id,
    targetNonce: connection.request.nonce,
    targetSession: connection.walletSession,
    room: ROOM,
    origin: SITE_ORIGIN,
    session,
    nonce: randomNonce(),
    expiresAt: Date.now() + 30_000,
  });
}

function countAction(counter, overrides = {}) {
  return {
    name: "site.count",
    description: "Count public records.",
    inputSchema: { type: "object", properties: {} },
    requiredCapability: "tools.invoke",
    execute: async () => {
      counter.runs += 1;
      return { count: counter.runs };
    },
    ...overrides,
  };
}

const waitingAction = (name, executionRef) => ({
  name,
  description: "Wait until cancelled.",
  inputSchema: { type: "object", properties: {} },
  requiredCapability: "tools.invoke",
  execute: async (_input, { signal }) => {
    executionRef.signal = signal;
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    return "late result";
  },
});

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function messagesOf(popupMessages, type) {
  return popupMessages
    .map(({ message }) => message)
    .filter((message) => message.type === type);
}

function agentEventsOf(popupMessages, kind) {
  return messagesOf(popupMessages, "ai-auth/site-agent-event")
    .map(({ event }) => event)
    .filter((event) => event.kind === kind);
}

const catalogsIn = (popupMessages) =>
  agentEventsOf(popupMessages, "tool-catalog");
const responsesIn = (popupMessages) =>
  agentEventsOf(popupMessages, "tool-response");
const catalogNames = (popupMessages) =>
  catalogsIn(popupMessages).map((catalog) =>
    catalog.tools.map((tool) => tool.name),
  );
// A fake agent-side room: `sent` records outgoing frames, `emit` delivers an
// incoming envelope to the client, and `transmit` (optional) carries each
// outgoing frame to the site as a signed envelope.
function makeAgentRoom(agent, transmit = async () => {}) {
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
      await transmit(type, payload);
    },
  };
  const emit = (envelope) => {
    for (const listener of [...listeners])
      listener({ direction: "in", envelope });
  };
  return { room, sent, emit };
}

async function siteCatalog(
  site,
  tools,
  {
    targetNonce = "target-page-nonce-123456789",
    session = "site-room-session",
  } = {},
) {
  return site.sign("agent/action", {
    kind: "tool-catalog",
    tools,
    targetWallet: site.id,
    targetNonce,
    targetSession: session,
    room: ROOM,
    origin: SITE_ORIGIN,
    session,
    nonce: randomNonce(),
    expiresAt: Date.now() + 30_000,
  });
}

const emptyTool = (name) => ({
  name,
  description: "Read public data.",
  inputSchema: { type: "object", properties: {} },
});

test("the tool catalog is advertised again after reconnecting to a new room", async (t) => {
  const counter = { runs: 0 };
  const first = await makeVerifiedConnection(["tools.invoke"]);
  const firstApi = await mountAIAuthInPageAgent({
    connection: first.connection,
    actions: [countAction(counter)],
    authorize: () => true,
  });
  t.after(() => {
    firstApi.close();
    first.connection.close();
  });
  assert.deepEqual(catalogNames(first.popupMessages), []);
  await first.dispatch(roomReady(first.connection, "room-session-one"));
  assert.deepEqual(catalogNames(first.popupMessages), [["site.count"]]);
  firstApi.close();
  first.connection.close();

  const second = await makeVerifiedConnection(["tools.invoke"]);
  const secondApi = await mountAIAuthInPageAgent({
    connection: second.connection,
    actions: [countAction(counter)],
    authorize: () => true,
  });
  t.after(() => {
    secondApi.close();
    second.connection.close();
  });
  await second.dispatch(roomReady(second.connection, "room-session-two"));
  assert.deepEqual(catalogNames(second.popupMessages), [["site.count"]]);
});

test("a peer joining the room triggers a fresh tool catalog", async (t) => {
  const { connection, popupMessages, dispatch } = await makeVerifiedConnection(
    ["presence.read", "tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [countAction({ runs: 0 })],
    authorize: () => true,
  });
  t.after(() => api.close());
  assert.equal(catalogsIn(popupMessages).length, 1);
  const peer = await makeWallet("Peer agent");
  await dispatch(
    collaboration(
      await peer.sign("peer/hello", {
        label: "Peer agent",
        origin: SITE_ORIGIN,
        room: ROOM,
        session: PEER_SESSION,
        nonce: randomNonce(),
        expiresAt: Date.now() + 30_000,
      }),
    ),
  );
  assert.deepEqual(catalogNames(popupMessages), [
    ["site.count"],
    ["site.count"],
  ]);
});

test("a repeated request ID is ignored and the action runs exactly once", async (t) => {
  const { connection, dispatch } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const peer = await makeWallet("Peer agent");
  const counter = { runs: 0 };
  let decisions = 0;
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [countAction(counter)],
    authorize: () => {
      decisions += 1;
      return true;
    },
    publishAction: async () => {},
  });
  t.after(() => api.close());
  const first = await peerEnvelope(peer, connection, {
    requestId: "dup-request-1234",
  });
  await dispatch(collaboration(first));
  await waitFor(() => counter.runs === 1, "the first request to run");
  // A new envelope (fresh nonce) reusing the request ID must be ignored.
  await dispatch(
    collaboration(
      await peerEnvelope(peer, connection, { requestId: "dup-request-1234" }),
    ),
  );
  // Replaying the identical signed envelope is dropped by the nonce guard.
  await dispatch(collaboration(first));
  await settle();
  assert.equal(counter.runs, 1);
  assert.equal(decisions, 1);
});

test("peers without tools.invoke cannot reach a site action even with a valid signature", async (t) => {
  const { connection, dispatch, popupMessages } = await makeVerifiedConnection(
    ["presence.read"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const peer = await makeWallet("Peer agent");
  const counter = { runs: 0 };
  let decisions = 0;
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [countAction(counter)],
    authorize: () => {
      decisions += 1;
      return true;
    },
    publishAction: async () => {},
  });
  t.after(() => api.close());
  assert.deepEqual(api.tools, []);
  assert.deepEqual(catalogsIn(popupMessages), []);
  await dispatch(
    collaboration(
      await peerEnvelope(peer, connection, { requestId: "no-cap-request-1" }),
    ),
  );
  await settle();
  assert.equal(counter.runs, 0);
  assert.equal(decisions, 0);
});

test("with the capability, each peer still needs its own human approval", async (t) => {
  const { connection, dispatch } = await makeVerifiedConnection(
    ["presence.read", "tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const trusted = await makeWallet("Trusted peer");
  const stranger = await makeWallet("Stranger peer");
  const counter = { runs: 0 };
  const requesters = [];
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [countAction(counter)],
    authorize: (_action, _input, context) => {
      requesters.push(context.requester.id);
      return context.requester.id === trusted.id;
    },
    publishAction: async () => {},
  });
  t.after(() => api.close());
  await dispatch(
    collaboration(
      await peerEnvelope(stranger, connection, {
        requestId: "stranger-req-01",
      }),
    ),
  );
  await settle();
  assert.equal(counter.runs, 0, "a peer the human refused does not run");
  await dispatch(
    collaboration(
      await peerEnvelope(trusted, connection, { requestId: "trusted-req-01" }),
    ),
  );
  await waitFor(() => counter.runs === 1, "the approved peer to run");
  assert.deepEqual(requesters, [stranger.id, trusted.id]);
});

test("catalogs are capped at 32 tools", async (t) => {
  const counter = { runs: 0 };
  const actions = Array.from({ length: 40 }, (_, index) =>
    countAction(counter, { name: `site.tool-${index}` }),
  );
  const { connection, popupMessages } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const api = await mountAIAuthInPageAgent({
    connection,
    actions,
    authorize: () => true,
  });
  t.after(() => api.close());
  assert.equal(api.tools.length, 32);
  const [catalog] = catalogsIn(popupMessages);
  assert.equal(catalog.tools.length, 32);
  assert.equal(catalog.tools[0].name, "site.tool-0");
});

test("catalog descriptions are truncated and oversized names are rejected", async (t) => {
  const { connection, popupMessages } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [
      countAction(
        { runs: 0 },
        { name: "site.long", description: `  ${"x".repeat(300)}  ` },
      ),
    ],
    authorize: () => true,
  });
  t.after(() => api.close());
  const [tool] = catalogsIn(popupMessages)[0].tools;
  assert.equal(tool.description.length, 240);

  const other = await makeVerifiedConnection(["tools.invoke"]);
  t.after(() => other.connection.close());
  await assert.rejects(
    mountAIAuthInPageAgent({
      connection: other.connection,
      actions: [countAction({ runs: 0 }, { name: `site.${"a".repeat(60)}` })],
      authorize: () => true,
    }),
    /Page actions need a name/u,
  );
});

test(
  "an oversized input schema does not silence the rest of the catalog",
  {
    todo: "BUG: one oversized schema throws while the catalog is built, so no tools are advertised",
  },
  async (t) => {
    const counter = { runs: 0 };
    // The room becomes ready after mounting: a room that is already ready
    // makes the mount itself throw (see the leak note in the report).
    const { connection, popupMessages, dispatch } =
      await makeVerifiedConnection(["tools.invoke"]);
    t.after(() => connection.close());
    const oversized = {
      type: "object",
      properties: { blob: { type: "string", description: "x".repeat(5_000) } },
    };
    const api = await mountAIAuthInPageAgent({
      connection,
      actions: [
        countAction(counter, { name: "site.big", inputSchema: oversized }),
        countAction(counter),
      ],
      authorize: () => true,
    });
    t.after(() => api.close());
    await dispatch(roomReady(connection, WALLET_SESSION));
    assert.deepEqual(catalogNames(popupMessages), [["site.count"]]);
  },
);

test(
  "discovered WebMCP tool names peers cannot route are not advertised",
  {
    todo: "BUG: discovered tool names skip the wire name rule, so unroutable names are advertised",
  },
  async (t) => {
    const { connection } = await makeVerifiedConnection(["tools.invoke"], {
      roomSession: WALLET_SESSION,
    });
    t.after(() => connection.close());
    const api = await mountAIAuthInPageAgent({
      connection,
      modelContext: {
        getTools: () => [emptyTool("Site Search")],
        executeTool: async () => "{}",
      },
      authorize: () => true,
    });
    t.after(() => api.close());
    assert.deepEqual(api.tools, []);
  },
);

test("the agent client drops catalogs above the 32-tool bound", async (t) => {
  const site = await makeWallet("Site wallet");
  const agent = await makeWallet("Agent wallet");
  const { room, emit } = makeAgentRoom(agent);
  const client = createAIAuthAgentClient(room);
  t.after(() => client.close());
  const tools = Array.from({ length: 33 }, (_, index) =>
    emptyTool(`site.t${index}`),
  );
  emit(await siteCatalog(site, tools));
  assert.equal(client.catalogs.length, 0);
});

test("the agent client refuses requests above the shared-room size limit", async (t) => {
  const site = await makeWallet("Site wallet");
  const agent = await makeWallet("Agent wallet");
  const { room, sent, emit } = makeAgentRoom(agent);
  const client = createAIAuthAgentClient(room);
  t.after(() => client.close());
  emit(await siteCatalog(site, [emptyTool("site.search")]));
  const [catalog] = client.catalogs;
  await assert.rejects(
    client.callTool(catalog, "site.search", { blob: "x".repeat(9_000) }),
    /size limit/u,
  );
  assert.equal(sent.length, 0, "nothing is sent for an oversized request");
});

test(
  "an oversized tool in a received catalog is dropped instead of thrown",
  {
    todo: "BUG: an oversized tool in a received catalog throws out of the room listener",
  },
  async (t) => {
    const site = await makeWallet("Site wallet");
    const agent = await makeWallet("Agent wallet");
    const { room, emit } = makeAgentRoom(agent);
    const client = createAIAuthAgentClient(room);
    t.after(() => client.close());
    const oversized = {
      name: "site.big",
      description: "Too large.",
      inputSchema: {
        type: "object",
        properties: {
          blob: { type: "string", description: "x".repeat(5_000) },
        },
      },
    };
    const envelope = await siteCatalog(site, [oversized]);
    assert.doesNotThrow(() => emit(envelope));
    assert.equal(client.catalogs.length, 0);
  },
);

test("actions default to not read-only and every action still needs approval", async (t) => {
  const registrations = [];
  const counter = { runs: 0 };
  const decisions = [];
  const { connection } = await makeVerifiedConnection(["tools.invoke"]);
  t.after(() => connection.close());
  const api = await mountAIAuthInPageAgent({
    connection,
    modelContext: {
      registerTool(tool) {
        registrations.push(tool);
      },
    },
    actions: [
      countAction(counter, { name: "site.write" }),
      countAction(counter, { name: "site.read", readOnly: true }),
    ],
    authorize: (action) => {
      decisions.push(action.name);
      // A void decision is not consent.
      return undefined;
    },
    publishAction: async () => {},
  });
  t.after(() => api.close());
  assert.deepEqual(
    registrations.map((tool) => [tool.name, tool.annotations.readOnlyHint]),
    [
      ["site.write", false],
      ["site.read", true],
    ],
  );
  assert.deepEqual(await api.execute("site.write"), {
    error: "This action needs explicit human approval",
  });
  assert.deepEqual(await api.execute("site.read"), {
    error: "This action needs explicit human approval",
  });
  assert.equal(counter.runs, 0);
  assert.deepEqual(decisions, ["site.write", "site.read"]);
});

test("a throwing approval gate denies the action", async (t) => {
  const counter = { runs: 0 };
  const { connection } = await makeVerifiedConnection(["tools.invoke"]);
  t.after(() => connection.close());
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [countAction(counter)],
    authorize: () => {
      throw new Error("approval prompt crashed");
    },
    publishAction: async () => {},
  });
  t.after(() => api.close());
  assert.equal(
    (await api.execute("site.count")).error,
    "This action needs explicit human approval",
  );
  assert.equal(counter.runs, 0);
});

test(
  "registerAIAuthPageActions refuses to run actions without an approval gate",
  {
    todo: "BUG: registerAIAuthPageActions runs actions with no human approval when authorize is omitted",
  },
  async (t) => {
    const counter = { runs: 0 };
    const { connection } = await makeVerifiedConnection(["tools.invoke"]);
    t.after(() => connection.close());
    const api = await registerAIAuthPageActions({
      connection,
      actions: [countAction(counter)],
    });
    t.after(() => api.close());
    const result = await api.execute("site.count");
    assert.ok(result.error, "an action without approval must not succeed");
    assert.equal(counter.runs, 0);
  },
);

test("a failed action publishes failed and does not leak its error", async (t) => {
  const { connection } = await makeVerifiedConnection(["tools.invoke"]);
  t.after(() => connection.close());
  const states = [];
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [
      countAction(
        { runs: 0 },
        {
          name: "site.broken",
          execute: async () => {
            throw new Error("database password is hunter2");
          },
        },
      ),
    ],
    authorize: () => true,
    publishAction: (event) => states.push(event.state),
  });
  t.after(() => api.close());
  const result = await api.execute("site.broken");
  assert.deepEqual(result, {
    error: "This page action failed. Check the site for details.",
  });
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
  assert.deepEqual(states, ["started", "failed"]);
});

test("a requester's cancellation publishes cancelled, never completed", async (t) => {
  const { connection, dispatch } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const peer = await makeWallet("Peer agent");
  const states = [];
  const executionRef = {};
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [waitingAction("site.wait", executionRef)],
    authorize: () => true,
    publishAction: (event) => states.push(event.state),
  });
  t.after(() => api.close());
  await dispatch(
    collaboration(
      await peerEnvelope(peer, connection, {
        requestId: "cancel-request-1",
        name: "site.wait",
      }),
    ),
  );
  await waitFor(() => executionRef.signal, "the action to start");
  await dispatch(
    collaboration(
      await peerEnvelope(peer, connection, {
        kind: "tool-cancel",
        requestId: "cancel-request-1",
      }),
    ),
  );
  await waitFor(() => states.includes("cancelled"), "a cancelled event");
  assert.equal(executionRef.signal.aborted, true);
  assert.deepEqual(states, ["started", "cancelled"]);
});

test("aborting a running action through its signal publishes cancelled", async (t) => {
  const { connection } = await makeVerifiedConnection(["tools.invoke"]);
  t.after(() => connection.close());
  const states = [];
  const executionRef = {};
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [waitingAction("site.wait", executionRef)],
    authorize: () => true,
    publishAction: (event) => states.push(event.state),
  });
  t.after(() => api.close());
  const controller = new AbortController();
  const running = api.execute("site.wait", {}, { signal: controller.signal });
  await waitFor(() => executionRef.signal, "the action to start");
  controller.abort();
  assert.deepEqual(await running, { error: "The site action was stopped" });
  assert.deepEqual(states, ["started", "cancelled"]);
});

test("an agent timeout cancels the site action, which reports cancelled", async (t) => {
  const { connection, wallet, dispatch } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const agent = await makeWallet("Agent wallet");
  const states = [];
  const executionRef = {};
  // Carries each outgoing agent frame to the site as a signed envelope.
  const transmit = async (type, payload) =>
    dispatch(
      collaboration(
        await agent.sign(type, {
          ...payload,
          room: ROOM,
          origin: SITE_ORIGIN,
          session: PEER_SESSION,
          nonce: randomNonce(),
          expiresAt: Date.now() + 30_000,
        }),
      ),
    );
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [waitingAction("site.wait", executionRef)],
    authorize: () => true,
    publishAction: (event) => states.push(event.state),
  });
  t.after(() => api.close());
  const { room, sent, emit } = makeAgentRoom(agent, transmit);
  const client = createAIAuthAgentClient(room, { timeoutMs: 20 });
  t.after(() => client.close());
  emit(
    await siteCatalog(wallet, [emptyTool("site.wait")], {
      targetNonce: connection.request.nonce,
      session: WALLET_SESSION,
    }),
  );
  const [target] = client.catalogs;
  await assert.rejects(client.callTool(target, "site.wait", {}), /timed out/u);
  await waitFor(() => states.includes("cancelled"), "a cancelled event");
  assert.deepEqual(
    sent.map(({ payload }) => payload.kind),
    ["tool-request", "tool-cancel"],
  );
  assert.equal(executionRef.signal.aborted, true);
  assert.equal(states.includes("completed"), false);
});

test(
  "a denied tool call reaches the requesting peer as an error, not a result",
  {
    todo: "BUG: denied and failed tool calls are sent as tool-response.result {error}, which the agent client resolves as success",
  },
  async (t) => {
    const { connection, popupMessages, dispatch } =
      await makeVerifiedConnection(["tools.invoke"], {
        roomSession: WALLET_SESSION,
      });
    t.after(() => connection.close());
    const peer = await makeWallet("Peer agent");
    const api = await mountAIAuthInPageAgent({
      connection,
      actions: [countAction({ runs: 0 })],
      authorize: () => false,
      publishAction: async () => {},
    });
    t.after(() => api.close());
    await dispatch(
      collaboration(
        await peerEnvelope(peer, connection, { requestId: "denied-request-1" }),
      ),
    );
    await waitFor(() => responsesIn(popupMessages).length === 1, "a response");
    const [response] = responsesIn(popupMessages);
    assert.equal(typeof response.error, "string");
    assert.equal(response.result, undefined);
  },
);

test(
  "aborting while the human decision is pending publishes cancelled",
  {
    todo: "BUG: aborting during the approval prompt returns silently without a cancelled event",
  },
  async (t) => {
    const { connection } = await makeVerifiedConnection(["tools.invoke"]);
    t.after(() => connection.close());
    const states = [];
    const api = await mountAIAuthInPageAgent({
      connection,
      actions: [countAction({ runs: 0 })],
      authorize: () => new Promise(() => {}),
      publishAction: (event) => states.push(event.state),
    });
    t.after(() => api.close());
    const controller = new AbortController();
    const running = api.execute(
      "site.count",
      {},
      { signal: controller.signal },
    );
    controller.abort();
    await running;
    assert.deepEqual(states, ["cancelled"]);
  },
);
