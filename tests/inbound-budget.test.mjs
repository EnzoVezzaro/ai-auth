import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  identityFor,
  P2PRoom,
  randomNonce,
  signEnvelope,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

async function makeWallet(name) {
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
    sign: (type, payload) =>
      signEnvelope(
        { id, publicKey, privateKey: pair.privateKey },
        type,
        payload,
      ),
  };
}

const ORIGIN = "https://wallet.example";

test("a cursor stream does not use up the budget for chat messages", async () => {
  const sender = await makeWallet("Human");
  const receiver = await makeWallet("Agent");
  const room = new P2PRoom(receiver, "research", { origin: ORIGIN });
  const envelope = (type, nonce, extra = {}) =>
    sender.sign(type, {
      room: "research",
      origin: ORIGIN,
      session: "human-session",
      nonce,
      expiresAt: Date.now() + 60_000,
      ...extra,
    });
  const source = {};

  // A cursor moving on the page sends far more presence events than the
  // budget allows; the budget must bound them.
  let cursorsAccepted = 0;
  for (let index = 0; index < 40; index += 1) {
    const cursor = await envelope("presence/cursor", randomNonce(), {
      cursor: { x: index, y: index },
    });
    if (await room.receive(cursor, source)) cursorsAccepted += 1;
  }
  assert.ok(cursorsAccepted < 40, "cursor events are still bounded");

  // The chat message from the same source must still be delivered.
  const chat = await envelope("message/text", randomNonce(), {
    text: "hello after the cursor moved",
  });
  assert.equal(
    await room.receive(chat, source),
    true,
    "a chat message is not dropped because of cursor traffic",
  );
  await room.close();
});

test("the presence budget still limits a flood of heartbeats", async () => {
  const sender = await makeWallet("Flooder");
  const receiver = await makeWallet("Agent");
  const room = new P2PRoom(receiver, "research", { origin: ORIGIN });
  const source = {};
  let accepted = 0;
  for (let index = 0; index < 60; index += 1) {
    const heartbeat = await sender.sign("peer/heartbeat", {
      room: "research",
      origin: ORIGIN,
      session: "flood-session",
      nonce: randomNonce(),
      expiresAt: Date.now() + 60_000,
      label: "Flooder",
    });
    if (await room.receive(heartbeat, source)) accepted += 1;
  }
  assert.ok(accepted < 60, "heartbeats are rate limited");
  await room.close();
});

test("one attached peer can complete several quick agent calls", async () => {
  const sender = await makeWallet("Agent");
  const receiver = await makeWallet("Site");
  const room = new P2PRoom(receiver, "research", { origin: ORIGIN });
  // A real data channel: attach() gives the peer its per-channel budget.
  const channel = {
    readyState: "open",
    send() {},
    close() {},
    onmessage: null,
    onopen: null,
    onclose: null,
    onerror: null,
  };
  const source = {};
  room.attach(channel, source);
  // Three calls, each a request, a started action, a completion and a
  // receipt, all inside one 10 second window.
  let accepted = 0;
  for (let index = 0; index < 12; index += 1) {
    const envelope = await sender.sign("message/text", {
      room: "research",
      origin: ORIGIN,
      session: "agent-session",
      nonce: randomNonce(),
      expiresAt: Date.now() + 60_000,
      text: `call step ${index}`,
    });
    if (await room.receive(envelope, source)) accepted += 1;
  }
  assert.equal(accepted, 12, "all quick calls from one peer are delivered");
  await room.close();
});

test("a room-wide presence burst does not block chat from other identities", async () => {
  const receiver = await makeWallet("Agent");
  const room = new P2PRoom(receiver, "research", { origin: ORIGIN });
  // Nine identities, 32 presence events each, exceed the room's inbound cap.
  const crowd = await Promise.all(
    Array.from({ length: 9 }, (_, index) => makeWallet(`Crowd ${index}`)),
  );
  for (const [index, wallet] of crowd.entries()) {
    for (let event = 0; event < 32; event += 1) {
      await room.receive(
        await wallet.sign("presence/cursor", {
          room: "research",
          origin: ORIGIN,
          session: `crowd-${index}-session`,
          nonce: randomNonce(),
          expiresAt: Date.now() + 60_000,
          cursor: { x: event, y: event },
        }),
        {},
      );
    }
  }
  const human = await makeWallet("Human");
  const chat = await human.sign("message/text", {
    room: "research",
    origin: ORIGIN,
    session: "human-session",
    nonce: randomNonce(),
    expiresAt: Date.now() + 60_000,
    text: "hello from the human",
  });
  assert.equal(
    await room.receive(chat, {}),
    true,
    "chat is not rejected by the room-wide cursor burst",
  );
  await room.close();
});
