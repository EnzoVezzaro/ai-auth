import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBridge, buildAgentActions } from "../bridge.js";

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
  assert.match(unknown.reason, /not advertised|no site tool/i);
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
  await bridge.send({ text: "hi" });
  await bridge.leave();
  assert.deepEqual(
    rt.calls.map((c) => c[0]),
    ["join", "send", "leave"],
  );
  assert.deepEqual(rt.calls[1].slice(1, 3), ["message/text", { text: "hi" }]);
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
    "ai_auth_status",
  ]);
  const all = buildAgentActions({
    getBridge: () => ({}),
    siteCapabilities: ["presence.read", "messages.send", "tools.invoke"],
  });
  assert.equal(all.length, 7);
  assert.equal(all.find((a) => a.name === "ai_auth_status").readOnly, true);
  assert.equal(all.find((a) => a.name === "ai_auth_send").readOnly, false);
});
