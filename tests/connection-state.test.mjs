import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  CONNECTION_STATUSES,
  CONNECTION_TRANSITIONS,
  canTransition,
  createConnectionState,
  NostrWebRTC,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

function fakeTimers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cancelled: false };
      pending.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      handle.cancelled = true;
    },
    pending,
    async fire() {
      const next = pending.find((h) => !h.cancelled && !h.done);
      if (!next) return null;
      next.done = true;
      await next.fn();
      return next;
    },
  };
}

test("transition table covers every status and only references known ones", () => {
  assert.deepEqual(Object.keys(CONNECTION_TRANSITIONS), [
    ...CONNECTION_STATUSES,
  ]);
  for (const targets of Object.values(CONNECTION_TRANSITIONS))
    for (const to of targets) assert.ok(CONNECTION_STATUSES.includes(to));
  assert.ok(canTransition("signaling", "waiting-for-peers"));
  assert.ok(!canTransition("idle", "direct-peer-connected"));
  assert.ok(!canTransition("signaling", "signaling"));
});

test("illegal transitions throw and leave the snapshot untouched", () => {
  const state = createConnectionState();
  const before = state.snapshot;
  assert.throws(() => state.transition("direct-peer-connected"), /Illegal/u);
  assert.throws(() => state.transition("bogus"), TypeError);
  assert.equal(state.snapshot, before);
  assert.equal(state.tryTransition("waiting-for-peers"), false);
  assert.equal(state.snapshot, before);
  state.transition("signaling");
  state.transition("disconnected");
  assert.throws(() => state.transition("waiting-for-peers"), /Illegal/u);
});

test("snapshots are new frozen objects", () => {
  const state = createConnectionState();
  const first = state.snapshot;
  state.transition("signaling");
  const second = state.snapshot;
  assert.notEqual(first, second);
  state.addPeer({ peerId: "p1", walletId: "w1" });
  const third = state.snapshot;
  for (const snap of [first, second, third]) {
    assert.ok(Object.isFrozen(snap));
    assert.ok(Object.isFrozen(snap.peers));
    assert.ok(Object.isFrozen(snap.diagnostics));
  }
  assert.ok(Object.isFrozen(third.peers[0]));
  assert.throws(() => {
    "use strict";
    third.status = "idle";
  }, TypeError);
  assert.equal(second.directPeerCount, 0);
  assert.equal(third.directPeerCount, 1);
});

test("listeners run in subscription order and unsubscribe stops delivery", () => {
  const state = createConnectionState();
  const calls = [];
  const offA = state.subscribe((s) => calls.push(["a", s.status]));
  state.subscribe((s) => calls.push(["b", s.status]));
  state.subscribe(() => {
    throw new Error("bad subscriber");
  });
  state.transition("signaling");
  offA();
  state.transition("waiting-for-peers");
  assert.deepEqual(calls, [
    ["a", "signaling"],
    ["b", "signaling"],
    ["b", "waiting-for-peers"],
  ]);
  assert.throws(() => state.subscribe("nope"), TypeError);
});

test("bounded retry backs off, reaches degraded, then stops", async () => {
  const timers = fakeTimers();
  const state = createConnectionState({
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 250,
    ...timers,
  });
  state.transition("signaling");
  let attempts = 0;
  const attempt = async () => {
    attempts += 1;
    throw new Error("ice failed");
  };
  assert.deepEqual(state.scheduleRetry(attempt), {
    scheduled: true,
    delayMs: 100,
  });
  const delays = [];
  for (let i = 0; i < 3; i += 1) delays.push((await timers.fire()).ms);
  assert.deepEqual(delays, [100, 200, 250]);
  assert.equal(attempts, 3);
  assert.equal(state.snapshot.status, "degraded");
  assert.equal(state.snapshot.diagnostics.retryAttempt, 3);
  assert.equal(state.snapshot.diagnostics.lastIceError, "ice failed");
  assert.equal(await timers.fire(), null, "no further retries are scheduled");
});

test("a connected peer resets retries and close cancels pending retry", () => {
  const timers = fakeTimers();
  const state = createConnectionState({ ...timers });
  state.transition("signaling");
  state.scheduleRetry(() => {});
  assert.equal(state.snapshot.diagnostics.retryAttempt, 1);
  state.addPeer({ peerId: "p" });
  assert.equal(state.snapshot.diagnostics.retryAttempt, 0);
  state.removePeer("p");
  state.scheduleRetry(() => {});
  state.transition("disconnected");
  assert.ok(timers.pending.length > 0);
  assert.ok(timers.pending.every((handle) => handle.cancelled));
});

function makeFakeTransport() {
  const t = { peers: {}, left: false };
  t.makeAction = () => ({
    onMessage: () => () => {},
    send: async () => {},
  });
  t.onPeerJoin = (h) => {
    t.join = h;
    return () => {};
  };
  t.onPeerLeave = (h) => {
    t.leave_ = h;
    return () => {};
  };
  t.onError = (h) => {
    t.error = h;
    return () => {};
  };
  t.getPeers = () => t.peers;
  t.leave = async () => {
    t.left = true;
  };
  return t;
}

function makeAdapter(transport) {
  const coreRoom = {
    origin: "https://site.example",
    room: "default",
    wallet: { name: "w" },
    subscribe: () => () => {},
    receive: async () => true,
    send: async () => {},
    start: async () => {},
  };
  return new NostrWebRTC(coreRoom, { joinRoom: () => transport });
}

test("transport: zero peers waits, join/leave track a real data channel, errors and close recorded", async () => {
  const transport = makeFakeTransport();
  const adapter = makeAdapter(transport);
  const seen = [];
  adapter.onConnectionState((s) => seen.push(s.status));
  assert.equal(adapter.connectionState.status, "idle");

  await adapter.start();
  assert.equal(adapter.connectionState.status, "waiting-for-peers");
  assert.equal(adapter.connectionState.directPeerCount, 0);

  transport.join({ peerId: "peer-1" });
  assert.equal(adapter.connectionState.status, "direct-peer-connected");
  assert.equal(adapter.connectionState.directPeerCount, 1);
  assert.equal(adapter.connectionState.peers[0].peerId, "peer-1");

  transport.error({ code: "peer-connect-failed" });
  assert.equal(
    adapter.connectionState.diagnostics.lastIceError,
    "peer-connect-failed",
  );
  assert.equal(adapter.connectionState.status, "direct-peer-connected");

  transport.leave_({ peerId: "peer-1" });
  assert.equal(adapter.connectionState.status, "waiting-for-peers");
  assert.equal(adapter.connectionState.directPeerCount, 0);

  await adapter.close();
  assert.equal(adapter.connectionState.status, "disconnected");
  assert.ok(seen.includes("signaling"));
  assert.equal(transport.left, true);
});

test("transport: sending without an open peer never reports a connected state", async () => {
  const transport = makeFakeTransport();
  const adapter = makeAdapter(transport);
  await adapter.start();
  adapter.forward({
    body: { type: "message/text", payload: { expiresAt: Date.now() + 5000 } },
  });
  assert.equal(adapter.connectionState.status, "waiting-for-peers");
  assert.equal(adapter.connectionState.directPeerCount, 0);
  await adapter.close({ expired: true });
  assert.equal(adapter.connectionState.status, "expired");
});
