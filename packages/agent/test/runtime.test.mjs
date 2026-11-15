// BroadcastChannel would link in-process runtimes outside the fake transport.
globalThis.BroadcastChannel = class {
  postMessage() {}
  close() {}
};
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileKeystore } from "../keystore.js";
import { createAgentRuntime } from "../runtime.js";
import { createHub } from "./fake-transport.mjs";
import { verifyEnvelope } from "../../p2p/index.js";

const PASS = "correct horse battery staple";
const ORIGIN = "https://site.example";
const CAPS = ["presence.read", "messages.send"];

async function setup(t, hub, extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-rt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keystore = createFileKeystore({ dir, passphrase: PASS, env: {} });
  await keystore.create({ name: "agent" });
  const runtime = createAgentRuntime({
    keystore,
    origin: ORIGIN,
    room: "lobby",
    capabilities: CAPS,
    descriptor: { name: extra.name ?? "agent" },
    joinRoom: hub.joinRoom,
    delay: async () => {},
    random: () => 0.5,
    ...extra,
  });
  t.after(() => runtime.close());
  return { runtime, keystore, dir };
}
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("condition not reached");
};

test("rejects invalid options before touching the keystore", () => {
  const ks = createFileKeystore({
    dir: "/nonexistent-x",
    passphrase: PASS,
    env: {},
  });
  const base = { keystore: ks, origin: ORIGIN, capabilities: CAPS };
  assert.throws(
    () => createAgentRuntime({ ...base, origin: "https://site.example/path" }),
    /origin/i,
  );
  assert.throws(
    () => createAgentRuntime({ ...base, origin: "http://evil.example" }),
    /origin/i,
  );
  assert.throws(
    () => createAgentRuntime({ ...base, room: "bad room!" }),
    /room/i,
  );
  assert.throws(
    () => createAgentRuntime({ ...base, capabilities: ["*"] }),
    /capabilit/i,
  );
  assert.throws(
    () => createAgentRuntime({ ...base, capabilities: [] }),
    /capabilit/i,
  );
  assert.throws(
    () =>
      createAgentRuntime({ ...base, descriptor: { name: "x".repeat(500) } }),
    /descriptor/i,
  );
  assert.throws(
    () => createAgentRuntime({ ...base, keystore: {} }),
    /keystore/i,
  );
});

test("join exposes connection state through waiting-for-peers", async (t) => {
  const hub = createHub();
  const { runtime } = await setup(t, hub);
  const seen = [];
  runtime.onConnectionState((s) => seen.push(s.status));
  assert.equal(runtime.connectionState.status, "idle");
  await runtime.join();
  assert.equal(runtime.connectionState.status, "waiting-for-peers");
  assert.ok(seen.includes("signaling"));
  assert.equal(runtime.connectionState.directPeerCount, 0);
});

test("two runtimes become direct peers and exchange verified signed events", async (t) => {
  const hub = createHub();
  const a = await setup(t, hub, { name: "A" });
  const b = await setup(t, hub, { name: "B" });
  const inbound = [];
  b.runtime.onEvent((e) => e.direction === "in" && inbound.push(e.envelope));
  const inconsistent = [];
  a.runtime.onConnectionState((s) => {
    if ((s.status === "direct-peer-connected") !== s.directPeerCount > 0)
      inconsistent.push(s.status);
  });
  await a.runtime.join();
  await b.runtime.join();
  await until(
    () => a.runtime.connectionState.status === "direct-peer-connected",
  );
  assert.deepEqual(
    inconsistent,
    [],
    "status never disagrees with the peer count",
  );
  await until(
    () => b.runtime.connectionState.status === "direct-peer-connected",
  );
  await a.runtime.send("message/text", { text: "hi" });
  await until(() => inbound.some((e) => e.body.type === "message/text"));
  const message = inbound.find((e) => e.body.type === "message/text");
  assert.equal(message.body.payload.text, "hi");
  assert.equal(message.body.issuer, a.runtime.identity.id);
  assert.equal(
    await verifyEnvelope(message, { expectedIssuer: a.runtime.identity.id }),
    true,
  );
});

test("send requires a granted capability and a joined room", async (t) => {
  const hub = createHub();
  const { runtime } = await setup(t, hub, { capabilities: ["presence.read"] });
  await assert.rejects(runtime.send("message/text", { text: "x" }), /join/i);
  await runtime.join();
  await assert.rejects(
    runtime.send("message/text", { text: "x" }),
    /did not approve/i,
  );
});

test("leave announces departure, clears the persisted room, and disconnects", async (t) => {
  const hub = createHub();
  const a = await setup(t, hub);
  const b = await setup(t, hub);
  await a.runtime.join();
  await b.runtime.join();
  await until(() => b.runtime.connectionState.directPeerCount === 1);
  await a.runtime.leave();
  assert.equal(a.runtime.connectionState.status, "disconnected");
  await until(() => b.runtime.connectionState.directPeerCount === 0);
  await assert.rejects(stat(path.join(a.dir, "runtime.json")), {
    code: "ENOENT",
  });
});

test("close keeps the last room so a restart restores it (mode 0600)", async (t) => {
  const hub = createHub();
  const first = await setup(t, hub, { room: undefined });
  await first.runtime.join("restored-room");
  const stateFile = path.join(first.dir, "runtime.json");
  if (process.platform !== "win32")
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(await readFile(stateFile, "utf8")).room,
    "restored-room",
  );
  await first.runtime.close();
  const second = createAgentRuntime({
    keystore: first.keystore,
    origin: ORIGIN,
    capabilities: CAPS,
    joinRoom: hub.joinRoom,
    delay: async () => {},
  });
  t.after(() => second.close());
  assert.equal(await second.resume(), true);
  assert.equal(second.room, "restored-room");
  assert.equal(second.connectionState.status, "waiting-for-peers");
});

test("resume ignores a persisted room for a different origin", async (t) => {
  const hub = createHub();
  const first = await setup(t, hub);
  await first.runtime.join("lobby");
  await first.runtime.close();
  const other = createAgentRuntime({
    keystore: first.keystore,
    origin: "https://other.example",
    capabilities: CAPS,
    joinRoom: hub.joinRoom,
    delay: async () => {},
  });
  assert.equal(await other.resume(), false);
});

test("a failing transport retries with bounded exponential backoff, then joins", async (t) => {
  const hub = createHub();
  hub.failJoins = 3;
  const delays = [];
  const { runtime } = await setup(t, hub, {
    delay: async (ms) => void delays.push(ms),
    backoff: { baseMs: 100, maxMs: 250, maxAttempts: 5 },
  });
  await runtime.join();
  assert.deepEqual(delays, [100, 200, 250]);
  assert.equal(runtime.connectionState.status, "waiting-for-peers");
});

test("retries are bounded: exhausting attempts ends disconnected and reports the error", async (t) => {
  const hub = createHub();
  hub.failJoins = 99;
  const errors = [];
  const { runtime } = await setup(t, hub, {
    backoff: { baseMs: 1, maxMs: 2, maxAttempts: 3 },
  });
  runtime.onError((e) => errors.push(e));
  await assert.rejects(runtime.join(), /could not join/i);
  assert.equal(hub.joins, 3);
  assert.equal(runtime.connectionState.status, "disconnected");
  assert.equal(errors.length, 1);
});

test("peers() reports leases and stale peers are surfaced once", async (t) => {
  const hub = createHub();
  let clock = 1_000_000;
  const a = await setup(t, hub, { now: () => clock, leaseMs: 10_000 });
  const b = await setup(t, hub);
  const stale = [];
  a.runtime.onPeerStale((p) => stale.push(p.id));
  await a.runtime.join();
  await b.runtime.join();
  await until(() => a.runtime.peers().length === 1);
  const [peer] = a.runtime.peers();
  assert.equal(peer.id, b.runtime.identity.id);
  assert.equal(peer.stale, false);
  assert.equal(peer.leaseExpiresAt, peer.seenAt + 10_000);
  clock += 11_000;
  a.runtime.checkLeases();
  a.runtime.checkLeases();
  assert.deepEqual(stale, [b.runtime.identity.id]);
  assert.equal(a.runtime.peers()[0].stale, true);
});

test("a silent transport is rebuilt after rejoinAfterMs without direct peers", async (t) => {
  const hub = createHub();
  let clock = 0;
  const { runtime } = await setup(t, hub, {
    now: () => clock,
    rejoinAfterMs: 5_000,
  });
  await runtime.join();
  assert.equal(hub.joins, 1);
  clock += 6_000;
  await runtime.checkLeases();
  assert.equal(hub.joins, 2);
  assert.equal(runtime.connectionState.status, "waiting-for-peers");
});

test("close is idempotent and join after close is refused", async (t) => {
  const hub = createHub();
  const { runtime } = await setup(t, hub);
  await runtime.join();
  await runtime.close();
  await runtime.close();
  await assert.rejects(runtime.join(), /closed/i);
});

test("the runtime never exposes private key material", async (t) => {
  const hub = createHub();
  const { runtime } = await setup(t, hub);
  await runtime.join();
  const dump = JSON.stringify({
    i: runtime.identity,
    s: runtime.connectionState,
  });
  assert.ok(!dump.includes('"d"'));
  assert.equal(runtime.identity.privateKey, undefined);
});
