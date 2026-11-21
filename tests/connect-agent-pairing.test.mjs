// Pairing verifier contract: signed, expected-identity, single-use challenge.
// Negative tests are written first and must fail before pairing.js exists.
import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  createAgentDescriptor,
  createInstanceId,
  identityFor,
  NonceGuard,
  randomNonce,
  signEnvelope,
} from "../packages/p2p/index.js";
import { createPairingVerifier } from "../apps/connect-agent/pairing.js";
import {
  createAccessGrantRevocation,
  createPairingGrant,
  createPairingResponder,
  grantKey,
  verifyAccessGrantRevocation,
  verifyPairingGrant,
} from "../packages/agent/pairing.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const ROOM = "research";
const NOW = 1_800_000_000_000;

async function makeWallet(name = "agent") {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    name,
    id: await identityFor(publicKey),
    publicKey,
    privateKey: keys.privateKey,
  };
}

// In-memory stand-in for two P2PRoom instances: send() signs an envelope with
// the sender's wallet and delivers it as an authenticated inbound event to the
// other side. This mirrors P2PRoom.send/receive/subscribe without a transport.
function createHarness(siteWallet, agentWallet) {
  const listeners = { site: new Set(), agent: new Set() };
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
    listeners,
  };
}

async function setup({ agentWallet, instanceId, ttlMs = 60_000 } = {}) {
  const siteWallet = await makeWallet("site");
  const agent = agentWallet ?? (await makeWallet("target"));
  const iid = instanceId ?? createInstanceId();
  const h = createHarness(siteWallet, agent);
  const clock = { site: NOW, agent: NOW };
  const verified = [];
  const verifier = createPairingVerifier({
    siteWallet,
    siteRoom: h.siteRoom,
    origin: ORIGIN,
    room: ROOM,
    expected: { walletId: agent.id, instanceId: iid },
    now: () => clock.site,
    ttlMs,
  });
  verifier.onVerified((proof) => verified.push(proof));
  const responder = createPairingResponder({
    wallet: agent,
    instanceId: iid,
    origin: ORIGIN,
    room: ROOM,
    siteRoom: h.agentRoom,
    provider: "acme",
    model: "model-x",
    now: () => clock.agent,
  });
  return { siteWallet, agent, iid, h, clock, verified, verifier, responder };
}

// Arm the site wallet's owner approval on the outgoing challenge so the proof
// carries a real, verifiable authorization that can later be revoked.
async function armOwnerGrant(s, scopes = ["presence.read", "messages.send"]) {
  const send = s.h.siteRoom.send.bind(s.h.siteRoom);
  s.h.siteRoom.send = async (type, payload = {}, extra = {}) => {
    if (type === "agent/pair-challenge" && payload.challenge?.body?.payload) {
      const c = payload.challenge.body.payload;
      const grant = await createPairingGrant(s.siteWallet, {
        audience: c.origin,
        room: c.room,
        walletId: c.walletId,
        instanceId: c.instanceId,
        sessionId: c.sessionId,
        nonce: c.nonce,
        scopes,
        expiresAt: c.expiresAt,
        now: () => NOW,
      });
      payload.grant = { ...grant.body.payload, envelope: grant };
      s.grant = payload.grant;
    }
    return send(type, payload, extra);
  };
}

const descriptorFor = (wallet, instanceId, overrides = {}) =>
  createAgentDescriptor(wallet, {
    instanceId,
    agentType: "coding-agent",
    runtime: { name: "agent", version: "1" },
    provider: "acme",
    model: "model-x",
    sessionId: "session-12345678",
    origin: ORIGIN,
    room: ROOM,
    capabilities: [],
    nonce: randomNonce(),
    now: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  });

test("happy path: expected wallet + instance proof verifies and labels claims self-reported", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  assert.match(started.nonce, /^[A-Za-z0-9_-]{16,}$/u);
  assert.equal(typeof started.challengeId, "string");
  assert.equal(started.expiresAt, NOW + 60_000);
  assert.equal(started.challenge.body.type, "agent/pair-challenge");
  assert.equal(s.verified.length, 1);
  const proof = s.verified[0];
  assert.equal(proof.walletId, s.agent.id);
  assert.equal(proof.instanceId, s.iid);
  assert.equal(typeof proof.sessionId, "string");
  assert.equal(proof.verifiedAt, NOW);
  assert.equal(proof.claims.provider, "acme");
  assert.equal(proof.claims.model, "model-x");
  assert.equal(proof.claims.selfReported, true);
});

test("replay of the same proof is accepted only once", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  assert.equal(s.verified.length, 1);
  const proofEnvelope = await s.h.agentRoom.send("agent/pair-proof", {
    descriptor: await descriptorFor(s.agent, s.iid, { nonce: started.nonce }),
  });
  await s.h.deliver("site", proofEnvelope);
  assert.equal(s.verified.length, 1);
});

// A9: exercise the single-use primitive directly, not only through the room
// flow. The verifier's replay defence is only as good as this guard.
test("NonceGuard consumes a nonce exactly once and rejects expired or malformed input", () => {
  const guard = new NonceGuard();
  const nonce = randomNonce();
  const expiresAt = NOW + 60_000;
  assert.ok(nonce.length >= 20, "fixture nonce must satisfy the guard");
  assert.equal(
    guard.consume(nonce, expiresAt, NOW),
    true,
    "the first use of a fresh nonce is accepted",
  );
  assert.equal(
    guard.consume(nonce, expiresAt, NOW + 1),
    false,
    "a replayed nonce is rejected even before its expiry",
  );
  assert.equal(
    guard.consume(randomNonce(), expiresAt, NOW),
    true,
    "a different nonce is still accepted",
  );
  assert.equal(
    guard.consume(randomNonce(), NOW - 1, NOW),
    false,
    "an already-expired nonce is rejected",
  );
  assert.equal(
    guard.consume("short", expiresAt, NOW),
    false,
    "a malformed nonce is rejected",
  );
});

test("a different peer never completes the expected pairing", async () => {
  const s = await setup();
  const intruder = await makeWallet("intruder");
  const intruderResponder = createPairingResponder({
    wallet: intruder,
    instanceId: s.iid, // deliberately reuses the expected instance id
    origin: ORIGIN,
    room: ROOM,
    siteRoom: createHarness(s.siteWallet, intruder).agentRoom,
  });
  const started = await s.verifier.start();
  assert.equal(s.verified.length, 1);
  // An unrelated presence/event from the intruder is ignored.
  await s.h.siteRoom.send("peer/hello", { label: "intruder" });
  await s.h.deliver(
    "site",
    await s.h.sign("agent/pair-proof", intruder, {
      descriptor: await descriptorFor(intruder, s.iid, {
        nonce: started.nonce,
      }),
    }),
  );
  assert.equal(s.verified.length, 1);
  intruderResponder.close();
});

test("wrong key (proof signed by another wallet) is rejected", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  const attacker = await makeWallet("attacker");
  await s.h.deliver(
    "site",
    await s.h.sign("agent/pair-proof", attacker, {
      descriptor: await descriptorFor(attacker, s.iid, {
        nonce: started.nonce,
      }),
    }),
  );
  assert.equal(s.verified.length, 1); // only the legitimate proof from start()
});

test("wrong instanceId is rejected", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  await s.h.agentRoom.send("agent/pair-proof", {
    descriptor: await descriptorFor(s.agent, createInstanceId(), {
      nonce: started.nonce,
    }),
  });
  assert.equal(s.verified.length, 1);
});

test("wrong nonce is rejected", async () => {
  const s = await setup();
  await s.verifier.start();
  await s.h.agentRoom.send("agent/pair-proof", {
    descriptor: await descriptorFor(s.agent, s.iid, {
      nonce: "nonce-other-0123456789",
    }),
  });
  assert.equal(s.verified.length, 1);
});

test("expired proof is rejected", async () => {
  const s = await setup();
  await s.verifier.start();
  s.clock.site = NOW + 200_000;
  await s.h.agentRoom.send("agent/pair-proof", {
    descriptor: await descriptorFor(s.agent, s.iid, {
      now: NOW + 140_000,
      expiresAt: NOW + 150_000,
    }),
  });
  assert.equal(s.verified.length, 1);
});

test("wrong origin is rejected", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  await s.h.agentRoom.send("agent/pair-proof", {
    descriptor: await descriptorFor(s.agent, s.iid, {
      nonce: started.nonce,
      origin: "https://evil.example",
    }),
  });
  assert.equal(s.verified.length, 1);
});

test("wrong room is rejected", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  await s.h.agentRoom.send("agent/pair-proof", {
    descriptor: await descriptorFor(s.agent, s.iid, {
      nonce: started.nonce,
      room: "other-room",
    }),
  });
  assert.equal(s.verified.length, 1);
});

test("copied and modified descriptors are rejected", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  const valid = await descriptorFor(s.agent, s.iid, { nonce: started.nonce });
  // Modified claim while reusing the original signature.
  await s.h.agentRoom.send("agent/pair-proof", {
    descriptor: { ...valid, model: "model-y" },
  });
  // Valid descriptor replayed from an unauthenticated envelope.
  const attacker = await makeWallet("copier");
  await s.h.deliver(
    "site",
    await s.h.sign("agent/pair-proof", attacker, { descriptor: valid }),
  );
  assert.equal(s.verified.length, 1);
});

test("local install without a live signed proof never marks verified", async () => {
  const siteWallet = await makeWallet("site");
  const agent = await makeWallet("installed-only");
  const iid = createInstanceId();
  const h = createHarness(siteWallet, agent);
  const verified = [];
  const verifier = createPairingVerifier({
    siteWallet,
    siteRoom: h.siteRoom,
    origin: ORIGIN,
    room: ROOM,
    expected: { walletId: agent.id, instanceId: iid },
    now: () => NOW,
  });
  verifier.onVerified((proof) => verified.push(proof));
  // Simulate a successful local installation (no room proof at all).
  await descriptorFor(agent, iid);
  const started = await verifier.start();
  assert.equal(started.nonce.length >= 16, true);
  assert.equal(verified.length, 0);
  verifier.close();
});

test("close() stops accepting proofs", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  assert.equal(s.verified.length, 1);
  s.verifier.close();
  await s.h.agentRoom.send("agent/pair-proof", {
    descriptor: await descriptorFor(s.agent, s.iid, { nonce: started.nonce }),
  });
  assert.equal(s.verified.length, 1);
});

test("owner-signed grant travels in the challenge and is forwarded as authorization", async () => {
  const s = await setup();
  const proofs = [];
  s.h.siteRoom.subscribe((event) => {
    if (event.envelope?.body?.type === "agent/pair-proof")
      proofs.push(event.envelope);
  });
  const send = s.h.siteRoom.send.bind(s.h.siteRoom);
  s.h.siteRoom.send = async (type, payload = {}, extra = {}) => {
    if (type === "agent/pair-challenge" && payload.challenge?.body?.payload) {
      const c = payload.challenge.body.payload;
      const grant = await createPairingGrant(s.siteWallet, {
        audience: c.origin,
        room: c.room,
        walletId: c.walletId,
        instanceId: c.instanceId,
        sessionId: c.sessionId,
        nonce: c.nonce,
        scopes: ["presence.read", "messages.send"],
        expiresAt: c.expiresAt,
        now: () => NOW,
      });
      payload.grant = { ...grant.body.payload, envelope: grant };
    }
    return send(type, payload, extra);
  };
  const started = await s.verifier.start();
  assert.equal(s.verified.length, 1);
  assert.equal(proofs.length, 1);
  const authorization = proofs[0].body.payload.authorization;
  assert.ok(authorization, "responder did not forward the verified grant");
  assert.equal(authorization.audience, ORIGIN);
  assert.equal(authorization.room, ROOM);
  assert.equal(authorization.walletId, s.agent.id);
  assert.equal(authorization.nonce, started.nonce);
  assert.deepEqual(authorization.scopes, ["messages.send", "presence.read"]);
  assert.equal(authorization.expiresAt, NOW + 60_000);
  assert.equal(authorization.envelope.body.type, "agent/access-grant");
  assert.equal(JSON.stringify(proofs[0]).includes("privateKey"), false);
});

test("grant verification rejects tampering, wrong audience, expiry and wrong binding", async () => {
  const s = await setup();
  const started = await s.verifier.start();
  const c = started.challenge.body.payload;
  const payload = {
    audience: ORIGIN,
    room: ROOM,
    walletId: s.agent.id,
    instanceId: s.iid,
    sessionId: c.sessionId,
    nonce: started.nonce,
    scopes: ["presence.read", "messages.send"],
    expiresAt: c.expiresAt,
  };
  const expected = {
    expectedIssuer: s.siteWallet.id,
    audience: ORIGIN,
    room: ROOM,
    walletId: s.agent.id,
    instanceId: s.iid,
    sessionId: c.sessionId,
    nonce: started.nonce,
    expiresAt: c.expiresAt,
  };
  const grant = await createPairingGrant(s.siteWallet, {
    ...payload,
    now: () => NOW,
  });
  const ok = await verifyPairingGrant(
    { ...payload, envelope: grant },
    expected,
    { now: () => NOW },
  );
  assert.ok(ok, "a valid owner grant must verify");
  assert.deepEqual(ok.scopes, ["messages.send", "presence.read"]);

  const signed = (overrides) =>
    signEnvelope(s.siteWallet, "agent/access-grant", {
      ...payload,
      ...overrides,
    });
  const other = await makeWallet("other");
  const rejected = [
    signed({ audience: "https://evil.example" }),
    signed({ room: "other-room" }),
    signed({ scopes: [] }),
    signed({ scopes: ["*"] }),
    signed({ expiresAt: NOW - 1 }),
    signed({ walletId: other.id }),
    signed({ sessionId: "session-other-1234" }),
    signed({ nonce: "nonce-other-0123456789" }),
  ];
  for (const bad of rejected)
    assert.equal(
      await verifyPairingGrant(bad, expected, { now: () => NOW }),
      null,
    );

  // A modified payload keeping the original signature is never trusted.
  const tampered = structuredClone(grant);
  tampered.body.payload.scopes = ["tools.invoke"];
  assert.equal(
    await verifyPairingGrant(tampered, expected, { now: () => NOW }),
    null,
  );
  // A grant signed by a different issuer cannot bind this site.
  const foreign = await makeWallet("foreign-owner");
  const foreignGrant = await createPairingGrant(foreign, {
    ...payload,
    now: () => NOW,
  });
  assert.equal(
    await verifyPairingGrant(foreignGrant, expected, { now: () => NOW }),
    null,
  );
});

test("a valid owner revocation clears the accepted grant, emits onRevoked and preserves the identity proof", async () => {
  const s = await setup();
  const revoked = [];
  s.verifier.onRevoked((event) => revoked.push(event));
  await armOwnerGrant(s);
  await s.verifier.start();
  assert.equal(s.verified.length, 1);
  const authorization = s.verified[0].claims.authorization;
  assert.ok(authorization, "the proof must carry a verified grant");
  assert.equal(s.verifier.revoked, false);

  const revocation = await createAccessGrantRevocation(s.siteWallet, {
    grant: authorization,
    now: () => NOW,
  });
  await s.h.deliver("site", revocation);

  assert.equal(revoked.length, 1, "onRevoked did not fire");
  assert.equal(revoked[0].grantKey, grantKey(authorization));
  assert.equal(revoked[0].reason, "revoked");
  assert.equal(s.verifier.revoked, true, "grant was not invalidated");
  // The historical identity proof is untouched by revocation.
  assert.equal(s.verified[0].walletId, s.agent.id);
  assert.equal(s.verified[0].instanceId, s.iid);
  assert.equal(s.verified[0].claims.authorization, authorization);
  // A second, otherwise valid revocation cannot re-apply an already revoked grant.
  assert.equal(
    await s.verifier.revoke(
      await createAccessGrantRevocation(s.siteWallet, {
        grant: authorization,
        now: () => NOW,
      }),
    ),
    false,
  );
});

test("revocations from another owner, another grant, a tampered message or with no grant are ignored", async () => {
  const s = await setup();
  const revoked = [];
  s.verifier.onRevoked((event) => revoked.push(event));
  await armOwnerGrant(s);
  await s.verifier.start();
  const authorization = s.verified[0].claims.authorization;

  const foreign = await makeWallet("foreign-owner");
  const bad = [
    await createAccessGrantRevocation(foreign, {
      grant: authorization,
      now: () => NOW,
    }),
    await createAccessGrantRevocation(s.siteWallet, {
      grant: authorization,
      nonce: "nonce-other-0123456789",
      now: () => NOW,
    }),
    await createAccessGrantRevocation(s.siteWallet, {
      grant: authorization,
      sessionId: "session-other-1234",
      now: () => NOW,
    }),
  ];
  const tampered = structuredClone(
    await createAccessGrantRevocation(s.siteWallet, {
      grant: authorization,
      now: () => NOW,
    }),
  );
  tampered.body.payload.walletId = (await makeWallet("swap")).id;
  bad.push(tampered);
  for (const envelope of bad) await s.h.deliver("site", envelope);

  assert.equal(revoked.length, 0, "an invalid revocation revoked the grant");
  assert.equal(s.verifier.revoked, false);

  // An identity-only proof has no grant to revoke.
  const identityOnly = await setup();
  const identityRevoked = [];
  identityOnly.verifier.onRevoked((event) => identityRevoked.push(event));
  await identityOnly.verifier.start();
  await identityOnly.h.deliver(
    "site",
    await createAccessGrantRevocation(identityOnly.siteWallet, {
      audience: ORIGIN,
      room: ROOM,
      walletId: identityOnly.agent.id,
      instanceId: identityOnly.iid,
      sessionId: "session-12345678",
      nonce: "nonce-unknown-0123456789",
      now: () => NOW,
    }),
  );
  assert.equal(identityRevoked.length, 0);
  assert.equal(identityOnly.verifier.revoked, false);
});

test("replaying the same signed revocation is a no-op", async () => {
  const s = await setup();
  const revoked = [];
  s.verifier.onRevoked((event) => revoked.push(event));
  await armOwnerGrant(s);
  await s.verifier.start();
  const authorization = s.verified[0].claims.authorization;
  const revocation = await createAccessGrantRevocation(s.siteWallet, {
    grant: authorization,
    now: () => NOW,
  });

  await s.h.deliver("site", revocation);
  await s.h.deliver("site", revocation);
  await s.h.deliver("site", structuredClone(revocation));

  assert.equal(
    revoked.length,
    1,
    "a replayed revocation emitted a second event",
  );
  assert.equal(s.verifier.revoked, true);
});

test("a revocation arriving before the proof prevents that grant from ever going green", async () => {
  const s = await setup();
  const revoked = [];
  s.verifier.onRevoked((event) => revoked.push(event));
  s.responder.close(); // hold the proof back until after the revocation
  await armOwnerGrant(s);
  const started = await s.verifier.start();
  const c = started.challenge.body.payload;

  await s.h.deliver(
    "site",
    await createAccessGrantRevocation(s.siteWallet, {
      audience: c.origin,
      room: c.room,
      walletId: c.walletId,
      instanceId: c.instanceId,
      sessionId: c.sessionId,
      nonce: c.nonce,
      now: () => NOW,
    }),
  );
  assert.equal(s.verifier.revoked, false, "no grant was accepted yet");
  assert.equal(revoked.length, 0);

  await s.h.agentRoom.send("agent/pair-proof", {
    descriptor: await descriptorFor(s.agent, s.iid, { nonce: started.nonce }),
    authorization: s.grant,
  });
  assert.equal(s.verified.length, 1, "the signed proof still verifies");
  assert.equal(s.verifier.revoked, true, "the pre-revoked grant was accepted");
  assert.equal(
    revoked.length,
    1,
    "onRevoked did not fire for the early revocation",
  );
  // A8: the proof still verifies identity, but it must not carry the revoked
  // authorization. Otherwise a consumer could paint the row green for one tick
  // before the revocation callback cleared access.
  assert.equal(
    s.verified[0].claims.authorization,
    undefined,
    "a proof for an already-revoked grant must not carry authorization",
  );
  assert.equal(s.verifier.revoked, true);
});

test("grant revocation helpers verify only a fresh, owner-signed, well-formed message", async () => {
  const s = await setup();
  const authorization = await createPairingGrant(s.siteWallet, {
    audience: ORIGIN,
    room: ROOM,
    walletId: s.agent.id,
    instanceId: s.iid,
    sessionId: "session-12345678",
    nonce: "nonce-0123456789abcdef",
    scopes: ["presence.read"],
    expiresAt: NOW + 60_000,
    now: () => NOW,
  });
  const valid = await createAccessGrantRevocation(s.siteWallet, {
    grant: authorization,
    now: () => NOW,
  });
  const result = await verifyAccessGrantRevocation(valid, {
    expectedIssuer: s.siteWallet.id,
    now: () => NOW,
  });
  assert.ok(result, "a valid owner revocation must verify");
  assert.equal(result.grantKey, grantKey(authorization));

  const foreign = await makeWallet("other-owner");
  assert.equal(
    await verifyAccessGrantRevocation(
      await createAccessGrantRevocation(foreign, {
        grant: authorization,
        now: () => NOW,
      }),
      { expectedIssuer: s.siteWallet.id, now: () => NOW },
    ),
    null,
  );
  assert.equal(
    await verifyAccessGrantRevocation(valid, {
      expectedIssuer: (await makeWallet("another-owner")).id,
      now: () => NOW,
    }),
    null,
  );
  assert.equal(
    await verifyAccessGrantRevocation(valid, {
      expectedIssuer: s.siteWallet.id,
      now: () => NOW + 11 * 60_000,
    }),
    null,
    "an expired revocation must fail closed",
  );
  const tampered = structuredClone(valid);
  tampered.body.payload.audience = "https://evil.example";
  assert.equal(
    await verifyAccessGrantRevocation(tampered, {
      expectedIssuer: s.siteWallet.id,
      now: () => NOW,
    }),
    null,
  );
  assert.equal(
    await verifyAccessGrantRevocation(
      { ...valid, body: { ...valid.body, type: "agent/access-grant" } },
      {
        expectedIssuer: s.siteWallet.id,
        now: () => NOW,
      },
    ),
    null,
    "a grant cannot be replayed as a revocation",
  );
});
