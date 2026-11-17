import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  approvePermissionRequest,
  createParticipationPolicy,
  createRevocation,
  issueExecutionGrant,
  issueMembership,
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

// A peer first announces its tool session, then sends targeted requests.
async function announcePeer(dispatch, peer, session = PEER_SESSION) {
  await dispatch(
    collaboration(
      await peer.sign("agent/action", {
        kind: "tool-catalog",
        tools: [],
        room: ROOM,
        origin: SITE_ORIGIN,
        session,
        nonce: randomNonce(),
        expiresAt: Date.now() + 30_000,
      }),
    ),
  );
}

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
  await announcePeer(dispatch, peer);
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
  await announcePeer(dispatch, trusted, "trusted-session");
  await announcePeer(dispatch, stranger, "stranger-session");
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
        session: "stranger-session",
      }),
    ),
  );
  await settle();
  assert.equal(counter.runs, 0, "a peer the human refused does not run");
  await dispatch(
    collaboration(
      await peerEnvelope(trusted, connection, {
        requestId: "trusted-req-01",
        session: "trusted-session",
      }),
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
      actions: [countAction({ runs: 0 }, { name: `site.${"a".repeat(130)}` })],
      authorize: () => true,
    }),
    /Page actions need a name/u,
  );
});

test("an oversized input schema does not silence the rest of the catalog", async (t) => {
  const counter = { runs: 0 };
  // The room becomes ready after mounting: a room that is already ready
  // makes the mount itself throw (see the leak note in the report).
  const { connection, popupMessages, dispatch } = await makeVerifiedConnection([
    "tools.invoke",
  ]);
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
});

test("discovered WebMCP tool names peers cannot route are not advertised", async (t) => {
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
});

test("spec-valid dotted names up to 128 characters are accepted", async (t) => {
  const { connection, popupMessages } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const longName = `Peer.Search.${"x".repeat(88)}`;
  const api = await mountAIAuthInPageAgent({
    connection,
    modelContext: {
      getTools: () => [
        { name: "Peer.Search", description: "Dotted.", inputSchema: {} },
        {
          name: longName,
          description: "Long.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      executeTool: async () => "{}",
    },
    authorize: () => true,
  });
  t.after(() => api.close());
  assert.equal(longName.length, 100);
  assert.deepEqual(api.tools, ["Peer.Search", longName]);
  assert.deepEqual(
    catalogsIn(popupMessages)[0].tools.map(({ name }) => name),
    ["Peer.Search", longName],
  );
});

test("a tool name containing a slash is still rejected", async (t) => {
  const { connection } = await makeVerifiedConnection(["tools.invoke"], {
    roomSession: WALLET_SESSION,
  });
  t.after(() => connection.close());
  const api = await mountAIAuthInPageAgent({
    connection,
    modelContext: {
      getTools: () => [
        {
          name: "peer/bad",
          description: "Slash.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      executeTool: async () => "{}",
    },
    authorize: () => true,
  });
  t.after(() => api.close());
  assert.deepEqual(api.tools, []);
});

test("a human title is published with each tool descriptor, capped to 120 characters", async (t) => {
  const { connection, popupMessages } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const registrations = [];
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [
      countAction(
        { runs: 0 },
        {
          name: "site.count",
          label: "  Count public records  ",
        },
      ),
      countAction({ runs: 0 }, { name: "site.long", title: "t".repeat(200) }),
    ],
    modelContext: {
      registerTool(tool) {
        registrations.push(tool);
      },
      getTools: () => [
        {
          name: "peer.search",
          description: "Search peer data.",
          inputSchema: {},
          title: "Peer search",
        },
      ],
      executeTool: async () => "{}",
    },
    authorize: () => true,
  });
  t.after(() => api.close());
  const tools = new Map(
    catalogsIn(popupMessages)[0].tools.map((tool) => [tool.name, tool]),
  );
  assert.equal(tools.get("site.count").title, "Count public records");
  assert.equal(tools.get("site.long").title.length, 120);
  assert.equal(tools.get("peer.search").title, "Peer search");
  assert.equal(
    registrations.find((tool) => tool.name === "site.count").title,
    "Count public records",
  );
});

test("a non-object JSON Schema is published without dropping the catalog", async (t) => {
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
        {
          name: "site.text",
          description: "Handle a text value.",
          inputSchema: { type: "string" },
        },
      ),
      countAction(
        { runs: 0 },
        {
          name: "site.huge",
          description: "Oversized.",
          inputSchema: { type: "string", description: "x".repeat(5_000) },
        },
      ),
    ],
    authorize: () => true,
  });
  t.after(() => api.close());
  assert.ok(api.tools.includes("site.text"));
  assert.deepEqual(
    catalogsIn(popupMessages)[0].tools.map(({ name }) => name),
    ["site.text"],
  );
  const [tool] = catalogsIn(popupMessages)[0].tools;
  assert.deepEqual(tool.inputSchema, { type: "string" });
});

test("a toolchange event re-discovers tools and re-publishes the catalog", async (t) => {
  const { connection, popupMessages } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const listeners = new Set();
  const calls = [];
  const first = { name: "page.one", description: "One.", inputSchema: {} };
  let tools = [first];
  const modelContext = {
    getTools: () => tools,
    executeTool: async (tool) => {
      calls.push(tool.name);
      return "{}";
    },
    addEventListener(type, listener) {
      if (type === "toolchange") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
    },
    fireToolChange() {
      for (const listener of [...listeners]) listener({ type: "toolchange" });
    },
  };
  const api = await mountAIAuthInPageAgent({
    connection,
    modelContext,
    authorize: () => true,
  });
  t.after(() => api.close());
  assert.deepEqual(api.tools, ["page.one"]);

  tools = [
    ...tools,
    first,
    { name: "page.two", description: "Two.", inputSchema: {} },
  ];
  modelContext.fireToolChange();
  await waitFor(
    () =>
      catalogsIn(popupMessages).some((catalog) =>
        catalog.tools.some((tool) => tool.name === "page.two"),
      ),
    "a catalog re-published after toolchange",
  );
  assert.deepEqual(api.tools, ["page.one", "page.two"]);
  assert.deepEqual(
    catalogsIn(popupMessages)
      .at(-1)
      .tools.map((tool) => tool.name),
    ["page.one", "page.two"],
  );
  await api.execute("page.two");
  assert.deepEqual(calls, ["page.two"]);

  tools = Array.from({ length: 40 }, (_, index) => ({
    name: `page.t${index}`,
    description: "Generated.",
    inputSchema: {},
  }));
  modelContext.fireToolChange();
  await waitFor(() => api.tools.length === 32, "the capped re-discovery");
  assert.equal(catalogsIn(popupMessages).at(-1).tools.length, 32);

  api.close();
  modelContext.fireToolChange();
  await settle();
  assert.equal(listeners.size, 0, "closing removes the toolchange listener");
});

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

test("an oversized tool in a received catalog is dropped instead of thrown", async (t) => {
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
});

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

test("CT-07: a denied call leaves no abort listener on the registration signal", async (t) => {
  const counter = { runs: 0 };
  const { connection } = await makeVerifiedConnection(["tools.invoke"]);
  t.after(() => connection.close());
  let registrationSignal;
  const modelContext = {
    registerTool: (_definition, options) => {
      registrationSignal = options.signal;
    },
  };
  const api = await registerAIAuthPageActions({
    actions: [countAction(counter)],
    connection,
    modelContext,
    authorize: async () => true,
  });
  t.after(() => api.close());
  assert.ok(registrationSignal, "the registration signal is observable");
  let added = 0;
  let removed = 0;
  const add = registrationSignal.addEventListener.bind(registrationSignal);
  const remove =
    registrationSignal.removeEventListener.bind(registrationSignal);
  registrationSignal.addEventListener = (...args) => {
    added += 1;
    return add(...args);
  };
  registrationSignal.removeEventListener = (...args) => {
    removed += 1;
    return remove(...args);
  };
  const before = added - removed;
  // Invalid input returns before the main try/finally: the followers must
  // still be detached on this early path.
  assert.equal(api.isFailure(await api.execute("site.count", 42)), true);
  assert.equal(added - removed, before, "no abort listener is leaked");
  assert.equal(counter.runs, 0);
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

test("registerAIAuthPageActions refuses to run actions without an approval gate", async (t) => {
  const counter = { runs: 0 };
  const { connection } = await makeVerifiedConnection(["tools.invoke"]);
  t.after(() => connection.close());
  await assert.rejects(
    registerAIAuthPageActions({
      connection,
      actions: [countAction(counter)],
    }),
    /authorization gate/u,
  );
  assert.equal(counter.runs, 0);
});

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
  await announcePeer(dispatch, peer);
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
  await announcePeer(dispatch, agent);
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

test("a denied tool call reaches the requesting peer as an error, not a result", async (t) => {
  const { connection, popupMessages, dispatch } = await makeVerifiedConnection(
    ["tools.invoke"],
    {
      roomSession: WALLET_SESSION,
    },
  );
  t.after(() => connection.close());
  const peer = await makeWallet("Peer agent");
  await announcePeer(dispatch, peer);
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
});

test("CT-08: a denied call publishes a terminal denied state", async (t) => {
  const { connection, popupMessages, dispatch } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const peer = await makeWallet("Peer agent");
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [countAction({ runs: 0 })],
    authorize: async () => false,
  });
  t.after(() => api.close());
  await dispatch(
    collaboration(
      await peerEnvelope(peer, connection, { requestId: "denied-state-1" }),
    ),
  );
  await waitFor(
    () => messagesOf(popupMessages, "ai-auth/site-action").length > 0,
    "a denial announcement",
  );
  const states = messagesOf(popupMessages, "ai-auth/site-action").map(
    (message) => message.action.state,
  );
  assert.equal(
    states.includes("denied"),
    true,
    "the shared feed shows the request is over",
  );
  assert.equal(
    states.includes("needs-human"),
    false,
    "no stale waiting state is left behind",
  );
});

test("aborting while the human decision is pending publishes cancelled", async (t) => {
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
  const running = api.execute("site.count", {}, { signal: controller.signal });
  controller.abort();
  await running;
  assert.deepEqual(states, ["cancelled"]);
});

const timerCount = () =>
  process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

test("an oversized schema with a ready room mounts, leaks no timer, and the process can exit", async (t) => {
  const before = timerCount();
  const { connection, popupMessages } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  const oversized = {
    type: "object",
    properties: { blob: { type: "string", description: "x".repeat(5_000) } },
  };
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [
      countAction({ runs: 0 }, { name: "site.big", inputSchema: oversized }),
      countAction({ runs: 0 }),
    ],
    authorize: () => true,
  });
  assert.deepEqual(catalogNames(popupMessages), [["site.count"]]);
  api.close();
  connection.close();
  assert.ok(
    timerCount() <= before + 1,
    "closing releases the expiry timer so the event loop can drain",
  );
});

// Restricted-room gate: a remote requester needs membership plus a live grant.
async function gatedWorld(t) {
  const host = await makeWallet("Site host");
  const peer = await makeWallet("Peer agent");
  const policy = createParticipationPolicy({
    mode: "restricted",
    trustPolicy: { issuers: [host.publicKey] },
    origin: SITE_ORIGIN,
    room: ROOM,
  });
  const membership = await issueMembership(host, {
    subject: peer.id,
    origin: SITE_ORIGIN,
    room: ROOM,
    scopes: ["tools.invoke"],
  });
  const grant = await issueExecutionGrant(host, {
    subject: peer.id,
    origin: SITE_ORIGIN,
    room: ROOM,
    membershipId: membership.id,
    scopes: ["tools.invoke"],
    epoch: policy.epoch,
  });
  const ctx = await makeVerifiedConnection(["tools.invoke"], {
    roomSession: WALLET_SESSION,
  });
  t.after(() => ctx.connection.close());
  await announcePeer(ctx.dispatch, peer);
  const counter = { runs: 0 };
  const api = await mountAIAuthInPageAgent({
    connection: ctx.connection,
    actions: [countAction(counter)],
    authorize: () => true,
    publishAction: async () => {},
    policy,
  });
  t.after(() => api.close());
  const call = async (requestId) => {
    const seen = responsesIn(ctx.popupMessages).length;
    await ctx.dispatch(
      collaboration(await peerEnvelope(peer, ctx.connection, { requestId })),
    );
    await waitFor(
      () => responsesIn(ctx.popupMessages).length > seen,
      "a response",
    );
    return responsesIn(ctx.popupMessages).at(-1);
  };
  return { host, peer, policy, membership, grant, counter, call };
}

test("a protected tool is refused until membership and a grant exist, and again after revocation", async (t) => {
  const w = await gatedWorld(t);
  const stranger = await w.call("request-stranger-1");
  assert.equal(typeof stranger.error, "string");
  assert.equal(w.counter.runs, 0);

  assert.equal((await w.policy.admit(w.peer.id, w.membership)).ok, true);
  const noGrant = await w.call("request-nogrant-1");
  assert.equal(
    typeof noGrant.error,
    "string",
    "membership alone is not enough",
  );
  assert.equal(w.counter.runs, 0);

  assert.equal((await w.policy.admitGrant(w.peer.id, w.grant)).ok, true);
  const allowed = await w.call("request-allowed-1");
  assert.equal(allowed.error, undefined);
  assert.equal(w.counter.runs, 1);

  const revocation = await createRevocation(w.host, {
    kind: "wallet",
    target: w.peer.id,
    origin: SITE_ORIGIN,
    room: ROOM,
  });
  assert.equal((await w.policy.applyRevocation(revocation)).ok, true);
  const revoked = await w.call("request-revoked-1");
  assert.equal(typeof revoked.error, "string");
  assert.equal(w.counter.runs, 1, "the revoked identity cannot invoke");
});

test("annotation hints mark protected actions and peer-sourced tools", async (t) => {
  const { connection, popupMessages } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const registrations = [];
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [
      countAction({ runs: 0 }, { name: "site.read" }),
      countAction({ runs: 0 }, { name: "site.approve", protected: true }),
    ],
    modelContext: {
      registerTool(tool) {
        registrations.push(tool);
      },
      getTools: () => [
        {
          name: "peer.search",
          description: "Read peer records.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
      executeTool: async () => "{}",
    },
    authorize: () => true,
  });
  t.after(() => api.close());
  const registered = new Map(registrations.map((tool) => [tool.name, tool]));
  assert.equal(
    registered.get("site.read").annotations.consequentialHint,
    false,
  );
  assert.equal(
    registered.get("site.approve").annotations.consequentialHint,
    true,
  );
  assert.equal(
    registered.get("site.read").annotations.untrustedContentHint,
    false,
  );
  const [catalog] = catalogsIn(popupMessages);
  const hints = new Map(
    catalog.tools.map((tool) => [tool.name, tool.annotations]),
  );
  assert.deepEqual(hints.get("site.read"), {
    readOnlyHint: false,
    consequentialHint: false,
    untrustedContentHint: false,
  });
  assert.equal(hints.get("site.approve").consequentialHint, true);
  assert.equal(hints.get("peer.search").untrustedContentHint, true);
  assert.equal(hints.get("peer.search").readOnlyHint, true);
});

test("an action marked protected fails closed when no policy is available", async (t) => {
  const { connection, popupMessages, dispatch } = await makeVerifiedConnection(
    ["tools.invoke"],
    { roomSession: WALLET_SESSION },
  );
  t.after(() => connection.close());
  const counter = { runs: 0 };
  const api = await mountAIAuthInPageAgent({
    connection,
    actions: [countAction(counter, { protected: true })],
    authorize: () => true,
    publishAction: async () => {},
  });
  t.after(() => api.close());
  const peer = await makeWallet("Peer agent");
  await announcePeer(dispatch, peer);
  await dispatch(collaboration(await peerEnvelope(peer, connection)));
  await waitFor(() => responsesIn(popupMessages).length === 1, "a response");
  assert.equal(typeof responsesIn(popupMessages)[0].error, "string");
  assert.equal(counter.runs, 0);
});
