import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  CATCHUP_MAX_RECORDS,
  createEpochRecord,
  createRevokedLinkSet,
  deriveLinkId,
  randomNonce,
  signEnvelope,
  verifyEpochRecord,
  authorizeProtected,
  createParticipationPolicy,
  createRevocation,
  createRevocationGossip,
  DURATION_LIMITS,
  identityFor,
  issueExecutionGrant,
  issueMembership,
  renewExecutionGrant,
  resolveDuration,
  verifyMembership,
  verifyRevocation,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const ROOM = "research";
const SCOPES = ["presence.read", "tools.invoke"];

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

// A controllable clock so grant/epoch expiry never depends on real time.
function setup(startAt = 1_800_000_000_000) {
  const clock = { t: startAt };
  const now = () => clock.t;
  return { clock, now };
}

async function world(opts = {}) {
  const { clock, now } = setup();
  const host = await makeWallet();
  const alice = await makeWallet();
  const policy = createParticipationPolicy({
    mode: "restricted",
    trustPolicy: { issuers: [host.publicKey] },
    origin: ORIGIN,
    room: ROOM,
    now,
    ...opts,
  });
  const membership = (extra = {}) =>
    issueMembership(host, {
      subject: alice.id,
      origin: ORIGIN,
      room: ROOM,
      scopes: SCOPES,
      now: clock.t,
      ...extra,
    });
  const grant = (m, extra = {}) =>
    issueExecutionGrant(host, {
      subject: alice.id,
      origin: ORIGIN,
      room: ROOM,
      membershipId: m.id,
      scopes: ["tools.invoke"],
      epoch: policy.epoch,
      now: clock.t,
      ...extra,
    });
  const authorize = (extra = {}) =>
    authorizeProtected({
      policy,
      walletId: alice.id,
      scope: "tools.invoke",
      now: clock.t,
      ...extra,
    });
  return { clock, host, alice, policy, membership, grant, authorize };
}

test("until-revoked membership without a grant cannot run a protected operation", async () => {
  const w = await world();
  const m = await w.membership({ duration: { kind: "until-revoked" } });
  assert.equal(m.durationKind, "until-revoked");
  assert.equal((await w.policy.admit(w.alice.id, m)).ok, true);
  assert.equal(w.policy.isMember(w.alice.id), true);
  assert.deepEqual(w.authorize(), {
    allow: false,
    reason: "no-execution-grant",
  });
});

test("a live grant allows, an expired grant is denied, renewal restores access", async () => {
  const w = await world();
  const m = await w.membership({ duration: { kind: "until-revoked" } });
  await w.policy.admit(w.alice.id, m);
  const g = await w.grant(m, { ttlMs: 60_000 });
  assert.equal((await w.policy.admitGrant(w.alice.id, g)).ok, true);
  assert.equal(w.authorize().allow, true);
  w.clock.t += 61_000;
  assert.deepEqual(w.authorize(), { allow: false, reason: "grant-expired" });
  const renewed = await renewExecutionGrant(w.host, g, { now: w.clock.t });
  assert.notEqual(renewed.id, g.id);
  assert.equal((await w.policy.admitGrant(w.alice.id, renewed)).ok, true);
  assert.equal(w.authorize().allow, true);
});

test("grant lifetimes are bounded and grants are bound to subject, room and issuer", async () => {
  const w = await world();
  const m = await w.membership();
  await assert.rejects(w.grant(m, { ttlMs: 60 * 60_000 }), /out of bounds/u);
  const g = await w.grant(m);
  const mallory = await makeWallet();
  assert.equal(
    (await w.policy.admitGrant(mallory.id, g)).reason,
    "wrong-subject",
  );
  const rogue = await makeWallet();
  const forged = await issueExecutionGrant(rogue, {
    subject: w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    membershipId: m.id,
    scopes: ["tools.invoke"],
    now: w.clock.t,
  });
  assert.equal(
    (await w.policy.admitGrant(w.alice.id, forged)).reason,
    "untrusted-issuer",
  );
  assert.equal(
    (await w.policy.admitGrant(w.alice.id, { ...g, scopes: ["files.write"] }))
      .ok,
    false,
  );
});

test("a grant for a different membership is denied", async () => {
  const w = await world();
  const m = await w.membership();
  await w.policy.admit(w.alice.id, m);
  const other = await w.membership();
  await w.policy.admitGrant(w.alice.id, await w.grant(other));
  assert.equal(w.authorize().reason, "grant-membership-mismatch");
});

test("a stale epoch is denied; bumpEpoch invalidates older proofs and grants", async () => {
  const w = await world();
  const m = await w.membership({ epoch: 0 });
  await w.policy.admit(w.alice.id, m);
  await w.policy.admitGrant(w.alice.id, await w.grant(m));
  assert.equal(w.authorize().allow, true);
  assert.equal(w.policy.bumpEpoch(), 1);
  assert.equal(w.authorize().allow, false);
  assert.equal(w.policy.isMember(w.alice.id), false);
  // The old proof can no longer be admitted; a fresh one at the new epoch can.
  assert.equal((await w.policy.admit(w.alice.id, m)).reason, "stale-epoch");
  const fresh = await w.membership({ epoch: 1 });
  assert.equal((await w.policy.admit(w.alice.id, fresh)).ok, true);
  assert.equal(
    (await w.policy.admitGrant(w.alice.id, await w.grant(m, { epoch: 0 })))
      .reason,
    "stale-epoch",
  );
  await w.policy.admitGrant(w.alice.id, await w.grant(fresh, { epoch: 1 }));
  assert.equal(w.authorize().allow, true);
});

test("the epoch is monotonic: observeEpoch never lowers it", async () => {
  const w = await world();
  assert.equal(w.policy.observeEpoch(5), 5);
  assert.equal(w.policy.observeEpoch(2), 5);
  assert.equal(w.policy.observeEpoch(-1), 5);
  assert.equal(w.policy.observeEpoch(1.5), 5);
  const m = await w.membership();
  assert.equal((await w.policy.admit(w.alice.id, m)).reason, "stale-epoch");
  const v = await verifyMembership(m, {
    trustPolicy: { issuers: [w.host.publicKey] },
    expectedOrigin: ORIGIN,
    expectedRoom: ROOM,
    expectedSubject: w.alice.id,
    now: w.clock.t,
  });
  assert.equal(v.epoch, 0);
});

test("authorizeProtected fails closed on missing, unknown and open-room inputs", async () => {
  const w = await world();
  const m = await w.membership();
  await w.policy.admit(w.alice.id, m);
  await w.policy.admitGrant(w.alice.id, await w.grant(m));
  assert.equal(w.authorize().allow, true);
  const deniedWith = (extra) =>
    authorizeProtected({
      walletId: w.alice.id,
      scope: "tools.invoke",
      policy: w.policy,
      now: w.clock.t,
      ...extra,
    });
  assert.equal(authorizeProtected().allow, false);
  assert.equal(authorizeProtected({}).reason, "missing-policy");
  assert.equal(deniedWith({ policy: {} }).reason, "missing-policy");
  assert.equal(deniedWith({ policy: null }).reason, "missing-policy");
  assert.equal(deniedWith({ walletId: undefined }).reason, "missing-wallet");
  assert.equal(deniedWith({ scope: undefined }).reason, "missing-scope");
  assert.equal(deniedWith({ scope: "NOT a scope" }).reason, "missing-scope");
  assert.equal(deniedWith({ now: Number.NaN }).reason, "invalid-time");
  const unknown = await makeWallet();
  assert.equal(deniedWith({ walletId: unknown.id }).reason, "no-membership");
  assert.equal(
    deniedWith({ scope: "files.write" }).reason,
    "scope-not-granted",
  );
  const throwing = {
    inspect() {
      throw new Error("boom");
    },
  };
  assert.equal(deniedWith({ policy: throwing }).reason, "policy-error");
  const open = createParticipationPolicy({
    mode: "open",
    origin: ORIGIN,
    room: ROOM,
  });
  assert.equal(deniedWith({ policy: open }).reason, "restricted-room-required");
});

test("duration kinds resolve with caps and until-revoked has a fixed horizon", async () => {
  assert.equal(
    resolveDuration({ kind: "short", ttlMs: 10 * 3600_000 }).ttlMs,
    DURATION_LIMITS.short,
  );
  assert.equal(
    resolveDuration({ kind: "long", ttlMs: 10 ** 12 }).ttlMs,
    DURATION_LIMITS.long,
  );
  assert.equal(
    resolveDuration({ kind: "configured", ttlMs: 5000 }).ttlMs,
    5000,
  );
  assert.throws(
    () => resolveDuration({ kind: "configured", ttlMs: 48 * 3600_000 }),
    /out of bounds/u,
  );
  assert.throws(() => resolveDuration({ kind: "forever" }), /Unknown/u);
  assert.throws(() => resolveDuration({ kind: "configured" }), /ttlMs/u);
  const w = await world();
  const long = await w.membership({
    duration: { kind: "long", ttlMs: 7 * 24 * 3600_000 },
  });
  assert.equal(long.expiresAt - long.issuedAt, 7 * 24 * 3600_000);
  assert.equal((await w.policy.admit(w.alice.id, long)).durationKind, "long");
  // A proof that claims "short" but is signed with a longer lifetime is malformed.
  const stretched = {
    ...(await w.membership({ duration: { kind: "short" } })),
  };
  assert.equal(
    (
      await verifyMembership(
        { ...stretched, expiresAt: stretched.expiresAt + 3 * 3600_000 },
        {
          trustPolicy: { issuers: [w.host.publicKey] },
          expectedOrigin: ORIGIN,
          expectedRoom: ROOM,
          expectedSubject: w.alice.id,
          now: w.clock.t,
        },
      )
    ).reason,
    "lifetime-out-of-bounds",
  );
});

test("revocation records: forged, wrong room/origin, untrusted and tampered are rejected", async () => {
  const w = await world();
  const trust = {
    trustPolicy: { issuers: [w.host.publicKey] },
    expectedOrigin: ORIGIN,
    expectedRoom: ROOM,
    now: w.clock.t,
  };
  const rec = await createRevocation(w.host, {
    kind: "wallet",
    target: w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal((await verifyRevocation(rec, trust)).ok, true);
  const rogue = await makeWallet();
  const forged = await createRevocation(rogue, {
    kind: "wallet",
    target: w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal(
    (await verifyRevocation(forged, trust)).reason,
    "untrusted-issuer",
  );
  assert.equal(
    (await verifyRevocation(rec, { ...trust, expectedRoom: "other" })).reason,
    "wrong-room",
  );
  assert.equal(
    (
      await verifyRevocation(rec, {
        ...trust,
        expectedOrigin: "https://x.example",
      })
    ).reason,
    "wrong-origin",
  );
  assert.equal(
    (
      await verifyRevocation(
        { ...rec, target: "agent:" + "A".repeat(30) },
        trust,
      )
    ).reason,
    "bad-signature",
  );
  assert.equal(
    (await verifyRevocation(rec, { ...trust, trustPolicy: undefined })).reason,
    "untrusted-issuer",
  );
  assert.equal(
    (await verifyRevocation(rec, { ...trust, expectedOrigin: undefined }))
      .reason,
    "expectations-required",
  );
  assert.equal(
    (await verifyRevocation({ ...rec, extra: 1 }, trust)).reason,
    "malformed",
  );
  const future = await createRevocation(w.host, {
    kind: "wallet",
    target: w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t + 3600_000,
  });
  assert.equal((await verifyRevocation(future, trust)).reason, "not-yet-valid");
  await assert.rejects(
    createRevocation(w.host, {
      kind: "link",
      target: "bad",
      origin: ORIGIN,
      room: ROOM,
    }),
    /target/u,
  );
});

test("only a trusted issuer may revoke a membership; a wallet may revoke only itself", async () => {
  const w = await world();
  const m = await w.membership();
  const asAlice = await createRevocation(w.alice, {
    kind: "membership",
    target: m.id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal(
    (await w.policy.applyRevocation(asAlice)).reason,
    "untrusted-issuer",
  );
  const self = await createRevocation(w.alice, {
    kind: "wallet",
    target: w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal((await w.policy.applyRevocation(self)).applied, true);
  const other = await makeWallet();
  const notSelf = await createRevocation(w.alice, {
    kind: "wallet",
    target: other.id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal(
    (await w.policy.applyRevocation(notSelf)).reason,
    "untrusted-issuer",
  );
});

test("revoking a wallet, a membership, or a link denies protected operations and re-admission", async () => {
  for (const kind of ["wallet", "membership", "link"]) {
    const w = await world();
    const m = await w.membership();
    await w.policy.admit(w.alice.id, m);
    await w.policy.admitGrant(w.alice.id, await w.grant(m));
    assert.equal(w.authorize().allow, true, kind);
    const linkId = `link:${"a".repeat(64)}`;
    const target = { wallet: w.alice.id, membership: m.id, link: linkId }[kind];
    const rec = await createRevocation(w.host, {
      kind,
      target,
      origin: ORIGIN,
      room: ROOM,
      now: w.clock.t,
    });
    assert.deepEqual(await w.policy.applyRevocation(rec), {
      ok: true,
      applied: true,
      kind,
    });
    assert.equal(w.policy.isRevoked(kind, target), true);
    if (kind === "link") {
      assert.equal(w.policy.revokedLinks.has(linkId), true);
      assert.equal(w.authorize().allow, true);
      continue;
    }
    assert.equal(w.authorize().allow, false, kind);
    assert.equal(w.policy.isMember(w.alice.id), false);
    assert.equal(
      (await w.policy.admit(w.alice.id, await w.membership())).ok,
      kind === "membership",
    );
  }
});

test("a replayed revocation is a no-op", async () => {
  const w = await world();
  const rec = await createRevocation(w.host, {
    kind: "wallet",
    target: w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal((await w.policy.applyRevocation(rec)).applied, true);
  assert.deepEqual(await w.policy.applyRevocation(rec), {
    ok: true,
    applied: false,
  });
});

// Two in-memory rooms speaking the real room send/subscribe shape.
function linkedRooms(n, policies) {
  const rooms = [];
  const sent = [];
  for (let i = 0; i < n; i++) {
    const listeners = new Set();
    rooms.push({
      policy: policies[i],
      listeners,
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      async send(type, payload, options) {
        const envelope = { body: { type, issuer: `peer-${i}`, payload } };
        sent.push({
          from: i,
          type,
          id: payload.revocation?.id,
          to: options?.to,
        });
        for (const [j, other] of rooms.entries())
          if (j !== i && (!options?.to || options.to === `peer-${j}`))
            for (const l of [...other.listeners])
              l({ direction: "in", envelope });
        return envelope;
      },
    });
  }
  return { rooms, sent };
}
const settle = () => new Promise((r) => setTimeout(r, 25));
// Signature checks are async; poll instead of guessing how long they take.
async function until(condition, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 5));
  await settle();
}

async function gossipWorld(n = 3) {
  const w = await world();
  const policies = Array.from({ length: n }, () =>
    createParticipationPolicy({
      mode: "restricted",
      trustPolicy: { issuers: [w.host.publicKey] },
      origin: ORIGIN,
      room: ROOM,
      now: w.clock && (() => w.clock.t),
    }),
  );
  const { rooms, sent } = linkedRooms(n, policies);
  const gossips = rooms.map((r) => createRevocationGossip(r));
  return { w, policies, rooms, sent, gossips };
}

test("gossip applies a revocation at connected peers and is deduplicated", async (t) => {
  const g = await gossipWorld(3);
  t.after(() => g.gossips.forEach((x) => x.close()));
  const { w } = g;
  const rec = await createRevocation(w.host, {
    kind: "wallet",
    target: w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal((await g.gossips[0].publish(rec)).applied, true);
  await settle();
  for (const p of g.policies)
    assert.equal(p.isRevoked("wallet", w.alice.id), true);
  // Flooding with relays still sends each peer's copy at most once per id.
  const perSender = g.sent.filter((s) => s.id === rec.id).map((s) => s.from);
  assert.equal(new Set(perSender).size, perSender.length);
  const before = g.sent.length;
  await g.gossips[0].publish(rec);
  await g.rooms[1].send("revocation/gossip", { revocation: rec });
  await settle();
  assert.equal(g.sent.length, before + 1, "replays are not re-relayed");
});

test("gossip rejects forged records, never relays them, and records a diagnostic", async (t) => {
  const g = await gossipWorld(2);
  t.after(() => g.gossips.forEach((x) => x.close()));
  const rogue = await makeWallet();
  const forged = await createRevocation(rogue, {
    kind: "wallet",
    target: g.w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: g.w.clock.t,
  });
  assert.equal((await g.gossips[0].publish(forged)).ok, false);
  await g.rooms[1].send("revocation/gossip", { revocation: forged });
  await g.rooms[1].send("revocation/gossip", { revocation: { junk: true } });
  await g.rooms[1].send("revocation/gossip", {});
  await settle();
  assert.equal(g.policies[0].isRevoked("wallet", g.w.alice.id), false);
  assert.equal(g.sent.filter((s) => s.from === 0).length, 0);
  assert.equal(g.gossips[0].diagnostics()[0].reason, "untrusted-issuer");
});

test("a closed gossip instance stops applying revocations", async () => {
  const g = await gossipWorld(2);
  g.gossips[1].close();
  const rec = await createRevocation(g.w.host, {
    kind: "wallet",
    target: g.w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: g.w.clock.t,
  });
  await g.gossips[0].publish(rec);
  await settle();
  assert.equal(g.policies[1].isRevoked("wallet", g.w.alice.id), false);
  g.gossips[0].close();
  assert.throws(() => createRevocationGossip({}), /send\(\)/u);
  assert.throws(
    () => createRevocationGossip(g.rooms[0], { policy: {} }),
    /applyRevocation/u,
  );
});

// ---- epoch announcements, link revocations, and catch-up -------------------

const DAY = 24 * 3600_000;

async function linkRevocationEvent(wallet, now, resource = "/doc") {
  const nonce = randomNonce();
  const linkId = await deriveLinkId({
    origin: ORIGIN,
    walletId: wallet.id,
    resource,
    nonce,
  });
  const event = await signEnvelope(wallet, "ai-auth-link-revocation", {
    type: "ai-auth-link-revocation",
    v: 1,
    linkId,
    origin: ORIGIN,
    resource,
    walletId: wallet.id,
    nonce,
    revokedAt: now,
  });
  return { event, linkId };
}

test("epoch records: trusted issuer only, bound to origin and room, forward only", async () => {
  const w = await world();
  const opts = {
    trustPolicy: { issuers: [w.host.publicKey] },
    expectedOrigin: ORIGIN,
    expectedRoom: ROOM,
    now: w.clock.t,
  };
  const rec = await createEpochRecord(w.host, {
    epoch: 3,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal((await verifyEpochRecord(rec, opts)).ok, true);
  const rogue = await makeWallet();
  const forged = await createEpochRecord(rogue, {
    epoch: 9,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal(
    (await verifyEpochRecord(forged, opts)).reason,
    "untrusted-issuer",
  );
  assert.equal(
    (await verifyEpochRecord({ ...rec, epoch: 99 }, opts)).reason,
    "bad-signature",
  );
  assert.equal(
    (await verifyEpochRecord(rec, { ...opts, expectedRoom: "other" })).reason,
    "wrong-room",
  );
  assert.equal(
    (await verifyEpochRecord(rec, { ...opts, expectedOrigin: undefined }))
      .reason,
    "expectations-required",
  );
  // A wallet may not announce an epoch for itself (unlike self-revocation).
  const self = await createEpochRecord(w.alice, {
    epoch: 4,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal((await w.policy.applyEpoch(self)).reason, "untrusted-issuer");
  assert.deepEqual(await w.policy.applyEpoch(rec), {
    ok: true,
    applied: true,
    kind: "epoch",
  });
  assert.equal(w.policy.epoch, 3);
  const older = await createEpochRecord(w.host, {
    epoch: 2,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal((await w.policy.applyEpoch(older)).applied, false);
  assert.equal(w.policy.epoch, 3);
  await assert.rejects(
    createEpochRecord(w.host, { epoch: -1, origin: ORIGIN, room: ROOM }),
    /epoch/u,
  );
});

test("an epoch announcement gossips and invalidates older proofs at every peer", async (t) => {
  const g = await gossipWorld(3);
  t.after(() => g.gossips.forEach((x) => x.close()));
  const { w } = g;
  const m = await w.membership({ epoch: 0 });
  for (const p of g.policies)
    assert.equal((await p.admit(w.alice.id, m)).ok, true);
  g.policies[0].bumpEpoch();
  const rec = await createEpochRecord(w.host, {
    epoch: 1,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  assert.equal((await g.gossips[0].publishEpoch(rec)).ok, true);
  await until(() => g.policies.every((p) => p.epoch === 1));
  for (const p of g.policies) {
    assert.equal(p.epoch, 1);
    assert.equal(p.isMember(w.alice.id), false);
  }
  assert.equal(
    (await g.policies[2].admit(w.alice.id, m)).reason,
    "stale-epoch",
  );
});

test("link revocations flow through gossip into the policy and a site's revoked set", async (t) => {
  const g = await gossipWorld(2);
  const siteSet = createRevokedLinkSet();
  const second = createRevocationGossip(g.rooms[1], {
    revokedLinks: siteSet,
    now: () => g.w.clock.t,
  });
  t.after(() => [...g.gossips, second].forEach((x) => x.close()));
  const { event, linkId } = await linkRevocationEvent(g.w.alice, g.w.clock.t);
  assert.equal((await g.gossips[0].publishLinkRevocation(event)).applied, true);
  await until(
    () => g.policies[1].revokedLinks.has(linkId) && siteSet.has(linkId),
  );
  assert.equal(g.policies[1].revokedLinks.has(linkId), true);
  assert.equal(siteSet.has(linkId), true);
  // A replay and a tampered event change nothing.
  assert.equal(
    (await g.gossips[0].publishLinkRevocation(event)).applied,
    false,
  );
  const forgedEvent = {
    ...event,
    body: {
      ...event.body,
      payload: { ...event.body.payload, linkId: `link:${"b".repeat(64)}` },
    },
  };
  assert.equal(
    (await g.policies[1].applyLinkRevocation(forgedEvent)).ok,
    false,
  );
  const wrongOrigin = await linkRevocationEvent(g.w.alice, g.w.clock.t);
  wrongOrigin.event.body.payload.origin = "https://other.example";
  assert.equal(
    (await g.policies[1].applyLinkRevocation(wrongOrigin.event)).ok,
    false,
  );
});

async function revokeMany(w, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const target = (await makeWallet()).id;
    out.push(
      await createRevocation(w.host, {
        kind: "wallet",
        target,
        origin: ORIGIN,
        room: ROOM,
        now: w.clock.t,
      }),
    );
  }
  return out;
}

test("a peer that was offline converges through a bounded, verified catch-up", async (t) => {
  const g = await gossipWorld(2);
  t.after(() => g.gossips.forEach((x) => x.close()));
  const { w } = g;
  // Peer 0 holds history that peer 1 never saw.
  const rec = await createRevocation(w.host, {
    kind: "wallet",
    target: w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  await g.policies[0].applyRevocation(rec);
  const { event, linkId } = await linkRevocationEvent(w.alice, w.clock.t);
  await g.policies[0].applyLinkRevocation(event);
  g.policies[0].bumpEpoch();
  await g.policies[0].applyEpoch(
    await createEpochRecord(w.host, {
      epoch: 1,
      origin: ORIGIN,
      room: ROOM,
      now: w.clock.t,
    }),
  );
  assert.equal(g.policies[1].epoch, 0);
  // Peer 1 comes online and announces itself: peer 0 pushes its state back.
  await g.rooms[1].send("peer/hello", {});
  await until(
    () =>
      g.policies[1].isRevoked("wallet", w.alice.id) &&
      g.policies[1].revokedLinks.has(linkId) &&
      g.policies[1].epoch === 1,
  );
  assert.equal(g.policies[1].isRevoked("wallet", w.alice.id), true);
  assert.equal(g.policies[1].revokedLinks.has(linkId), true);
  assert.equal(g.policies[1].epoch, 1);
  // Throttled per peer: another hello right away does not trigger another push.
  const syncs = () => g.sent.filter((s) => s.type === "revocation/sync").length;
  const before = syncs();
  await g.rooms[1].send("peer/hello", {});
  await settle();
  assert.equal(syncs(), before);
});

test("catch-up is bounded by count and age and rejects forged items", async (t) => {
  const g = await gossipWorld(3);
  t.after(() => g.gossips.forEach((x) => x.close()));
  const { w } = g;
  const stale = await createRevocation(w.host, {
    kind: "wallet",
    target: (await makeWallet()).id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t - 30 * DAY,
  });
  await g.policies[0].applyRevocation(stale);
  const many = await revokeMany(w, CATCHUP_MAX_RECORDS + 10);
  for (const r of many) await g.policies[0].applyRevocation(r);
  const recent = g.policies[0].recentRecords();
  assert.equal(recent.revocations.length, CATCHUP_MAX_RECORDS);
  assert.equal(
    recent.revocations.some((r) => r.id === stale.id),
    false,
    "too old",
  );
  assert.equal(g.policies[0].recentRecords({ limit: 5 }).revocations.length, 5);
  assert.equal(
    g.policies[0].recentRecords({ limit: 10_000 }).revocations.length,
    CATCHUP_MAX_RECORDS,
  );
  assert.equal(
    g.policies[0].recentRecords({ maxAgeMs: 1 }).revocations.length,
    CATCHUP_MAX_RECORDS,
  );
  // A hostile peer's sync mixes forged and replayed items with a valid one.
  const rogue = await makeWallet();
  const forged = await createRevocation(rogue, {
    kind: "wallet",
    target: w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: w.clock.t,
  });
  const valid = (await revokeMany(w, 1))[0];
  await g.rooms[1].send("revocation/sync", {
    epoch: null,
    revocations: [forged, valid, valid, { junk: true }, null],
    linkRevocations: "not-a-list",
  });
  await until(() => g.policies[2].isRevoked("wallet", valid.target));
  assert.equal(g.policies[2].isRevoked("wallet", w.alice.id), false);
  assert.equal(g.policies[2].isRevoked("wallet", valid.target), true);
  assert.ok(
    g.gossips[2].diagnostics().some((d) => d.reason === "untrusted-issuer"),
  );
  // Oversized item lists are truncated, not processed unboundedly.
  const flood = await revokeMany(w, CATCHUP_MAX_RECORDS + 8);
  await g.rooms[1].send("revocation/sync", {
    epoch: null,
    revocations: flood,
    linkRevocations: [],
  });
  await until(
    () =>
      flood.filter((r) => g.policies[2].isRevoked("wallet", r.target)).length >=
      CATCHUP_MAX_RECORDS,
  );
  const applied = flood.filter((r) =>
    g.policies[2].isRevoked("wallet", r.target),
  ).length;
  assert.equal(applied, CATCHUP_MAX_RECORDS);
});

test("a private participant requests catch-up instead of announcing itself", async (t) => {
  const g = await gossipWorld(2);
  t.after(() => g.gossips.forEach((x) => x.close()));
  g.rooms[1].privateMode = true;
  const rec = await createRevocation(g.w.host, {
    kind: "wallet",
    target: g.w.alice.id,
    origin: ORIGIN,
    room: ROOM,
    now: g.w.clock.t,
  });
  await g.policies[0].applyRevocation(rec);
  // Peer 0 announces itself; the private peer asks for state, then converges.
  await g.rooms[0].send("peer/hello", {});
  await settle();
  assert.equal(
    g.sent.some((s) => s.from === 1 && s.type === "revocation/sync-request"),
    true,
  );
  assert.equal(g.policies[1].isRevoked("wallet", g.w.alice.id), true);
  assert.equal(
    g.sent.some((s) => s.from === 1 && s.type === "revocation/sync"),
    false,
  );
});
