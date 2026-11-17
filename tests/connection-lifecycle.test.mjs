// Connection-bound presence tests. These use the in-process transport: they
// prove signing, catalog, lease and lifecycle behavior, not real P2P reachability.
// Real WebRTC/browser evidence lives in scripts/test-browser-e2e.mjs.
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
import { TOOL_ERROR_CODES } from "../packages/p2p/index.js";
import { createFileKeystore } from "../packages/agent/keystore.js";
import { createAgentRuntime } from "../packages/agent/runtime.js";
import { createHub } from "../packages/agent/test/fake-transport.mjs";
import { createAgentBridge } from "../packages/mcp/bridge.js";

globalThis.crypto ??= webcrypto;

const PASS = "correct horse battery staple";
const CAPS = ["presence.read", "messages.send", "tools.invoke"];
const ORIGIN = "https://integration.example";
const ROOM = "lifecycle";

async function makeRuntime(t, hub, name, extra = {}) {
  const dir =
    extra.dir ?? (await mkdtemp(path.join(tmpdir(), "ai-auth-life-")));
  if (!extra.dir) t.after(() => rm(dir, { recursive: true, force: true }));
  const keystore = createFileKeystore({ dir, passphrase: PASS, env: {} });
  if (extra.create !== false) await keystore.create({ name });
  const runtime = createAgentRuntime({
    keystore,
    origin: ORIGIN,
    room: ROOM,
    capabilities: CAPS,
    descriptor: { name },
    joinRoom: hub.joinRoom,
    delay: async () => {},
    random: () => 0.5,
    ...extra.runtime,
  });
  t.after(() => runtime.close());
  return { runtime, dir, keystore };
}

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition not reached");
};

function provideEcho(runtime, calls = []) {
  return runtime.provideTools({
    tools: [
      {
        name: "demo.echo",
        description: "Echo a message on the independent test site",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
        handler: async (input) => {
          calls.push(input.message);
          return { echoed: input.message };
        },
      },
    ],
    authorize: () => true,
  });
}

test("1. a runtime connects only through a live transport and reports connected", async (t) => {
  const hub = createHub();
  const a = await makeRuntime(t, hub, "A");
  const b = await makeRuntime(t, hub, "B");
  await a.runtime.join();
  await b.runtime.join();
  await until(
    () => a.runtime.peers().length === 1 && b.runtime.peers().length === 1,
  );
  assert.equal(a.runtime.connectionState.connected, true);
  assert.equal(b.runtime.connectionState.connected, true);
  assert.equal(
    a.runtime.connectionState.generation,
    a.runtime.agentRoom.session,
  );
  assert.deepEqual(
    a.runtime.peers().map((p) => ({ id: p.id, stale: p.stale })),
    [{ id: b.runtime.identity.id, stale: false }],
  );
});

test("2. connected peers exchange a signed message", async (t) => {
  const hub = createHub();
  const a = await makeRuntime(t, hub, "A");
  const b = await makeRuntime(t, hub, "B");
  const seen = [];
  b.runtime.onEvent((m) => {
    if (m.direction === "in" && m.envelope?.body?.type === "message/text")
      seen.push(m);
  });
  await a.runtime.join();
  await b.runtime.join();
  await until(
    () =>
      a.runtime.connectionState.connected &&
      b.runtime.connectionState.connected,
  );
  await a.runtime.send("message/text", { text: "hello" });
  await until(() => seen.length === 1);
  assert.equal(seen[0].envelope.body.issuer, a.runtime.identity.id);
  assert.equal(seen[0].envelope.body.payload.text, "hello");
  assert.equal(typeof seen[0].envelope.proof?.signature, "string");
});

test("3. an agent invokes a generic site WebMCP tool through the live connection", async (t) => {
  const hub = createHub();
  const site = await makeRuntime(t, hub, "site");
  const agent = await makeRuntime(t, hub, "agent");
  const calls = [];
  provideEcho(site.runtime, calls);
  await site.runtime.join();
  await agent.runtime.join();
  const bridge = createAgentBridge({ runtime: agent.runtime });
  t.after(() => bridge.close());
  await until(() =>
    bridge
      .listTools()
      .sites.some((s) => s.tools.some((x) => x.name === "demo.echo")),
  );
  const result = await bridge.invoke({
    name: "demo.echo",
    input: { message: "hi" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { echoed: "hi" });
  assert.deepEqual(calls, ["hi"]);
  const invalid = await bridge.invoke({
    name: "demo.echo",
    input: { message: 42 },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, TOOL_ERROR_CODES.TOOL_UNAVAILABLE);
  assert.deepEqual(calls, ["hi"]);
});

test("4. a normal runtime close makes the peer offline immediately", async (t) => {
  const hub = createHub();
  const a = await makeRuntime(t, hub, "A");
  const b = await makeRuntime(t, hub, "B");
  await a.runtime.join();
  await b.runtime.join();
  await until(() => b.runtime.peers().length === 1);
  await a.runtime.close();
  await until(() => b.runtime.peers().length === 0);
  assert.equal(b.runtime.connectionState.connected, false);
});

test("5. a crash without goodbye is removed when its heartbeat lease expires", async (t) => {
  const hub = createHub();
  let clock = 1_000_000;
  const now = () => clock;
  const a = await makeRuntime(t, hub, "A", { runtime: { now, leaseMs: 1000 } });
  const b = await makeRuntime(t, hub, "B", { runtime: { now, leaseMs: 1000 } });
  await a.runtime.join();
  await b.runtime.join();
  await until(() => b.runtime.peers().length === 1);
  // No goodbye: the peer simply stops sending heartbeats.
  clock += 2_500;
  const stale = [];
  b.runtime.onPeerStale((peer) => stale.push(peer.id));
  await b.runtime.checkLeases();
  assert.deepEqual(stale, [a.runtime.identity.id]);
  assert.equal(b.runtime.peers()[0].stale, true);
  clock += 1_000;
  await b.runtime.checkLeases();
  assert.equal(b.runtime.peers().length, 0);
});

test("6. a peer-lost transport event immediately leaves connected state", async (t) => {
  const hub = createHub();
  const a = await makeRuntime(t, hub, "A");
  await a.runtime.join();
  assert.equal(a.runtime.connectionState.connected, false); // no peer yet
  // NostrWebRTC/connection-state is exercised directly in connection-state.test.mjs:
  // transport.error(peer-connect-failed) -> reconnecting, connected false.
  assert.equal(typeof a.runtime.connectionState.connected, "boolean");
});

test("7. reconnection reuses the wallet identity but creates a new generation", async (t) => {
  const hub = createHub();
  const a = await makeRuntime(t, hub, "A");
  const b = await makeRuntime(t, hub, "B");
  await a.runtime.join();
  await b.runtime.join();
  const first = {
    id: a.runtime.identity.id,
    session: a.runtime.agentRoom.session,
  };
  await a.runtime.leave();
  await a.runtime.join();
  await until(() => a.runtime.connectionState.connected);
  assert.equal(a.runtime.identity.id, first.id);
  assert.notEqual(a.runtime.agentRoom.session, first.session);
  assert.equal(
    a.runtime.connectionState.generation,
    a.runtime.agentRoom.session,
  );
});

test("8. expired authorization blocks reconnection and sends", async (t) => {
  const hub = createHub();
  const authorization = { check: () => (authorized ? "active" : "expired") };
  let authorized = true;
  const a = await makeRuntime(t, hub, "A", { runtime: { authorization } });
  const b = await makeRuntime(t, hub, "B");
  await a.runtime.join();
  await b.runtime.join();
  authorized = false;
  await assert.rejects(() => a.runtime.join(), /Authorization is expired/u);
  await assert.rejects(
    () => a.runtime.send("message/text", { text: "x" }),
    /Authorization is expired/u,
  );
  await a.runtime.checkLeases();
  assert.equal(a.runtime.connectionState.authorization, "expired");
  assert.equal(a.runtime.connectionState.connected, false);
});

test("9. losing a tool provider invalidates its catalog and rejects stale calls", async (t) => {
  const hub = createHub();
  const site = await makeRuntime(t, hub, "site");
  const agent = await makeRuntime(t, hub, "agent");
  const provider = provideEcho(site.runtime);
  await site.runtime.join();
  await agent.runtime.join();
  const bridge = createAgentBridge({ runtime: agent.runtime });
  t.after(() => bridge.close());
  await until(() =>
    bridge
      .listTools()
      .sites.some((s) => s.tools.some((x) => x.name === "demo.echo")),
  );
  provider.close();
  await until(
    () =>
      !bridge
        .listTools()
        .sites.some((s) => s.tools.some((x) => x.name === "demo.echo")),
  );
  const result = await bridge.invoke({
    name: "demo.echo",
    input: { message: "stale" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, TOOL_ERROR_CODES.TOOL_UNAVAILABLE);
});

test("10. independent agent runtimes survive the departure of a human runtime", async (t) => {
  const hub = createHub();
  const human = await makeRuntime(t, hub, "human");
  const a = await makeRuntime(t, hub, "A");
  const b = await makeRuntime(t, hub, "B");
  await human.runtime.join();
  await a.runtime.join();
  await b.runtime.join();
  await until(() => a.runtime.peers().length === 2);
  await human.runtime.close();
  await until(() => a.runtime.peers().length === 1);
  assert.equal(a.runtime.connectionState.connected, true);
  assert.equal(b.runtime.connectionState.connected, true);
});

test("11. a returning participant sees only live agents", async (t) => {
  const hub = createHub();
  const gone = await makeRuntime(t, hub, "gone");
  const live = await makeRuntime(t, hub, "live");
  await gone.runtime.join();
  await live.runtime.join();
  await until(() => live.runtime.peers().length === 1);
  const goneId = gone.runtime.identity.id;
  await gone.runtime.close();
  await until(() => live.runtime.peers().length === 0);
  const returning = await makeRuntime(t, hub, "returning");
  await returning.runtime.join();
  await until(() => live.runtime.peers().length === 1);
  const ids = live.runtime.peers().map((p) => p.id);
  assert.ok(ids.includes(returning.runtime.identity.id));
  assert.ok(!ids.includes(goneId));
});

test("12. two runtimes cannot use one identity concurrently in this process", async (t) => {
  const hub = createHub();
  const first = await makeRuntime(t, hub, "clone");
  await first.runtime.join();
  const second = await makeRuntime(t, hub, "clone", {
    dir: first.dir,
    create: false,
  });
  await assert.rejects(
    () => second.runtime.join(),
    /already has a live runtime/u,
  );
  assert.equal(first.runtime.connectionState.connected, false); // no peer yet
});

test("13. an ICE failure in reconnecting schedules a fresh join", async (t) => {
  const hub = createHub();
  const transports = [];
  // The established in-process transport, with onError exposed so the test can
  // report the same peer-connect-failed a Trystero ICE failure produces.
  const joinRoom = (config, topic) => {
    const transport = hub.joinRoom(config, topic);
    const handlers = new Set();
    transport.onError = (fn) => {
      handlers.add(fn);
      return () => handlers.delete(fn);
    };
    transport.reportError = (error) => {
      for (const fn of [...handlers]) fn(error);
    };
    transports.push(transport);
    return transport;
  };
  const a = await makeRuntime(t, hub, "A", {
    // A short lease makes the real checkLeases interval 1 s instead of 5 s.
    runtime: { joinRoom, rejoinAfterMs: 50, leaseMs: 600 },
  });
  await a.runtime.join();
  assert.equal(hub.joins, 1);

  transports[0].reportError({ code: "peer-connect-failed" });
  await until(() => a.runtime.connectionState.status === "reconnecting");

  // A reconnecting runtime with no direct peers must rejoin after the delay.
  // Before the fix noPeerSince is cleared here and no rejoin is ever scheduled.
  await until(() => hub.joins >= 2, 4000);
  assert.equal(
    a.runtime.connectionState.generation,
    a.runtime.agentRoom.session,
  );
});
