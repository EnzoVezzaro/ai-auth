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

test("relaysConnected is unknown (null) until a real count is supplied", () => {
  const state = createConnectionState();
  assert.equal(state.snapshot.diagnostics.relaysConnected, null);
  assert.equal(state.snapshot.diagnostics.retryAttempt, undefined);
  state.setRelaysConnected(2);
  assert.equal(state.snapshot.diagnostics.relaysConnected, 2);
  assert.throws(() => state.setRelaysConnected(-1), TypeError);
  state.setRelaysConnected(null);
  assert.equal(state.snapshot.diagnostics.relaysConnected, null);
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
  assert.equal(adapter.connectionState.diagnostics.relaysConnected, null);

  transport.join({ peerId: "peer-1" });
  assert.equal(adapter.connectionState.status, "direct-peer-connected");
  assert.equal(adapter.connectionState.directPeerCount, 1);
  assert.equal(adapter.connectionState.peers[0].peerId, "peer-1");

  assert.equal(adapter.connectionState.connected, true);
  transport.error({ code: "peer-connect-failed" });
  assert.equal(
    adapter.connectionState.diagnostics.lastIceError,
    "peer-connect-failed",
  );
  // A terminal transport failure invalidates connectivity immediately.
  assert.equal(adapter.connectionState.status, "reconnecting");
  assert.equal(adapter.connectionState.connected, false);
  assert.equal(adapter.connectionState.directPeerCount, 0);

  transport.leave_({ peerId: "peer-1" });
  assert.equal(adapter.connectionState.status, "reconnecting");
  assert.equal(adapter.connectionState.directPeerCount, 0);

  await adapter.close();
  assert.equal(adapter.connectionState.status, "disconnected");
  assert.ok(seen.includes("signaling"));
  assert.equal(transport.left, true);
});

test("setAuthorization reports the real outcome and invalidate() preserves terminal states", () => {
  const revoked = createConnectionState();
  revoked.transition("connecting");
  revoked.setGeneration("session-1");
  revoked.setAuthorization("revoked");
  assert.equal(revoked.snapshot.status, "revoked");
  assert.equal(revoked.snapshot.authorization, "revoked");
  assert.equal(revoked.snapshot.generation, "session-1");
  revoked.invalidate();
  assert.equal(
    revoked.snapshot.status,
    "revoked",
    "a transport loss must not put a revoked session back into reconnecting",
  );
  assert.equal(revoked.snapshot.connected, false);
  assert.equal(revoked.snapshot.generation, null);
  assert.equal(revoked.snapshot.directPeerCount, 0);

  const expired = createConnectionState();
  expired.transition("approval-pending");
  expired.setAuthorization("expired");
  assert.equal(
    expired.snapshot.status,
    "expired",
    "an expired grant must be labelled expired, not revoked",
  );
  assert.equal(expired.snapshot.authorization, "expired");
  expired.invalidate();
  assert.equal(
    expired.snapshot.status,
    "expired",
    "an expired grant stays ended after a transport loss",
  );
  assert.equal(expired.snapshot.connected, false);

  // A terminal state cannot re-acquire peers without an explicit reconnect.
  assert.equal(expired.addPeer({ peerId: "late-peer" }), expired.snapshot);
  assert.equal(expired.snapshot.directPeerCount, 0);

  // Reauthorization alone is not a reconnect: invalidate still preserves the
  // terminal status, so recovery requires an explicit transition to idle.
  expired.setAuthorization("active");
  expired.invalidate();
  assert.equal(expired.snapshot.status, "expired");

  // Active authorization still recovers via reconnecting.
  const active = createConnectionState();
  active.transition("connecting");
  active.setGeneration("session-2");
  active.invalidate();
  assert.equal(active.snapshot.status, "reconnecting");
  assert.equal(active.snapshot.generation, null);
});

test("transport: a null error is handled without throwing", async () => {
  const transport = makeFakeTransport();
  const coreRoom = {
    origin: "https://site.example",
    room: "default",
    wallet: { name: "w" },
    subscribe: () => () => {},
    receive: async () => true,
    send: async () => {},
    start: async () => {},
  };
  const statuses = [];
  const adapter = new NostrWebRTC(coreRoom, {
    joinRoom: () => transport,
    onStatus: (message) => statuses.push(message),
  });
  await adapter.start();

  // Trystero can emit without an error object; the callback must not throw.
  assert.doesNotThrow(() => transport.error(null));
  assert.ok(
    statuses.includes("The peer collaboration room reported an error"),
    "a generic status is still reported",
  );
  assert.equal(
    adapter.connectionState.status,
    "waiting-for-peers",
    "only a peer-connect-failed code invalidates the connection",
  );
  await adapter.close();
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

test("authenticated peers: identity/session/generation are exposed and cleared on loss", () => {
  const state = createConnectionState();
  state.transition("signaling");
  state.transition("waiting-for-peers");
  state.addPeer({ peerId: "pA" });
  // An open data channel is connectivity, not identity.
  assert.equal(state.snapshot.connected, true);
  assert.equal(state.snapshot.authenticatedConnected, false);
  assert.deepEqual(state.snapshot.authenticatedPeers, []);

  state.setAuthenticatedPeers([
    {
      peerId: "pA",
      walletId: "wA",
      sessionId: "session-A-1234",
      generation: "g1",
    },
  ]);
  assert.equal(state.snapshot.authenticatedConnected, true);
  assert.ok(Object.isFrozen(state.snapshot.authenticatedPeers));
  assert.ok(Object.isFrozen(state.snapshot.authenticatedPeers[0]));
  assert.deepEqual(
    { ...state.snapshot.authenticatedPeers[0] },
    {
      peerId: "pA",
      walletId: "wA",
      sessionId: "session-A-1234",
      generation: "g1",
    },
  );

  // A new generation is a new transport session: old proofs cannot survive it.
  state.setGeneration("g2");
  assert.equal(state.snapshot.generation, "g2");
  assert.deepEqual(state.snapshot.authenticatedPeers, []);
  assert.equal(state.snapshot.authenticatedConnected, false);
  assert.equal(
    state.snapshot.connected,
    true,
    "the channel is still open even though no peer is authenticated",
  );
  assert.throws(() => state.setAuthenticatedPeers({}), TypeError);
});

test("B02: another live peer never replaces the expected authenticated peer", async () => {
  const transport = makeFakeTransport();
  const coreRoom = {
    origin: "https://site.example",
    room: "default",
    wallet: { name: "w" },
    session: "site-session-1234",
    peers: new Map(),
    subscribers: new Set(),
    subscribe(listener) {
      this.subscribers.add(listener);
      return () => this.subscribers.delete(listener);
    },
    notify(message) {
      for (const listener of [...this.subscribers]) listener(message);
    },
    receive: async () => true,
    send: async () => {},
    start: async () => {},
  };
  const adapter = new NostrWebRTC(coreRoom, { joinRoom: () => transport });
  await adapter.start();

  // A's channel opens. A signed envelope is what authenticates it; until then
  // the channel alone only produces lenient `connected`.
  transport.join({ peerId: "peer-A" });
  assert.equal(adapter.connectionState.connected, true);
  assert.equal(adapter.connectionState.authenticatedConnected, false);
  const sourceA = { peerId: "peer-A" };
  adapter.peerSources.set("peer-A", sourceA);
  coreRoom.peers.set("wA:session-A-1234", {
    id: "wA",
    session: "session-A-1234",
    source: sourceA,
    seenAt: Date.now(),
  });
  coreRoom.notify({ direction: "in" });
  assert.equal(adapter.connectionState.authenticatedConnected, true);
  assert.deepEqual(
    adapter.connectionState.authenticatedPeers.map((p) => p.walletId),
    ["wA"],
  );

  // B joins with its own signed identity. Both peers are now authenticated,
  // but B is not the agent the page is waiting for.
  transport.join({ peerId: "peer-B" });
  const sourceB = { peerId: "peer-B" };
  adapter.peerSources.set("peer-B", sourceB);
  coreRoom.peers.set("wB:session-B-1234", {
    id: "wB",
    session: "session-B-1234",
    source: sourceB,
    seenAt: Date.now(),
  });
  coreRoom.notify({ direction: "in" });
  assert.equal(adapter.connectionState.directPeerCount, 2);
  assert.deepEqual(
    adapter.connectionState.authenticatedPeers.map((p) => p.walletId),
    ["wA", "wB"],
  );

  // A leaves (bare channel close; no goodbye). B's channel stays open and B is
  // still authenticated — yet the snapshot no longer contains peer A.
  transport.leave_({ peerId: "peer-A" });
  const snapshot = adapter.connectionState;
  assert.equal(snapshot.directPeerCount, 1, "B's data channel is still open");
  assert.equal(snapshot.authenticatedConnected, true, "B is still live");
  assert.deepEqual(
    snapshot.authenticatedPeers.map((p) => p.walletId),
    ["wB"],
    "the expected peer A is gone",
  );
  assert.equal(
    snapshot.authenticatedPeers.some(
      (p) => p.walletId === "wA" && p.sessionId === "session-A-1234",
    ),
    false,
    "B's presence must not keep the proof-bound peer A online",
  );
  await adapter.close();
});
