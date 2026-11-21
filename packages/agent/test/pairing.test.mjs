// Pairing responder contract: answer only the matching, unexpired challenge,
// with a self-describing descriptor whose private key never leaves the process.
import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  createAgentDescriptor,
  createInstanceId,
  identityFor,
  randomNonce,
  signEnvelope,
  verifyAgentDescriptor,
} from "@enzovezzaro/ai-auth-wallet";
import {
  createAccessGrantRevocation,
  createPairingGrant,
  createPairingResponder,
  grantKey,
  verifyAccessGrantRevocation,
} from "../pairing.js";
import { createPairingVerifier } from "../../../apps/connect-agent/pairing.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const ROOM = "research";
const NOW = 1_800_000_000_000;

async function makeWallet() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    id: await identityFor(publicKey),
    publicKey,
    privateKey: keys.privateKey,
  };
}

function createHarness(siteWallet, agentWallet) {
  const listeners = { site: new Set(), agent: new Set() };
  const delivered = { site: [], agent: [] };
  const sign = async (type, wallet, payload, extra = {}) =>
    signEnvelope(wallet, type, {
      ...payload,
      room: extra.room ?? ROOM,
      origin: extra.origin ?? ORIGIN,
      session: extra.session ?? "session-12345678",
      nonce: extra.wireNonce ?? randomNonce(),
      expiresAt: extra.wireExpiresAt ?? Date.now() + 60_000,
    });
  const deliver = async (to, envelope) => {
    delivered[to].push(envelope);
    const event = {
      direction: "in",
      envelope,
      peer: { id: envelope.body.issuer },
    };
    for (const listener of [...listeners[to]]) await listener(event);
  };
  const makeRoom = (key, wallet) => ({
    async send(type, payload = {}, extra = {}) {
      const envelope = await sign(type, wallet, payload, extra);
      await deliver(key === "site" ? "agent" : "site", envelope);
      return envelope;
    },
    subscribe(listener) {
      listeners[key].add(listener);
      return () => listeners[key].delete(listener);
    },
  });
  return {
    siteRoom: makeRoom("site", siteWallet),
    agentRoom: makeRoom("agent", agentWallet),
    sign,
    deliver,
    delivered,
    listeners,
  };
}

async function setup({ ttlMs = 60_000 } = {}) {
  const siteWallet = await makeWallet();
  const agent = await makeWallet();
  const instanceId = createInstanceId();
  const h = createHarness(siteWallet, agent);
  const clock = { site: NOW, agent: NOW };
  const proofs = [];
  const verifier = createPairingVerifier({
    siteWallet,
    siteRoom: h.siteRoom,
    origin: ORIGIN,
    room: ROOM,
    expected: { walletId: agent.id, instanceId },
    now: () => clock.site,
    ttlMs,
  });
  verifier.onVerified((proof) => proofs.push(proof));
  const responder = createPairingResponder({
    wallet: agent,
    instanceId,
    origin: ORIGIN,
    room: ROOM,
    siteRoom: h.agentRoom,
    provider: "acme",
    model: "model-x",
    now: () => clock.agent,
  });
  return {
    siteWallet,
    agent,
    instanceId,
    h,
    clock,
    verifier,
    responder,
    proofs,
  };
}

const sendChallenge = async (s, overrides = {}) => {
  const challenge = await signEnvelope(s.siteWallet, "agent/pair-challenge", {
    challengeId: randomNonce(),
    nonce: randomNonce(),
    origin: overrides.origin ?? ORIGIN,
    room: overrides.room ?? ROOM,
    walletId: overrides.walletId ?? s.agent.id,
    instanceId: overrides.instanceId ?? s.instanceId,
    sessionId: "session-12345678",
    capabilities: ["messages.send"],
    expiresAt: overrides.expiresAt ?? NOW + 60_000,
  });
  return s.h.siteRoom.send("agent/pair-challenge", { challenge });
};

test("responder answers the matching challenge end-to-end", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  assert.equal(s.proofs.length, 1);
  assert.equal(s.proofs[0].walletId, s.agent.id);
  assert.equal(s.proofs[0].instanceId, s.instanceId);
  assert.equal(s.proofs[0].claims.provider, "acme");
  assert.equal(s.proofs[0].claims.model, "model-x");
  assert.equal(s.proofs[0].claims.selfReported, true);
  assert.equal(started.challenge.body.type, "agent/pair-challenge");
});

test("descriptor carries only public material and self-reported claims", async () => {
  const s = await setup();
  await s.verifier.start();
  const proofEvent = s.h.delivered.site.find(
    (envelope) => envelope.body.type === "agent/pair-proof",
  );
  assert.ok(proofEvent, "a proof was sent");
  const descriptor = proofEvent.body.payload.descriptor;
  assert.deepEqual(Object.keys(descriptor).sort(), [
    "agentType",
    "capabilities",
    "expiresAt",
    "instanceId",
    "issuedAt",
    "model",
    "nonce",
    "origin",
    "protocolVersion",
    "provider",
    "publicKey",
    "room",
    "runtime",
    "sessionId",
    "signature",
    "type",
    "v",
    "walletId",
  ]);
  assert.equal(JSON.stringify(descriptor).includes("privateKey"), false);
  assert.equal(descriptor.provider, "acme");
  assert.equal(descriptor.model, "model-x");
  const checked = await verifyAgentDescriptor(descriptor, {
    expectedOrigin: ORIGIN,
    expectedRoom: ROOM,
    expectedNonce: descriptor.nonce,
    now: NOW + 1000,
  });
  assert.equal(checked.ok, true);
});

test("challenge for a different wallet or instance is ignored", async () => {
  const s = await setup();
  const other = await makeWallet();
  await sendChallenge(s, { walletId: other.id });
  await sendChallenge(s, { instanceId: createInstanceId() });
  const sentProofs = s.h.delivered.site.filter(
    (envelope) => envelope.body.type === "agent/pair-proof",
  );
  assert.equal(sentProofs.length, 0);
});

test("challenge for a different origin or room is ignored", async () => {
  const s = await setup();
  await sendChallenge(s, { origin: "https://evil.example" });
  await sendChallenge(s, { room: "other-room" });
  const sentProofs = s.h.delivered.site.filter(
    (envelope) => envelope.body.type === "agent/pair-proof",
  );
  assert.equal(sentProofs.length, 0);
});

test("expired challenge is ignored", async () => {
  const s = await setup();
  await sendChallenge(s, { expiresAt: NOW - 1000 });
  const sentProofs = s.h.delivered.site.filter(
    (envelope) => envelope.body.type === "agent/pair-proof",
  );
  assert.equal(sentProofs.length, 0);
});

test("close() unsubscribes the responder", async () => {
  const s = await setup();
  s.responder.close();
  await s.verifier.start();
  const sentProofs = s.h.delivered.site.filter(
    (envelope) => envelope.body.type === "agent/pair-proof",
  );
  assert.equal(sentProofs.length, 0);
  assert.equal(s.proofs.length, 0);
});

test("responder never emits the wallet private key in any outbound envelope", async () => {
  const s = await setup();
  await s.verifier.start();
  const forbidden = new Set(["privateKey", "d", "p", "q", "dp", "dq", "qi"]);
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        assert.equal(forbidden.has(key), false, `leaked key: ${key}`);
        walk(child);
      }
    }
  };
  for (const envelope of s.h.delivered.site) walk(envelope);
});

test("a wrong-nonce proof produced from a valid descriptor never verifies", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  const wrong = await createAgentDescriptor(s.agent, {
    instanceId: s.instanceId,
    agentType: "coding-agent",
    runtime: { name: "agent", version: "1" },
    provider: "acme",
    model: "model-x",
    sessionId: "session-12345678",
    origin: ORIGIN,
    room: ROOM,
    capabilities: [],
    nonce: "nonce-other-0123456789",
    now: NOW,
    expiresAt: NOW + 60_000,
  });
  await s.h.agentRoom.send("agent/pair-proof", { descriptor: wrong });
  assert.equal(s.proofs.length, 1);
  assert.equal(started.nonce.length >= 16, true);
});

test("an owner-signed access-grant revocation is verifiable, bound and time-bounded", async () => {
  const siteWallet = await makeWallet();
  const agent = await makeWallet();
  const grant = await createPairingGrant(siteWallet, {
    audience: ORIGIN,
    room: ROOM,
    walletId: agent.id,
    instanceId: "instance-12345678",
    sessionId: "session-12345678",
    nonce: "nonce-0123456789abcdef",
    scopes: ["presence.read"],
    expiresAt: NOW + 60_000,
    now: () => NOW,
  });
  const revocation = await createAccessGrantRevocation(siteWallet, {
    grant,
    now: () => NOW,
  });
  assert.equal(revocation.body.type, "agent/access-grant-revocation");
  assert.equal(JSON.stringify(revocation).includes("privateKey"), false);
  const verified = await verifyAccessGrantRevocation(revocation, {
    expectedIssuer: siteWallet.id,
    now: () => NOW,
  });
  assert.ok(verified, "a valid revocation must verify");
  assert.equal(verified.grantKey, grantKey(grant));
  assert.equal(verified.walletId, agent.id);
  assert.equal(verified.nonce, "nonce-0123456789abcdef");

  const tampered = structuredClone(revocation);
  tampered.body.payload.scopes = ["tools.invoke"];
  assert.equal(
    await verifyAccessGrantRevocation(tampered, {
      expectedIssuer: siteWallet.id,
      now: () => NOW,
    }),
    null,
    "a modified signed revocation must fail",
  );
  const expired = await createAccessGrantRevocation(siteWallet, {
    grant,
    expiresAt: NOW - 1,
    now: () => NOW,
  }).catch(() => null);
  assert.equal(expired, null, "an expiry in the past cannot be created");
});

test("the pairing verifier observes a revocation delivered through the room", async () => {
  const s = await setup();
  const revoked = [];
  s.verifier.onRevoked((event) => revoked.push(event));
  await s.verifier.start();
  // No grant was attached, so there is nothing to revoke: fail closed.
  const agentWallet = await makeWallet();
  const revocation = await createAccessGrantRevocation(s.siteWallet, {
    audience: ORIGIN,
    room: ROOM,
    walletId: agentWallet.id,
    instanceId: s.instanceId,
    sessionId: "session-12345678",
    nonce: "nonce-unknown-0123456789",
    now: () => NOW,
  });
  await s.h.deliver("site", revocation);
  assert.equal(revoked.length, 0);
  assert.equal(s.verifier.revoked, false);
});
