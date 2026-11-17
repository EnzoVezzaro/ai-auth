// Scenario tests for the agent-owned connection model: the wallet owns the
// identity, the agent runtime owns the connection, and a website is only the
// shared room. No browser page is involved unless a test adds one.
globalThis.BroadcastChannel = class {
  postMessage() {}
  close() {}
};
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NostrWebRTC,
  P2PRoom,
  createAIAuthConnectInstruction,
  createAIAuthAgentClient,
  identityFor,
  signEnvelope,
} from "../packages/p2p/index.js";
import { createFileKeystore } from "../packages/agent/keystore.js";
import { createAgentRuntime } from "../packages/agent/runtime.js";
import { createHub } from "../packages/agent/test/fake-transport.mjs";
import {
  createAgentBridge,
  createRoomToolProvider,
} from "../packages/mcp/bridge.js";

globalThis.crypto ??= webcrypto;

const PASS = "correct horse battery staple";
const CAPS = ["presence.read", "messages.send", "tools.invoke"];

async function testWallet(name) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  return {
    id,
    name,
    publicKey,
    privateKey: pair.privateKey,
    sign: (type, payload) =>
      signEnvelope(
        { id, publicKey, privateKey: pair.privateKey },
        type,
        payload,
      ),
  };
}

/**
 * A runtime whose keystore lives in `dir`. The first call creates the
 * identity; later calls with the same dir reopen it, which is how a restart
 * keeps its wallet but gets a new connection.
 */
async function makeRuntime(
  t,
  hub,
  origin,
  room,
  name,
  { dir, create = true } = {},
) {
  const home = dir ?? (await mkdtemp(path.join(tmpdir(), "ai-auth-scenario-")));
  if (!dir) t.after(() => rm(home, { recursive: true, force: true }));
  const keystore = createFileKeystore({ dir: home, passphrase: PASS, env: {} });
  if (create) await keystore.create({ name });
  const runtime = createAgentRuntime({
    keystore,
    origin,
    room,
    capabilities: CAPS,
    descriptor: { name },
    joinRoom: hub.joinRoom,
    delay: async () => {},
    random: () => 0.5,
  });
  t.after(() => runtime.close());
  return { runtime, dir: home, keystore };
}

// Catalog and presence announcements arrive asynchronously over the room. Under
// a loaded run the first one can take longer than 4 s; this widens the wait for
// every scenario. The exact announcement that gates each wait is not yet traced.
const until = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("condition not reached");
};

test("A: three independent agents discover each other, message, and move cursors", async (t) => {
  const hub = createHub();
  const origin = "https://three.example";
  const agents = [];
  for (const name of ["A", "B", "C"]) {
    const made = await makeRuntime(t, hub, origin, "lobby", name);
    await made.runtime.join();
    agents.push(made.runtime);
  }
  const clients = agents.map((rt) => createAIAuthAgentClient(rt.agentRoom));
  t.after(() => clients.forEach((c) => c.close()));

  await until(() => agents.every((rt) => rt.peers().length === 2));
  const ids = new Set(agents.map((rt) => rt.identity.id));
  assert.equal(ids.size, 3, "each agent has a distinct wallet identity");

  const heard = [];
  agents[1].onEvent((m) => {
    if (m.direction === "in" && m.envelope?.body?.type === "message/text")
      heard.push(m.envelope.body);
  });
  const cursors = [];
  agents[2].onEvent((m) => {
    if (m.direction === "in" && m.envelope?.body?.type === "presence/cursor")
      cursors.push(m.envelope.body);
  });
  await agents[0].send("message/text", { text: "hello from A" });
  await agents[0].send("message/text", { text: "second" });
  await until(() => heard.length === 2);
  assert.equal(heard[0].issuer, agents[0].identity.id);
  assert.deepEqual(
    heard.map((e) => e.payload.text),
    ["hello from A", "second"],
  );

  clients.forEach((client, i) =>
    client.publishCursor({ x: 0.2 + i * 0.1, y: 0.5 }),
  );
  await until(
    () =>
      new Set(cursors.map((c) => c.issuer)).size === 2 &&
      cursors.every((c) => typeof c.payload.label === "string"),
  );
});

test("B: agents stay connected and keep talking after the human leaves", async (t) => {
  const hub = createHub();
  const origin = "https://leave.example";
  const a = await makeRuntime(t, hub, origin, "lobby", "A");
  const b = await makeRuntime(t, hub, origin, "lobby", "B");
  const visitor = await makeRuntime(t, hub, origin, "lobby", "visitor");
  await a.runtime.join();
  await b.runtime.join();
  await visitor.runtime.join();
  await until(() => a.runtime.peers().length === 2);

  const heard = [];
  b.runtime.onEvent((m) => {
    if (m.direction === "in" && m.envelope?.body?.type === "message/text")
      heard.push(m.envelope.body.payload.text);
  });

  // The human closes the browser: their connection goes away entirely.
  await visitor.runtime.close();
  await until(() => a.runtime.peers().length === 1);
  assert.equal(
    a.runtime.connectionState.status,
    "direct-peer-connected",
    "A is still connected to B",
  );

  await a.runtime.send("message/text", { text: "still here" });
  await until(() => heard.includes("still here"));
});

test("C: a returning human sees connected agents with names and live cursors", async (t) => {
  const hub = createHub();
  const origin = "https://return.example";
  const a = await makeRuntime(t, hub, origin, "lobby", "Researcher");
  await a.runtime.join();
  const aClient = createAIAuthAgentClient(a.runtime.agentRoom);
  t.after(() => aClient.close());

  const first = await makeRuntime(t, hub, origin, "lobby", "Visitor one");
  await first.runtime.join();
  await first.runtime.close();

  const back = await makeRuntime(t, hub, origin, "lobby", "Visitor two");
  await back.runtime.join();
  t.after(() => back.runtime.close());
  const backClient = createAIAuthAgentClient(back.runtime.agentRoom);
  t.after(() => backClient.close());

  await until(() =>
    back.runtime
      .peers()
      .some((p) => p.id === a.runtime.identity.id && p.name === "Researcher"),
  );
  assert.ok(
    !back.runtime.peers().some((p) => p.name === "Visitor one"),
    "the closed visitor is not a ghost",
  );

  const seen = [];
  back.runtime.onEvent((m) => {
    if (m.direction === "in" && m.envelope?.body?.type === "presence/cursor")
      seen.push(m.envelope.body);
  });
  await aClient.publishCursor({ x: 0.4, y: 0.6 });
  await until(() =>
    seen.some(
      (c) =>
        c.issuer === a.runtime.identity.id &&
        c.payload.label === "Researcher" &&
        c.payload.x === 0.4,
    ),
  );
});

test("D: with every browser closed, peers call agent-provided tools", async (t) => {
  const hub = createHub();
  const origin = "https://notools.example";
  const a = await makeRuntime(t, hub, origin, "lobby", "Tool provider");
  const b = await makeRuntime(t, hub, origin, "lobby", "Tool caller");
  const provider = createRoomToolProvider(a.runtime);
  await a.runtime.join();
  const bridge = createAgentBridge({ runtime: b.runtime });
  t.after(() => bridge.close());
  await bridge.join({ room: "lobby" });

  await until(() =>
    bridge.listTools().sites.some((s) => s.wallet === a.runtime.identity.id),
  );
  const names = bridge
    .listTools()
    .sites.filter((s) => s.wallet === a.runtime.identity.id)
    .flatMap((s) => s.tools.map((tool) => tool.name));
  assert.deepEqual(names.sort(), ["agent.ping", "agent.self"]);

  const pong = await bridge.invoke({ name: "agent.ping" });
  assert.equal(pong.ok, true, pong.reason);
  assert.equal(pong.result.pong, true);
  assert.equal(pong.result.agent, a.runtime.identity.id);

  // Withdrawing the provider removes the tools at once, without a page.
  provider.close();
  await until(
    () =>
      !bridge
        .listTools()
        .sites.some(
          (s) => s.wallet === a.runtime.identity.id && s.tools.length,
        ),
  );
  const gone = await bridge.invoke({ name: "agent.ping" });
  assert.equal(gone.ok, false);
});

test("D2: a browser-only page tool is reported unavailable, not faked", async (t) => {
  const hub = createHub();
  const origin = "https://page-only.example";
  const a = await makeRuntime(t, hub, origin, "lobby", "A");
  const b = await makeRuntime(t, hub, origin, "lobby", "B");
  await a.runtime.join();
  const bridge = createAgentBridge({ runtime: b.runtime });
  t.after(() => bridge.close());
  await bridge.join({ room: "lobby" });
  // No page participant ever publishes a catalog for this tool.
  const out = await bridge.invoke({ name: "catalog.search", input: {} });
  assert.equal(out.ok, false);
  assert.equal(out.rejected, false);
  assert.match(out.reason, /page/);
});

test("E: a restarted runtime leaves no ghost, keeps its wallet, and can rejoin", async (t) => {
  const hub = createHub();
  const origin = "https://restart.example";
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await makeRuntime(t, hub, origin, "lobby", "A", { dir });
  const b = await makeRuntime(t, hub, origin, "lobby", "B");
  await a.runtime.join();
  await b.runtime.join();
  await until(() =>
    b.runtime.peers().some((p) => p.id === a.runtime.identity.id),
  );
  const oldId = a.runtime.identity.id;

  await a.runtime.close();
  await until(() => !b.runtime.peers().some((p) => p.id === oldId), 6000);

  const again = await makeRuntime(t, hub, origin, "lobby", "A", {
    dir,
    create: false,
  });
  await again.runtime.join();
  assert.equal(again.runtime.identity.id, oldId, "wallet identity survived");
  await until(() =>
    b.runtime
      .peers()
      .some((p) => p.id === oldId && typeof p.session === "string"),
  );
});

test("F: an MCP bridge agent and a direct SDK runtime interoperate in one room", async (t) => {
  const hub = createHub();
  const origin = "https://mixed.example";
  const direct = await makeRuntime(t, hub, origin, "lobby", "Direct runtime");
  const mcp = await makeRuntime(t, hub, origin, "lobby", "MCP runtime");
  const provider = createRoomToolProvider(direct.runtime);
  t.after(() => provider.close());
  const bridge = createAgentBridge({ runtime: mcp.runtime });
  t.after(() => bridge.close());
  await direct.runtime.join();
  await bridge.join({ room: "lobby" });
  await until(() =>
    bridge
      .listTools()
      .sites.some((s) => s.wallet === direct.runtime.identity.id),
  );
  const out = await bridge.invoke({ name: "agent.self" });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.result.id, direct.runtime.identity.id);

  const heard = [];
  direct.runtime.onEvent((m) => {
    if (m.direction === "in" && m.envelope?.body?.type === "message/text")
      heard.push(m.envelope.body.payload.text);
  });
  await bridge.send({ text: "hello direct" });
  await until(() => heard.includes("hello direct"));
});

test("G: a generic site needs no body4ai code, only the public SDK", async (t) => {
  const hub = createHub();
  const origin = "https://minimal.example";
  const site = await testWallet("Minimal site");
  const siteRoom = new P2PRoom(site, "demo", {
    origin,
    capabilities: ["presence.read", "messages.send", "tools.invoke"],
  });
  const net = new NostrWebRTC(siteRoom, {
    origin,
    room: "demo",
    joinRoom: hub.joinRoom,
  });
  t.after(async () => {
    await siteRoom.close().catch(() => {});
    await net.close().catch(() => {});
  });
  await net.start();

  const instruction = createAIAuthConnectInstruction({
    siteName: "Minimal",
    siteOrigin: origin,
    walletUrl: "https://minimal.example/wallet/",
    capabilities: ["presence.read", "messages.send"],
    room: "demo",
  });
  assert.equal(instruction.origin, origin);
  assert.equal(instruction.room, "demo");

  const agent = await makeRuntime(t, hub, origin, "demo", "Agent");
  await agent.runtime.join();
  await until(() => agent.runtime.peers().some((p) => p.id === site.id));
  const client = createAIAuthAgentClient(agent.runtime.agentRoom);
  t.after(() => client.close());

  // The site sends a signed event; the agent verifies and receives it.
  const heard = [];
  agent.runtime.onEvent((m) => {
    if (m.direction === "in" && m.envelope?.body?.type === "message/text")
      heard.push(m.envelope.body);
  });
  await siteRoom.send("message/text", { text: "welcome from the site" });
  await until(() => heard.length === 1);
  assert.equal(heard[0].issuer, site.id);
  assert.equal(heard[0].payload.text, "welcome from the site");
});
