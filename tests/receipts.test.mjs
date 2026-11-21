import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { identityFor, signEnvelope } from "../packages/p2p/index.js";
import { P2PRoom } from "../packages/p2p/p2p.js";
import { CollaborationTransfers } from "../packages/p2p/collaboration.js";
import {
  RECEIPT_TYPE,
  buildReceiptPayload,
  createDeliveryLedger,
  isAddressedTo,
  verifyReceipt,
} from "../packages/p2p/receipts.js";

globalThis.crypto ??= webcrypto;
const ORIGIN = "https://example.test";
const options = {
  origin: ORIGIN,
  capabilities: ["messages.send", "content.share"],
};

async function wallet(name) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    id: await identityFor(publicKey),
    name,
    publicKey,
    privateKey: keys.privateKey,
  };
}

// Three peers in one room, wired directly (no transport). Everything closes in t.after.
async function trio(t, roomName = "demo") {
  const peers = {};
  for (const name of ["alice", "bob", "carol"]) {
    const room = new P2PRoom(await wallet(name), roomName, options);
    room.directPeerCount = 1;
    const transfers = new CollaborationTransfers(room);
    const events = [];
    transfers.subscribe((event) => events.push(event));
    peers[name] = { room, transfers, events, wallet: room.wallet };
  }
  const pending = new Set();
  for (const from of Object.values(peers))
    from.room.subscribe(({ direction, envelope }) => {
      if (direction !== "out") return;
      for (const to of Object.values(peers))
        if (to !== from) {
          const job = to.room.receive(envelope);
          pending.add(job);
          job.finally(() => pending.delete(job));
        }
    });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.all([...pending]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  t.after(async () => {
    for (const peer of Object.values(peers)) {
      peer.transfers.close();
      await peer.room.close();
    }
  });
  return { ...peers, settle };
}

const types = (events) => events.map((event) => event.type);

test("a targeted message is dropped by every wallet except its target", async (t) => {
  const { alice, bob, carol, settle } = await trio(t);
  await alice.transfers.sendText("for bob", { target: bob.wallet.id });
  await alice.transfers.sendElement({ tag: "p" }, { target: bob.wallet.id });
  await settle();
  assert.deepEqual(types(bob.events), ["text", "element"]);
  assert.deepEqual(carol.events, []);
  await alice.transfers.sendText("for all");
  await settle();
  assert.ok(types(carol.events).includes("text"));
});

test("targeted attachments are dropped chunk by chunk by non-targets", async (t) => {
  const { alice, bob, carol, settle } = await trio(t);
  await alice.transfers.sendAttachment(
    new Blob(["png"], { type: "image/png" }),
    {
      kind: "screenshot",
      name: "s.png",
      target: bob.wallet.id,
    },
  );
  await settle();
  assert.deepEqual(
    types(bob.events).filter((x) => x === "attachment"),
    ["attachment"],
  );
  assert.deepEqual(carol.events, []);
  assert.equal(carol.transfers.transfers.size, 0);
});

test("malformed target or message id is rejected before sending", async (t) => {
  const { alice } = await trio(t);
  await assert.rejects(
    () => alice.transfers.sendText("x", { target: "bob" }),
    /target/,
  );
  await assert.rejects(
    () => alice.transfers.sendText("x", { messageId: "nope" }),
    /message id/,
  );
  assert.equal(isAddressedTo({ target: "bob" }, "bob"), false);
  assert.equal(isAddressedTo({}, "anyone"), true);
});

test("only the addressed receiver signs a receipt, and the sender sees it", async (t) => {
  const { alice, bob, carol, settle } = await trio(t);
  const messageId = crypto.randomUUID();
  await alice.transfers.sendText("hi", { target: bob.wallet.id, messageId });
  await settle();
  const receipts = alice.events.filter((event) => event.type === "receipt");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receipt.messageId, messageId);
  assert.equal(receipts[0].receipt.receiver, bob.wallet.id);
  assert.deepEqual(carol.events, []);
});

test("every other peer acknowledges a broadcast, and receipts can be disabled", async (t) => {
  const { alice, settle } = await trio(t);
  await alice.transfers.sendText("hi");
  await settle();
  assert.deepEqual(
    alice.events.filter((event) => event.type === "receipt").length,
    2,
  );
  const quiet = new CollaborationTransfers(alice.room, { receipts: false });
  t.after(() => quiet.close());
  assert.equal(quiet.supportsReceipts, false);
});

async function signedReceipt(
  signer,
  { room = "demo", origin = ORIGIN, ...fields },
) {
  const receiverRoom = new P2PRoom(signer, room, { origin });
  receiverRoom.session = crypto.randomUUID();
  const envelope = await receiverRoom.send(RECEIPT_TYPE, fields.payload);
  await receiverRoom.close();
  return envelope;
}

async function setup() {
  const [alice, bob, mallory] = await Promise.all([
    wallet("a"),
    wallet("b"),
    wallet("m"),
  ]);
  const messageId = crypto.randomUUID();
  const payload = buildReceiptPayload({
    messageId,
    sender: alice.id,
    receiver: bob.id,
  });
  const expected = { sender: alice.id, room: "demo", origin: ORIGIN };
  return { alice, bob, mallory, messageId, payload, expected };
}

test("verifyReceipt accepts a genuine receipt", async () => {
  const { bob, payload, expected, messageId } = await setup();
  const envelope = await signedReceipt(bob, { payload });
  const result = await verifyReceipt(envelope, expected);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.messageId, messageId);
  assert.equal(result.receipt.receiver, bob.id);
});

test("verifyReceipt checks envelope expiry against the injected clock", async () => {
  const { bob, payload, expected } = await setup();
  const envelope = await signedReceipt(bob, { payload });
  // The injected clock is well past the receipt's expiresAt. A correct
  // checkBinding() uses `now`, not Date.now(), and rejects it.
  const future = Date.now() + 10 * 60 * 1000;
  const result = await verifyReceipt(envelope, {
    ...expected,
    now: future,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "expired-envelope");
});

test("verifyReceipt rejects forged, tampered and mis-bound receipts", async () => {
  const { alice, bob, mallory, payload, expected } = await setup();
  const real = await signedReceipt(bob, { payload });
  // Forged: mallory signs but names bob as the receiver.
  const forged = await signedReceipt(mallory, { payload });
  assert.equal(
    (await verifyReceipt(forged, expected)).reason,
    "receiver-mismatch",
  );
  // Tampered after signing.
  const tampered = structuredClone(real);
  tampered.body.payload.messageId = crypto.randomUUID();
  assert.equal(
    (await verifyReceipt(tampered, expected)).reason,
    "bad-signature",
  );
  // Key swapped for mallory's: issuer no longer derives from the key.
  const swapped = structuredClone(real);
  swapped.proof.publicKey = mallory.publicKey;
  assert.equal(
    (await verifyReceipt(swapped, expected)).reason,
    "bad-signature",
  );
  // Wrong room / origin / sender.
  assert.equal(
    (await verifyReceipt(real, { ...expected, room: "other" })).reason,
    "wrong-room",
  );
  assert.equal(
    (await verifyReceipt(real, { ...expected, origin: "https://evil.test" }))
      .reason,
    "wrong-origin",
  );
  assert.equal(
    (await verifyReceipt(real, { ...expected, sender: mallory.id })).reason,
    "wrong-sender",
  );
  // Receipt from a wallet to itself, and a non-receipt envelope.
  const own = buildReceiptPayload({
    messageId: crypto.randomUUID(),
    sender: alice.id,
    receiver: alice.id,
  });
  assert.equal(
    (
      await verifyReceipt(
        await signedReceipt(alice, { payload: own }),
        expected,
      )
    ).reason,
    "self-receipt",
  );
  const other = await signEnvelope(bob, "message/text", { text: "x" });
  assert.equal(
    (await verifyReceipt(other, expected)).reason,
    "not-a-v1-receipt",
  );
  assert.equal((await verifyReceipt(null, expected)).ok, false);
});

test("a receipt signed for another room is not accepted by a transfer in this room", async (t) => {
  const { alice, settle } = await trio(t, "room-a");
  const stray = await wallet("stray");
  const payload = buildReceiptPayload({
    messageId: crypto.randomUUID(),
    sender: alice.wallet.id,
    receiver: stray.id,
  });
  const wrongRoom = await signedReceipt(stray, { payload, room: "room-b" });
  await alice.room.receive(wrongRoom);
  await settle();
  assert.deepEqual(
    alice.events.filter((event) => event.type === "receipt"),
    [],
  );
});

function ledgerWith(overrides = {}) {
  let time = 1_000_000;
  const ledger = createDeliveryLedger({
    now: () => time,
    ttlMs: 60_000,
    ...overrides,
  });
  return { ledger, advance: (ms) => (time += ms), time: () => time };
}
const receiptFor = (
  messageId,
  receiver,
  time,
  nonce = `${receiver}-nonce-0123456789`,
) => ({
  messageId,
  receiver,
  receivedAt: time,
  nonce,
});

test("ledger walks composing → queued → sent-to-transport → received-by-peer", async () => {
  const { ledger, time } = ledgerWith();
  const [, bob] = await Promise.all([wallet("a"), wallet("b")]);
  const id = crypto.randomUUID();
  const seen = [];
  ledger.subscribe((entry) => seen.push(entry.state));
  ledger.begin({ messageId: id, kind: "text" });
  assert.throws(() => ledger.markSent(id), /Illegal/);
  assert.equal(
    ledger.applyReceipt(receiptFor(id, bob.id, time())).reason,
    "not-awaiting-receipt",
  );
  ledger.queue(id);
  ledger.markSent(id);
  assert.equal(ledger.get(id).state, "sent-to-transport");
  assert.equal(ledger.applyReceipt(receiptFor(id, bob.id, time())).ok, true);
  assert.equal(ledger.get(id).state, "received-by-peer");
  assert.deepEqual(ledger.get(id).receivers, [bob.id]);
  assert.deepEqual(seen, [
    "composing",
    "queued",
    "sent-to-transport",
    "received-by-peer",
  ]);
  assert.throws(() => ledger.fail(id, "late"), /Illegal/);
});

test("ledger rejects replayed, unknown, wrong-receiver and late receipts", async () => {
  const { ledger, advance, time } = ledgerWith();
  const [bob, carol] = await Promise.all([wallet("b"), wallet("c")]);
  const id = crypto.randomUUID();
  ledger.begin({ messageId: id, kind: "text", target: bob.id });
  ledger.queue(id);
  ledger.markSent(id);
  assert.equal(
    ledger.applyReceipt(receiptFor(id, carol.id, time())).reason,
    "wrong-receiver",
  );
  assert.equal(
    ledger.applyReceipt(receiptFor(crypto.randomUUID(), bob.id, time())).reason,
    "unknown-message",
  );
  assert.equal(ledger.applyReceipt(receiptFor(id, bob.id, time())).ok, true);
  assert.equal(
    ledger.applyReceipt(receiptFor(id, bob.id, time())).reason,
    "replay",
  );
  const open = crypto.randomUUID();
  ledger.begin({ messageId: open, kind: "text" });
  ledger.queue(open);
  ledger.markSent(open);
  assert.equal(
    ledger.applyReceipt(
      receiptFor(open, bob.id, time(), "shared-nonce-0123456789ab"),
    ).ok,
    true,
  );
  assert.equal(
    ledger.applyReceipt(
      receiptFor(open, carol.id, time(), "shared-nonce-0123456789ab"),
    ).reason,
    "replay",
  );
  const late = crypto.randomUUID();
  ledger.begin({ messageId: late, kind: "text" });
  ledger.queue(late);
  ledger.markSent(late);
  advance(61_000);
  assert.equal(
    ledger.applyReceipt(
      receiptFor(late, bob.id, time(), "late-nonce-0123456789abcd"),
    ).reason,
    "expired",
  );
});

test("broadcast collects every distinct receiver; sweep expires silent messages", async () => {
  const { ledger, advance, time } = ledgerWith();
  const [bob, carol] = await Promise.all([wallet("b"), wallet("c")]);
  const id = crypto.randomUUID();
  ledger.begin({ messageId: id, kind: "text" });
  ledger.queue(id);
  ledger.markSent(id);
  ledger.applyReceipt(
    receiptFor(id, bob.id, time(), "nonce-one-0123456789abcd"),
  );
  ledger.applyReceipt(
    receiptFor(id, carol.id, time(), "nonce-two-0123456789abcd"),
  );
  assert.equal(ledger.get(id).receivers.length, 2);
  const silent = crypto.randomUUID();
  ledger.begin({ messageId: silent, kind: "element" });
  ledger.queue(silent);
  ledger.markSent(silent);
  advance(61_000);
  ledger.sweep();
  assert.equal(ledger.get(silent).state, "expired");
  assert.equal(ledger.get(id).state, "received-by-peer");
});

test("ledger history is bounded and failures keep a bounded message", () => {
  const { ledger } = ledgerWith({ limit: 3 });
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  for (const id of ids) ledger.begin({ messageId: id, kind: "text" });
  assert.equal(ledger.list().length, 3);
  assert.equal(ledger.get(ids[0]), undefined);
  ledger.queue(ids[4]);
  ledger.fail(ids[4], new Error("x".repeat(500)));
  assert.equal(ledger.get(ids[4]).state, "failed");
  assert.ok(ledger.get(ids[4]).error.length <= 200);
  assert.throws(
    () => ledger.begin({ messageId: ids[4], kind: "text" }),
    /Duplicate/,
  );
  assert.throws(
    () => ledger.begin({ messageId: "bad", kind: "text" }),
    /message id/,
  );
});
