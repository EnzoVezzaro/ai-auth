import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  approvePermissionRequest,
  canonicalize,
  createCapabilityGrant,
  createPermissionRequest,
  identityFor,
  NonceGuard,
  P2PRoom,
  randomNonce,
  signEnvelope,
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
