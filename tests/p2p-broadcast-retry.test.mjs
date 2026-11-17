import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { NostrWebRTC } from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

// Mirrors Trystero 0.27's action send: an explicit target that is not open
// throws "disconnected", while a broadcast silently skips closed peers.
function fakeTrystero() {
  const peers = new Set();
  const open = new Set();
  const delivered = [];
  let joinHandler = null;
  const transport = {
    makeAction() {
      return {
        onMessage: () => () => {},
        async send(envelope, options = {}) {
          if (options.target) {
            for (const peerId of options.target) {
              if (!open.has(peerId)) {
                const error = new Error(`peer ${peerId} is not open`);
                error.code = "disconnected";
                throw error;
              }
              delivered.push({ peerId, envelope });
            }
            return;
          }
          for (const peerId of peers)
            if (open.has(peerId)) delivered.push({ peerId, envelope });
        },
      };
    },
    onPeerJoin(handler) {
      joinHandler = handler;
      return () => {
        joinHandler = null;
      };
    },
    onPeerLeave: () => () => {},
    onError: () => () => {},
    getPeers: () => Object.fromEntries([...peers].map((id) => [id, {}])),
    async leave() {},
  };
  return {
    transport,
    delivered,
    join(peerId) {
      peers.add(peerId);
      open.add(peerId);
      joinHandler?.({ peerId });
    },
    setOpen(peerId, isOpen) {
      if (isOpen) open.add(peerId);
      else open.delete(peerId);
    },
  };
}

function fakeRoom() {
  let listener = null;
  return {
    origin: "https://site.example",
    room: "research",
    wallet: { name: "Agent" },
    privateMode: false,
    restricted: false,
    capabilities: null,
    directPeerCount: 0,
    async start() {},
    async send() {
      return {};
    },
    async proveMembership() {},
    isMemberSource: () => true,
    async receive() {
      return true;
    },
    subscribe(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    emitOut(envelope) {
      listener?.({ direction: "out", envelope });
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a broadcast reaches a peer whose channel reopens after the send", async () => {
  const net = fakeTrystero();
  const room = fakeRoom();
  const adapter = new NostrWebRTC(room, {
    joinRoom: () => net.transport,
    retryMs: 10,
  });
  await adapter.start();
  net.join("a");
  net.join("b");
  await wait(5);

  // b's channel is briefly closed while the broadcast goes out.
  net.setOpen("b", false);
  const envelope = {
    body: {
      type: "message/text",
      payload: { expiresAt: Date.now() + 30_000, nonce: "n".repeat(24) },
    },
  };
  room.emitOut(envelope);
  await wait(20);
  assert.ok(
    net.delivered.some((d) => d.peerId === "a" && d.envelope === envelope),
    "the open peer receives the broadcast",
  );
  assert.ok(
    !net.delivered.some((d) => d.peerId === "b"),
    "the closed peer is not delivered to yet",
  );

  // Once b is back, the same signed envelope is delivered to it.
  net.setOpen("b", true);
  await wait(60);
  assert.ok(
    net.delivered.some((d) => d.peerId === "b" && d.envelope === envelope),
    "the reopened peer receives the broadcast it missed",
  );
  await adapter.close();
});

test("a burst of failed sends cannot grow the outbox past its cap", async () => {
  const net = fakeTrystero();
  const room = fakeRoom();
  const adapter = new NostrWebRTC(room, {
    joinRoom: () => net.transport,
    retryMs: 10,
  });
  await adapter.start();
  net.join("a"); // a direct peer exists, so forward takes the deliver branch
  await wait(5);

  // Force the send-failure branch so the real outbox enqueue code runs.
  adapter.deliver = () => Promise.reject(new Error("peer send failed"));
  for (let index = 0; index < 200; index += 1) {
    room.emitOut({
      body: {
        type: "message/text",
        payload: { expiresAt: Date.now() + 30_000 },
      },
    });
    await wait(0);
  }
  await wait(20);
  assert.ok(
    adapter.outbox.length <= 128,
    `the outbox is capped on the send-failure path (got ${adapter.outbox.length})`,
  );
  await adapter.close();
});

test("missed broadcasts are not retried past the envelope expiry", async () => {
  const net = fakeTrystero();
  const room = fakeRoom();
  const adapter = new NostrWebRTC(room, {
    joinRoom: () => net.transport,
    retryMs: 10,
  });
  await adapter.start();
  net.join("a");
  net.setOpen("a", false);
  const envelope = {
    body: {
      type: "message/text",
      payload: { expiresAt: Date.now() + 40, nonce: "m".repeat(24) },
    },
  };
  room.emitOut(envelope);
  await wait(80);
  net.setOpen("a", true);
  await wait(60);
  assert.equal(
    net.delivered.filter((d) => d.envelope === envelope).length,
    0,
    "expired events are dropped, not delivered late",
  );
  await adapter.close();
});
