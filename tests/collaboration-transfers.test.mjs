import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { identityFor, signEnvelope } from "../packages/p2p/index.js";
import { NostrWebRTC, P2PRoom } from "../packages/p2p/p2p.js";
import { CollaborationTransfers } from "../packages/p2p/collaboration.js";

globalThis.crypto ??= webcrypto;
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

test("signed messages and attachments reach only sessions with approved scopes", async () => {
  const options = {
    origin: "https://example.test",
    capabilities: ["messages.send", "content.share"],
  };
  const sender = new P2PRoom(await wallet("sender"), "demo", options);
  sender.directPeerCount = 1;
  const receiver = new P2PRoom(await wallet("receiver"), "demo", options);
  const denied = new P2PRoom(await wallet("denied"), "demo", {
    ...options,
    capabilities: ["messages.send"],
  });
  const outgoing = new CollaborationTransfers(sender);
  const incoming = new CollaborationTransfers(receiver);
  const deniedIncoming = new CollaborationTransfers(denied);
  const received = [],
    deniedEvents = [],
    pending = [];
  incoming.subscribe((event) => received.push(event));
  deniedIncoming.subscribe((event) => deniedEvents.push(event));
  sender.subscribe(({ direction, envelope }) => {
    if (direction === "out")
      pending.push(
        Promise.all([receiver.receive(envelope), denied.receive(envelope)]),
      );
  });
  await outgoing.sendText("Hello");
  await outgoing.sendElement({ selector: "#example" });
  await outgoing.sendAttachment(
    new Blob(["image data"], { type: "image/png" }),
    { kind: "screenshot", name: "screen.png" },
  );
  await Promise.all(pending);
  assert.deepEqual(
    received.map((event) => event.type),
    ["text", "element", "attachment"],
  );
  assert.equal(await received[2].blob.text(), "image data");
  assert.deepEqual(
    deniedEvents.map((event) => event.type),
    ["text"],
  );
  await assert.rejects(
    () => deniedIncoming.sendElement({ selector: "#example" }),
    /content.share/,
  );
  outgoing.close();
  incoming.close();
  deniedIncoming.close();
});

test("invalid media and malformed or oversized chunks are rejected", async () => {
  const room = new P2PRoom(await wallet("receiver"), "demo", {
    origin: "https://example.test",
    capabilities: ["content.share"],
  });
  const transfers = new CollaborationTransfers(room);
  await assert.rejects(
    () =>
      transfers.sendAttachment(new Blob(["x"], { type: "text/html" }), {
        kind: "screenshot",
        name: "x.html",
      }),
    /Unsupported/,
  );
  await assert.rejects(
    () =>
      transfers.sendAttachment(new Blob(["x"], { type: "image/png" }), {
        kind: "screenshot",
        name: "../x.png",
      }),
    /Unsupported/,
  );
  transfers.receiveChunk({ body: {} }, "sender", {
    id: crypto.randomUUID(),
    session: "session-1",
    kind: "screenshot",
    name: "x.png",
    mime: "image/png",
    size: 999999999,
    total: 1,
    index: 0,
    data: "eA==",
  });
  assert.equal(transfers.transfers.size, 0);
  transfers.close();
});

test("multiple signed chunks reconstruct their original bytes", async () => {
  const options = {
    origin: "https://example.test",
    capabilities: ["content.share"],
  };
  const sender = new P2PRoom(await wallet("sender"), "demo", options);
  sender.directPeerCount = 1;
  const receiver = new P2PRoom(await wallet("receiver"), "demo", options);
  const outgoing = new CollaborationTransfers(sender);
  const incoming = new CollaborationTransfers(receiver);
  const bytes = new Uint8Array(30000).map((_, index) => index % 251);
  const pending = [];
  let received;
  incoming.subscribe((event) => {
    received = event;
  });
  sender.subscribe(({ direction, envelope }) => {
    if (direction === "out") pending.push(receiver.receive(envelope));
  });
  await outgoing.sendAttachment(new Blob([bytes], { type: "video/webm" }), {
    kind: "recording",
    name: "screen.webm",
  });
  await Promise.all(pending);
  assert.deepEqual(new Uint8Array(await received.blob.arrayBuffer()), bytes);
  outgoing.close();
  incoming.close();
});

test("a re-delivered completed attachment is not shown or acknowledged twice", async () => {
  const options = {
    origin: "https://example.test",
    capabilities: ["messages.send", "content.share"],
  };
  const sender = new P2PRoom(await wallet("sender"), "demo", options);
  sender.directPeerCount = 1;
  const receiver = new P2PRoom(await wallet("receiver"), "demo", options);
  const outgoing = new CollaborationTransfers(sender);
  const incoming = new CollaborationTransfers(receiver);
  const attachments = [];
  const receipts = [];
  const chunks = [];
  incoming.subscribe((event) => {
    if (event.type === "attachment") attachments.push(event);
  });
  const pending = new Set();
  const wire = (from, to) =>
    from.subscribe(({ direction, envelope }) => {
      if (direction !== "out") return;
      if (envelope.body.type === "ai-auth-receipt")
        receipts.push(envelope.body.payload.messageId);
      if (from === sender && envelope.body.type === "collab/attachment")
        chunks.push(envelope);
      const job = to.receive(envelope);
      pending.add(job);
      job.finally(() => pending.delete(job));
    });
  wire(sender, receiver);
  wire(receiver, sender);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.all([...pending]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const messageId = crypto.randomUUID();
  await outgoing.sendAttachment(new Blob(["image data"], { type: "image/png" }), {
    kind: "screenshot",
    name: "screen.png",
    messageId,
  });
  await settle();
  assert.equal(attachments.length, 1);
  assert.equal(receipts.length, 1);
  assert.equal(chunks.length, 1);

  // A transport hiccup can re-deliver the same chunk with a fresh nonce. It is
  // a different envelope but the same completed transfer.
  const replay = await signEnvelope(sender.wallet, "collab/attachment", {
    ...chunks[0].body.payload,
    nonce: "replayed-nonce-0123456789",
    expiresAt: Date.now() + 60_000,
  });
  await receiver.receive(replay);
  await settle();
  assert.equal(
    attachments.length,
    1,
    "the duplicate chunk must not be displayed again",
  );
  assert.equal(
    receipts.length,
    1,
    "the duplicate chunk must not be acknowledged again",
  );
  assert.equal(incoming.transfers.size, 0);
  outgoing.close();
  incoming.close();
});

test("expired consent or a lost peer stops an in-flight attachment", async () => {
  for (const reason of ["consent", "peer"]) {
    const room = new P2PRoom(await wallet(reason), "demo", {
      origin: "https://example.test",
      capabilities: ["content.share"],
    });
    room.directPeerCount = 1;
    let authorized = true;
    let chunks = 0;
    const transfers = new CollaborationTransfers(room, {
      authorize: () => authorized,
    });
    room.subscribe(({ direction }) => {
      if (direction === "out") {
        chunks++;
        if (reason === "consent") authorized = false;
        else room.directPeerCount = 0;
      }
    });
    await assert.rejects(
      () =>
        transfers.sendAttachment(
          new Blob([new Uint8Array(30000)], { type: "video/webm" }),
          { kind: "recording", name: "screen.webm" },
        ),
      reason === "consent" ? /authorization/ : /direct peer/,
    );
    assert.equal(chunks, 1);
    transfers.close();
  }
});

test("attachment chunks are queued until a peer connects like other events", async () => {
  const core = { receive() {} };
  const adapter = new NostrWebRTC(core);
  const envelope = {
    body: {
      type: "collab/attachment",
      payload: { expiresAt: Date.now() + 60000 },
    },
  };
  adapter.forward(envelope);
  assert.equal(adapter.outbox.length, 1, "a dropped chunk must be retryable");
  let sent = 0;
  adapter.sendAction = async () => {
    sent++;
  };
  adapter.directPeers.add("late-peer");
  await adapter.flushOutbox();
  assert.equal(sent, 1, "the queued chunk is retried when a peer joins");
});

test("codec parameters normalize for outgoing and incoming media", async () => {
  const options = {
    origin: "https://example.test",
    capabilities: ["content.share"],
  };
  const sender = new P2PRoom(await wallet("sender"), "demo", options);
  sender.directPeerCount = 1;
  const receiver = new P2PRoom(await wallet("receiver"), "demo", options);
  const outgoing = new CollaborationTransfers(sender);
  const incoming = new CollaborationTransfers(receiver);
  const payloads = [];
  const received = [];
  const pending = [];
  incoming.subscribe((event) => received.push(event));
  sender.subscribe(({ direction, envelope }) => {
    if (direction !== "out") return;
    if (envelope.body.type === "collab/attachment")
      payloads.push(envelope.body.payload);
    pending.push(receiver.receive(envelope));
  });
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  await outgoing.sendAttachment(
    new Blob([bytes], { type: "video/webm;codecs=vp9, opus" }),
    { kind: "recording", name: "screen.webm" },
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].mime, "video/webm");
  await Promise.all(pending);
  assert.equal(received.length, 1);
  assert.equal(received[0].mime, "video/webm");
  assert.equal(received[0].blob.type, "video/webm");
  assert.deepEqual(new Uint8Array(await received[0].blob.arrayBuffer()), bytes);
  outgoing.close();
  incoming.close();
});

test("incoming codec parameters normalize and stay inside the allowlist", async () => {
  const room = new P2PRoom(await wallet("receiver"), "demo", {
    origin: "https://example.test",
    capabilities: ["content.share"],
  });
  const transfers = new CollaborationTransfers(room);
  const events = [];
  transfers.subscribe((event) => events.push(event));
  const data = btoa("codec-bytes");
  transfers.receiveChunk({ body: {} }, "sender", {
    id: crypto.randomUUID(),
    session: "session-codec",
    kind: "recording",
    name: "clip.webm",
    mime: "VIDEO/WEBM;codecs=vp8",
    size: 11,
    total: 1,
    index: 0,
    data,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].mime, "video/webm");
  assert.equal(events[0].blob.type, "video/webm");
  transfers.receiveChunk({ body: {} }, "sender", {
    id: crypto.randomUUID(),
    session: "session-bad",
    kind: "recording",
    name: "clip.bin",
    mime: "application/octet-stream;codecs=webm",
    size: 11,
    total: 1,
    index: 0,
    data,
  });
  assert.equal(events.length, 1);
  transfers.close();
});

test("parameterized media outside the allowlist is still rejected", async () => {
  const room = new P2PRoom(await wallet("sender"), "demo", {
    origin: "https://example.test",
    capabilities: ["content.share"],
  });
  const transfers = new CollaborationTransfers(room);
  await assert.rejects(
    () =>
      transfers.sendAttachment(
        new Blob(["x"], { type: "text/html;codecs=webm" }),
        { kind: "screenshot", name: "x.html" },
      ),
    /Unsupported/,
  );
  await assert.rejects(
    () =>
      transfers.sendAttachment(
        new Blob(["x"], { type: "video/webm;codecs=vp9" }),
        { kind: "screenshot", name: "x.webm" },
      ),
    /Unsupported/,
  );
  transfers.close();
});

test("closing while a Nostr room starts prevents a late join", async () => {
  let joins = 0;
  const core = { receive() {}, origin: "https://example.test", room: "demo" };
  const adapter = new NostrWebRTC(core, {
    joinRoom: () => {
      joins++;
      throw new Error("unexpected join");
    },
  });
  const starting = adapter.start();
  await adapter.close();
  await assert.rejects(starting, /closed/);
  assert.equal(joins, 0);
});
