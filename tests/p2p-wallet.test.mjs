import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import "fake-indexeddb/auto";
import {
  appendActivity,
  approvePermissionRequest,
  canonicalize,
  createCapabilityGrant,
  createPermissionRequest,
  identityFor,
  NonceGuard,
  P2PRoom,
  randomNonce,
  readActivity,
  signEnvelope,
  verifyPopupPermissionRequest,
  verifyCapabilityGrant,
  verifyEnvelope,
  verifyPermissionConsent,
  verifyPermissionRequest,
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

test("canonical JSON sorts keys and preserves JSON number/string rules", () => {
  assert.equal(
    canonicalize({ z: 1, a: [true, "<", -0], m: { y: 2, x: 1 } }),
    '{"a":[true,"<",0],"m":{"x":1,"y":2},"z":1}',
  );
  assert.throws(() => canonicalize({ count: Number.NaN }), /finite/);
  assert.throws(() => canonicalize({ value: "\ud800" }), /surrogate/);
  assert.throws(() => canonicalize(Array(1)), /Sparse arrays/);
});

test("signed envelopes verify signer identity and reject changed data", async () => {
  const wallet = await makeWallet("Signer");
  const envelope = await wallet.sign("test/message", {
    text: "hello",
    count: 1,
  });
  assert.equal(
    await verifyEnvelope(envelope, { expectedIssuer: wallet.id }),
    true,
  );
  assert.equal(
    await verifyEnvelope(envelope, { expectedIssuer: "agent:someone-else" }),
    false,
  );
  assert.equal(
    await verifyEnvelope({
      ...envelope,
      body: { ...envelope.body, payload: { text: "changed" } },
    }),
    false,
  );
  assert.equal(
    await verifyEnvelope({
      ...envelope,
      proof: {
        ...envelope.proof,
        publicKey: (await makeWallet("Other")).publicKey,
      },
    }),
    false,
  );
});

test("permission requests bind exact origin, explicit scopes, and expiry", async () => {
  const request = await createPermissionRequest("https://example.test", [
    "presence.read",
    "messages.send",
  ]);
  assert.equal(
    await verifyPermissionRequest(request, {
      expectedOrigin: "https://example.test",
    }),
    true,
  );
  assert.equal(
    await verifyPermissionRequest(request, {
      expectedOrigin: "https://other.test",
    }),
    false,
  );
  assert.equal(
    await verifyPermissionRequest(
      { ...request, expiresAt: Date.now() - 1 },
      { expectedOrigin: request.audience },
    ),
    false,
  );
  await assert.rejects(
    createPermissionRequest("https://example.test/path", ["presence.read"]),
    /exact HTTP origin/,
  );
  await assert.rejects(
    createPermissionRequest("https://example.test", ["*"]),
    /wildcards/,
  );
});

test("popup permission requests bind the browser origin and opener source", async () => {
  const request = await createPermissionRequest("http://localhost:4173", [
    "presence.read",
  ]);
  const opener = {};
  const message = {
    origin: "http://localhost:4173",
    source: opener,
    data: { type: "ai-auth/connect-request", request },
  };

  assert.equal(await verifyPopupPermissionRequest(message, opener), true);
  assert.equal(await verifyPopupPermissionRequest(message, {}), false);
  assert.equal(
    await verifyPopupPermissionRequest(
      { ...message, origin: "https://attacker.example" },
      opener,
    ),
    false,
  );
  assert.equal(
    await verifyPopupPermissionRequest(
      {
        ...message,
        data: {
          type: "ai-auth/connect-request",
          request: { ...request, expiresAt: Date.now() - 1 },
        },
      },
      opener,
    ),
    false,
  );
});

test("invalid permission requests do not consume the replay nonce", async () => {
  const request = await createPermissionRequest("https://example.test", [
    "presence.read",
  ]);
  const nonceGuard = new NonceGuard();
  assert.equal(
    await verifyPermissionRequest(
      { ...request, createdAt: "not a timestamp" },
      { expectedOrigin: request.audience, nonceGuard },
    ),
    false,
  );
  assert.equal(
    await verifyPermissionRequest(request, {
      expectedOrigin: request.audience,
      nonceGuard,
    }),
    true,
  );
  assert.equal(
    await verifyPermissionRequest(request, {
      expectedOrigin: request.audience,
      nonceGuard,
    }),
    false,
  );
});

test("nonce replay guards cap entries and reject overlong or long-lived values", () => {
  const guard = new NonceGuard();
  const now = Date.now();
  const expiresAt = now + 60_000;
  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(
      guard.consume(`nonce-${String(index).padStart(14, "0")}`, expiresAt, now),
      true,
    );
  }
  assert.equal(
    guard.consume("nonce-capacity-overflow-0001", expiresAt, now),
    false,
  );
  assert.equal(guard.consume("x".repeat(513), expiresAt, now), false);
  assert.equal(
    guard.consume("nonce-too-long-lived-0001", now + 120_001, now),
    false,
  );
});

test("wallet consent allows only a requested subset and cannot replay", async () => {
  const wallet = await makeWallet("Agent");
  const request = await createPermissionRequest("https://site.example", [
    "presence.read",
    "messages.send",
  ]);
  const approval = await approvePermissionRequest(wallet, request, [
    "presence.read",
  ]);
  const replay = new NonceGuard();
  const options = {
    expectedOrigin: request.audience,
    expectedWallet: wallet.id,
    nonceGuard: replay,
  };
  assert.equal(await verifyPermissionConsent(approval, request, options), true);
  assert.equal(
    await verifyPermissionConsent(approval, request, {
      expectedOrigin: request.audience,
      nonceGuard: new NonceGuard(),
    }),
    false,
  );
  assert.equal(
    await verifyPermissionConsent(approval, request, {
      expectedOrigin: request.audience,
      expectedWallet: wallet.id,
    }),
    false,
  );
  assert.equal(
    await verifyPermissionConsent(approval, request, options),
    false,
  );
  assert.equal(
    await verifyPermissionConsent(approval, request, {
      ...options,
      expectedOrigin: "https://elsewhere.example",
      nonceGuard: new NonceGuard(),
    }),
    false,
  );
  await assert.rejects(
    approvePermissionRequest(wallet, request, ["tools.invoke"]),
    /did not request/,
  );
});

test("expired or future-dated signed envelopes fail freshness validation", async () => {
  const wallet = await makeWallet("Agent");
  const envelope = await wallet.sign("test/freshness", {
    nonce: randomNonce(),
  });
  assert.equal(
    await verifyEnvelope(envelope, { now: Date.now() + 500_000 }),
    false,
  );
  assert.equal(
    await verifyEnvelope(envelope, {
      now: Date.now() - 500_000,
      maxAgeMs: 100,
    }),
    false,
  );
});

test("capability grants bind issuer, recipient, resource, operation, and expiry", async () => {
  const issuer = await makeWallet("Owner");
  const recipient = await makeWallet("Delegate");
  const expiresAt = Date.now() + 60_000;
  const grant = await createCapabilityGrant(issuer, {
    recipient: recipient.id,
    resource: "site:example.test/room:research",
    capabilities: ["messages.send"],
    expiresAt,
  });
  const expected = {
    expectedIssuer: issuer.id,
    expectedRecipient: recipient.id,
    resource: "site:example.test/room:research",
  };
  assert.equal(
    await verifyCapabilityGrant(grant, {
      ...expected,
      requiredCapability: "messages.send",
    }),
    true,
  );
  assert.equal(await verifyCapabilityGrant(grant, expected), false);
  assert.equal(
    await verifyCapabilityGrant(grant, {
      ...expected,
      requiredCapability: "tools.invoke",
    }),
    false,
  );
  assert.equal(
    await verifyCapabilityGrant(grant, {
      ...expected,
      expectedRecipient: issuer.id,
    }),
    false,
  );
  assert.equal(
    await verifyCapabilityGrant(grant, { ...expected, now: expiresAt + 1 }),
    false,
  );
  await assert.rejects(
    createCapabilityGrant(issuer, {
      recipient: recipient.id,
      resource: "x",
      capabilities: ["*"],
      expiresAt,
    }),
    /wildcards/,
  );
});

test("P2P rooms authenticate signed events and reject replay or cross-room traffic", async () => {
  const sender = await makeWallet("Sender");
  const receiver = await makeWallet("Receiver");
  const room = new P2PRoom(receiver, "research", {
    origin: "https://wallet.example",
  });
  const envelope = await sender.sign("message/text", {
    room: "research",
    origin: "https://wallet.example",
    session: "sender-session",
    nonce: randomNonce(),
    expiresAt: Date.now() + 60_000,
    text: "hello",
  });
  assert.equal(await room.receive(envelope), true);
  assert.equal(await room.receive(envelope), false);
  const otherRoom = await sender.sign("message/text", {
    room: "elsewhere",
    origin: "https://wallet.example",
    session: "sender-session",
    nonce: randomNonce(),
    expiresAt: Date.now() + 60_000,
    text: "no",
  });
  assert.equal(await room.receive(otherRoom), false);
  assert.equal(room.peers.size, 0);
  await room.close();
});

test("P2P rooms reject non-numeric expiration claims before caching replay IDs", async () => {
  const sender = await makeWallet("Sender");
  const receiver = await makeWallet("Receiver");
  const room = new P2PRoom(receiver, "research", {
    origin: "https://wallet.example",
  });
  const envelope = await sender.sign("message/text", {
    room: "research",
    origin: "https://wallet.example",
    session: "sender-session",
    nonce: randomNonce(),
    expiresAt: "never",
    text: "poison replay cache",
  });

  assert.equal(await room.receive(envelope), false);
  assert.equal(room.seen.size, 0);
  await room.close();
});

test("P2P rooms rate-limit a signed identity across multiple inbound sources", async () => {
  const sender = await makeWallet("Sender");
  const receiver = await makeWallet("Receiver");
  const room = new P2PRoom(receiver, "research", {
    origin: "https://wallet.example",
  });
  const event = (nonce) =>
    sender.sign("message/text", {
      room: "research",
      origin: "https://wallet.example",
      session: "sender-session",
      nonce,
      expiresAt: Date.now() + 60_000,
      text: "rate limit",
    });
  const sources = Array.from({ length: 4 }, () => ({}));
  for (let index = 0; index < 32; index += 1) {
    const envelope = await event(randomNonce());
    assert.equal(
      await room.receive(envelope, sources[index % sources.length]),
      true,
    );
  }
  assert.equal(await room.receive(await event(randomNonce()), {}), false);
  assert.equal(room.seen.size, 32);
  await room.close();
});

test("P2P rooms cap aggregate verified traffic across self-created identities", async () => {
  const senders = await Promise.all(
    Array.from({ length: 8 }, (_, index) => makeWallet(`Sender ${index}`)),
  );
  const receiver = await makeWallet("Receiver");
  const room = new P2PRoom(receiver, "research", {
    origin: "https://wallet.example",
  });
  const sources = senders.map(() => ({}));
  const event = (sender, nonce) =>
    sender.sign("message/text", {
      room: "research",
      origin: "https://wallet.example",
      session: `${sender.id.slice(-12)}-session`,
      nonce,
      expiresAt: Date.now() + 60_000,
      text: "room budget",
    });
  for (let senderIndex = 0; senderIndex < senders.length; senderIndex += 1) {
    const firstMessage = senderIndex === 1 ? 1 : 0;
    for (let message = firstMessage; message < 32; message += 1) {
      const source = sources[senderIndex];
      assert.equal(
        await room.receive(
          await event(senders[senderIndex], randomNonce()),
          source,
        ),
        true,
      );
    }
    if (senderIndex === 0) {
      assert.equal(
        await room.receive(await event(senders[0], randomNonce()), sources[0]),
        false,
      );
      assert.equal(
        await room.receive(await event(senders[1], randomNonce()), sources[1]),
        true,
      );
    }
  }
  assert.equal(
    await room.receive(await event(senders[0], randomNonce()), sources[0]),
    false,
  );
  assert.equal(room.seen.size, 256);
  await room.close();
});

test("direct peer channels and verification attempts have room limits", async () => {
  const wallet = await makeWallet("Peer limits");
  const room = new P2PRoom(wallet, "research", {
    origin: "https://wallet.example",
  });
  const source = {};
  const makeChannel = () => ({
    readyState: "open",
    send() {},
    close() {},
  });
  for (let index = 0; index < 4; index += 1) room.attach(makeChannel(), source);
  let extraChannelClosed = false;
  room.attach(
    {
      readyState: "connecting",
      send() {},
      close() {
        extraChannelClosed = true;
      },
    },
    source,
  );
  assert.equal(extraChannelClosed, true);

  for (let index = 0; index < 8; index += 1)
    assert.equal(room.allowInbound(source), true);
  assert.equal(room.allowInbound(source), false);

  for (let index = 1; index < 16; index += 1) {
    const nextSource = {};
    room.attach(makeChannel(), nextSource);
  }
  let extraPeerClosed = false;
  room.attach(
    {
      readyState: "connecting",
      send() {},
      close() {
        extraPeerClosed = true;
      },
    },
    {},
  );
  assert.equal(extraPeerClosed, true);
  await room.close();
});

test("activity history prunes oldest entries to its storage limit", async () => {
  const wallet = await makeWallet("Activity logger");
  for (let index = 0; index < 105; index += 1)
    await appendActivity(wallet, "test/retention", { index });
  const history = (await readActivity()).filter(
    ({ body }) => body.type === "test/retention",
  );
  assert.equal(history.length, 100);
  assert.equal(history[0].body.payload.index, 5);
  assert.equal(history.at(-1).body.payload.index, 104);
});

test("private peer sessions refuse signed presence and shared messages", async () => {
  const wallet = await makeWallet("Private");
  const room = new P2PRoom(wallet, "private", {
    privateMode: true,
    origin: "https://wallet.example",
  });
  await room.start();
  await assert.rejects(
    room.send("message/text", { text: "hidden" }),
    /private or closed/,
  );
  const remote = await makeWallet("Remote");
  const incoming = await remote.sign("message/text", {
    room: "private",
    origin: "https://wallet.example",
    session: "remote-session",
    nonce: randomNonce(),
    expiresAt: Date.now() + 30_000,
    text: "hidden",
  });
  assert.equal(await room.receive(incoming), false);
  await room.close();
});

test("expired peers notify subscribers so presence counts refresh", async () => {
  const wallet = await makeWallet("Presence expiry");
  const room = new P2PRoom(wallet, "research", {
    origin: "https://wallet.example",
  });
  room.peers.set("stale", { id: "agent:stale", seenAt: 1 });
  room.peers.set("fresh", { id: "agent:fresh", seenAt: 90_000 });
  const updates = [];
  room.subscribe((event) => updates.push(event));

  room.expire(100_000);

  assert.deepEqual([...room.peers.keys()], ["fresh"]);
  assert.deepEqual(updates, [{ direction: "state" }]);
  await room.close();
});
