import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentBridge,
  buildAgentActions,
  createRoomToolProvider,
} from "../bridge.js";

function fakeRuntime() {
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    connectionState: {
      status: "idle",
      directPeerCount: 0,
      peers: [],
      diagnostics: {},
    },
    identity: { id: "agent:me", name: "me" },
    room: null,
    origin: "https://site.example",
    capabilities: ["messages.send", "presence.read", "tools.invoke"],
    agentRoom: {},
    peers: () => [],
    onEvent: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    emit: (m) => listeners.forEach((fn) => fn(m)),
    async join(room) {
      calls.push(["join", room]);
      this.room = room ?? "default";
      return this.connectionState;
    },
    async leave() {
      calls.push(["leave"]);
      this.room = null;
    },
    async send(type, payload, opts) {
      calls.push(["send", type, payload, opts]);
      return { body: { type } };
    },
  };
}
const inbound = (type, payload = {}, issuer = "agent:peer") => ({
  direction: "in",
  envelope: { body: { type, issuer, payload } },
});

test("events are bounded, cursor-based and marked untrusted", () => {
  const rt = fakeRuntime();
  const bridge = createAgentBridge({
    runtime: rt,
    maxEvents: 5,
    clientFactory: () => ({}),
  });
  for (let i = 0; i < 8; i += 1)
    rt.emit(inbound("message/text", { text: `m${i}` }));
  const first = bridge.events({ since: 0, limit: 3 });
  assert.equal(first.untrusted, true);
  assert.equal(first.dropped, true, "older events fell off the ring");
  assert.equal(first.events.length, 3);
  const next = bridge.events({ since: first.nextCursor, limit: 50 });
  assert.deepEqual(
    next.events.map((e) => e.payload.text),
    ["m6", "m7"].slice(-next.events.length),
  );
  assert.equal(bridge.events({ since: next.nextCursor }).events.length, 0);
  assert.equal(bridge.events({ limit: 9999 }).events.length <= 50, true);
});

test("events clamp a cursor ahead of the ring instead of wedging", () => {
  const rt = fakeRuntime();
  const bridge = createAgentBridge({ runtime: rt, clientFactory: () => ({}) });
  for (let i = 0; i < 5; i++)
    rt.emit(inbound("collab/text", { text: `m${i}` }));
  const ahead = bridge.events({ since: 1000 });
  assert.equal(ahead.dropped, true, "a cursor past the ring must signal loss");
  assert.equal(ahead.events.length, 0);
  assert.equal(ahead.nextCursor, 5, "the cursor is clamped to the ring head");
  rt.emit(inbound("collab/text", { text: "fresh" }));
  const next = bridge.events({ since: ahead.nextCursor });
  assert.deepEqual(
    next.events.map((e) => e.payload.text),
    ["fresh"],
  );
  assert.equal(next.nextCursor, 6);
});

test("heartbeats are not buffered; oversized payloads are truncated", () => {
  const rt = fakeRuntime();
  const bridge = createAgentBridge({ runtime: rt, clientFactory: () => ({}) });
  rt.emit(inbound("peer/heartbeat"));
  rt.emit(inbound("message/text", { text: "y".repeat(10_000) }));
  const { events } = bridge.events({});
  assert.equal(events.length, 1);
  assert.ok(JSON.stringify(events[0]).length < 3_000);
});

test("status reports state, peers and the granted scopes without secrets", () => {
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({}),
  });
  const status = bridge.status();
  assert.equal(status.identity, "agent:me");
  assert.deepEqual(status.capabilities, [
    "messages.send",
    "presence.read",
    "tools.invoke",
  ]);
  assert.match(status.note, /stdio|process/i);
  assert.ok(!JSON.stringify(status).includes('"d"'));
});

test("invoke returns a rejection (not a throw) when the site denies", async () => {
  const catalog = {
    wallet: "agent:site",
    session: "s",
    requestNonce: "n".repeat(24),
    expiresAt: Date.now() + 60_000,
    tools: [{ name: "search" }],
  };
  const client = {
    catalogs: [catalog],
    callTool: async () => {
      throw new Error("The site owner denied this action");
    },
  };
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => client,
  });
  const denied = await bridge.invoke({ name: "search", input: {} });
  assert.deepEqual(
    { ok: denied.ok, rejected: denied.rejected },
    { ok: false, rejected: true },
  );
  assert.match(denied.reason, /denied/);
  client.callTool = async () => ({ hits: 1 });
  assert.deepEqual(await bridge.invoke({ name: "search" }), {
    ok: true,
    result: { hits: 1 },
  });
  const unknown = await bridge.invoke({ name: "missing" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /No participant advertises|not advertised/i);
});

test("invoke with several catalogs requires an explicit wallet", async () => {
  const mk = (wallet) => ({
    wallet,
    session: "s",
    requestNonce: "n".repeat(24),
    expiresAt: Date.now() + 60_000,
    tools: [{ name: "t" }],
  });
  const client = {
    catalogs: [mk("agent:a"), mk("agent:b")],
    callTool: async () => "ok",
  };
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => client,
  });
  assert.match(
    (await bridge.invoke({ name: "t" })).reason,
    /ambiguous|wallet/i,
  );
  assert.equal(
    (await bridge.invoke({ name: "t", wallet: "agent:b" })).ok,
    true,
  );
});

test("list_tools exposes site tool names and descriptions only", () => {
  const catalog = {
    wallet: "agent:site",
    session: "s",
    requestNonce: "n".repeat(24),
    expiresAt: Date.now() + 60_000,
    tools: [
      { name: "search", description: "d", inputSchema: { type: "object" } },
    ],
  };
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({ catalogs: [catalog] }),
  });
  const out = bridge.listTools();
  assert.equal(out.sites[0].wallet, "agent:site");
  assert.equal(out.sites[0].tools[0].name, "search");
  assert.equal(out.untrusted, true);
});

test("send and join/leave delegate to the runtime", async () => {
  const rt = fakeRuntime();
  const bridge = createAgentBridge({ runtime: rt, clientFactory: () => ({}) });
  await bridge.join({ room: "r1" });
  const sent = await bridge.send({ text: "hi" });
  await bridge.leave();
  assert.deepEqual(
    rt.calls.map((c) => c[0]),
    ["join", "send", "leave"],
  );
  assert.equal(rt.calls[1][1], "collab/text");
  assert.equal(rt.calls[1][2].text, "hi");
  assert.equal(rt.calls[1][2].messageId, sent.messageId);
  assert.equal(sent.state, "sent-to-transport");
});

test("actions only cover scopes the site requested and declare read-only where true", () => {
  const actions = buildAgentActions({
    getBridge: () => ({}),
    siteCapabilities: ["presence.read"],
  });
  assert.deepEqual(actions.map((a) => a.name).sort(), [
    "ai_auth_events",
    "ai_auth_join",
    "ai_auth_leave",
    "ai_auth_move",
    "ai_auth_status",
  ]);
  const all = buildAgentActions({
    getBridge: () => ({}),
    siteCapabilities: ["presence.read", "messages.send", "tools.invoke"],
  });
  assert.equal(all.length, 9);
  assert.equal(all.find((a) => a.name === "ai_auth_move").readOnly, false);
  assert.equal(all.find((a) => a.name === "ai_auth_act").readOnly, false);
  assert.equal(all.find((a) => a.name === "ai_auth_status").readOnly, true);
  assert.equal(all.find((a) => a.name === "ai_auth_send").readOnly, false);
});

test("move publishes the agent cursor and act publishes a signed activity status", async () => {
  const rt = fakeRuntime();
  const published = [];
  const bridge = createAgentBridge({
    runtime: rt,
    clientFactory: () => ({
      catalogs: [],
      publishCursor: (c) => (published.push(["cursor", c]), { body: {} }),
      publishAction: (a) => (published.push(["action", a]), { body: {} }),
    }),
  });
  const moved = await bridge.move({ x: 0.25, y: 0.5 });
  assert.equal(moved.moved, true);
  const acted = await bridge.act({
    name: "catalog.browse",
    state: "progress",
    summary: "Looking at glasses",
  });
  assert.equal(acted.published, true);
  assert.deepEqual(published, [
    ["cursor", { x: 0.25, y: 0.5, visible: true }],
    [
      "action",
      {
        name: "catalog.browse",
        state: "progress",
        summary: "Looking at glasses",
      },
    ],
  ]);
  await bridge.move({ x: 0.1, y: 0.1, visible: false });
  assert.equal(published.at(-1)[1].visible, false);
});

test("status reports which page each peer is on and move accepts a page", async () => {
  const rt = fakeRuntime();
  rt.peers = () => [{ id: "agent:peer", name: "Peer", stale: false }];
  const published = [];
  const bridge = createAgentBridge({
    runtime: rt,
    clientFactory: () => ({
      catalogs: [],
      publishCursor: (c) => (published.push(c), { body: {} }),
      publishAction: () => ({ body: {} }),
    }),
  });
  rt.emit({
    direction: "in",
    envelope: {
      body: {
        type: "presence/cursor",
        issuer: "agent:peer",
        payload: {
          type: "ai-auth-cursor",
          v: 1,
          pageKey: "/product",
          x: 1,
          y: 2,
          seq: 1,
          visible: true,
        },
      },
    },
  });
  const peer = bridge.status().peers.find((p) => p.id === "agent:peer");
  assert.equal(
    peer?.pageKey,
    "/product",
    "the peer's page is visible to agents",
  );

  await bridge.move({ x: 0.5, y: 0.5, page: "/product" });
  assert.equal(
    published.at(-1).page,
    "/product",
    "move forwards the page argument",
  );
});

test("room tools are executed by the agent runtime with no page involved", async () => {
  const rt = fakeRuntime();
  let registered = null;
  rt.provideTools = (options) => {
    registered = options;
    return {
      tools: options.tools.map((tool) => tool.name),
      announce() {},
      close() {},
    };
  };
  const provider = createRoomToolProvider(rt);
  assert.deepEqual(provider.tools, ["agent.ping", "agent.self"]);
  const ping = registered.tools.find((tool) => tool.name === "agent.ping");
  const pong = await ping.handler({});
  assert.equal(pong.pong, true);
  assert.equal(pong.agent, "agent:me");
  const self = registered.tools.find((tool) => tool.name === "agent.self");
  assert.deepEqual(await self.handler({}), {
    id: "agent:me",
    name: null,
    room: null,
    capabilities: ["messages.send", "presence.read", "tools.invoke"],
  });
  assert.equal(registered.authorize("agent:stranger", "agent.ping", {}), true);
});

test("a missing tool says why it may be unavailable instead of calling it", async () => {
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({ catalogs: [] }),
  });
  const out = await bridge.invoke({ name: "catalog.search" });
  assert.equal(out.ok, false);
  assert.match(out.reason, /page/);
  assert.match(out.reason, /agent/);
});

test("status reports tools this agent provides", () => {
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({}),
    providedTools: ["agent.ping"],
  });
  assert.deepEqual(bridge.status().provides, ["agent.ping"]);
});

test("code mode runs sandboxed code against connection-checked aiAuth APIs", async () => {
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({ catalogs: [] }),
  });
  const out = await bridge.runCode({
    code: "console.log(aiAuth.status().connection); return aiAuth.listTools().sites.length;",
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.logs, ["idle"]);
  assert.equal(out.value, 0);
});

test("code mode cannot reach Node globals", async () => {
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({ catalogs: [] }),
  });
  const out = await bridge.runCode({ code: "return typeof process;" });
  assert.equal(out.ok, true);
  assert.equal(out.value, "undefined");
});

// CT-01: the guest must never receive a host-realm object. Each probe starts
// from a value the sandbox exposes, climbs to a constructor, and asks it to
// compile a string. A host constructor reveals the host `process`; a guest
// constructor refuses string compilation under codeGeneration.strings:false.
function codeBridge() {
  const rt = fakeRuntime();
  // A rejected host call must surface as a guest error, not a host Error.
  rt.send = async () => {
    throw new Error("send failed on purpose");
  };
  return createAgentBridge({
    runtime: rt,
    clientFactory: () => ({ catalogs: [] }),
  });
}

const escapeProbes = [
  {
    name: "console.log.constructor",
    code: `try { return console.log.constructor("return typeof process")(); } catch (e) { return "blocked:" + (e && e.name); }`,
  },
  {
    name: "aiAuth.status.constructor",
    code: `try { return aiAuth.status.constructor("return typeof process")(); } catch (e) { return "blocked:" + (e && e.name); }`,
  },
  {
    name: "returned result object's constructor chain",
    code: `try { return aiAuth.status().constructor.constructor("return typeof process")(); } catch (e) { return "blocked:" + (e && e.name); }`,
  },
  {
    name: "thrown error's constructor chain",
    code: `try { await aiAuth.send({ text: "x" }); return "no-throw"; } catch (e) { try { return e.constructor.constructor("return typeof process")(); } catch (x) { return "blocked:" + (x && x.name); } }`,
  },
  {
    name: "aiAuth.invoke promise's constructor chain",
    code: `try { const p = aiAuth.invoke("x"); return p.constructor.constructor("return typeof process")(); } catch (e) { return "blocked:" + (e && e.name); }`,
  },
  {
    name: "Object.getPrototypeOf chain from console.log",
    code: `try { return Object.getPrototypeOf(console.log).constructor("return typeof process")(); } catch (e) { return "blocked:" + (e && e.name); }`,
  },
  {
    name: "Object.getPrototypeOf chain from a result object",
    code: `try { return Object.getPrototypeOf(aiAuth.status()).constructor.constructor("return typeof process")(); } catch (e) { return "blocked:" + (e && e.name); }`,
  },
  {
    name: "AsyncFunction constructor from an async call wrapper",
    code: `try { return await aiAuth.send.constructor("return typeof process")(); } catch (e) { return "blocked:" + (e && e.name); }`,
  },
];

for (const { name, code } of escapeProbes) {
  test(`CT-01: ${name} cannot compile host code`, async () => {
    const out = await codeBridge().runCode({ code });
    assert.equal(out.ok, true, out.reason);
    assert.match(
      out.value,
      /^blocked:/,
      `${name} escaped to the host process (got ${JSON.stringify(out.value)})`,
    );
  });
}

test("CT-01: code mode async calls return JSON copies and capture logs", async () => {
  const catalog = {
    wallet: "agent:site",
    session: "s",
    requestNonce: "n".repeat(24),
    expiresAt: Date.now() + 60_000,
    tools: [{ name: "search" }],
  };
  const client = {
    catalogs: [catalog],
    callTool: async () => ({ hits: 2 }),
  };
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => client,
  });
  const out = await bridge.runCode({
    code: `console.log("before"); const r = await aiAuth.invoke("search"); return r.result.hits;`,
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.value, 2);
  assert.deepEqual(out.logs, ["before"]);
});

test("CT-11: ai_auth_invoke accepts spec-valid names up to 128 characters", () => {
  const actions = buildAgentActions({
    getBridge: () => ({}),
    siteCapabilities: ["tools.invoke"],
  });
  const name = actions.find((action) => action.name === "ai_auth_invoke")
    .inputSchema.name;
  assert.equal(name.safeParse("a".repeat(128)).success, true);
  assert.equal(name.safeParse("My.Tool-1").success, true);
  assert.equal(name.safeParse("a".repeat(129)).success, false);
  assert.equal(name.safeParse("bad/name").success, false);
});

test("ai_auth_code is opt-in and requires tools.invoke", () => {
  const getBridge = () => null;
  const names = (codeMode, caps) =>
    buildAgentActions({
      getBridge,
      siteCapabilities: caps,
      codeMode,
    }).map((action) => action.name);
  assert.ok(!names(true, ["presence.read"]).includes("ai_auth_code"));
  assert.ok(!names(false, ["tools.invoke"]).includes("ai_auth_code"));
  assert.ok(names(true, ["tools.invoke"]).includes("ai_auth_code"));
});
