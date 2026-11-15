import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { webcrypto } from "node:crypto";
import {
  authorizeProtected,
  createParticipationPolicy,
  createRevocation,
  createRevocationGossip,
  identityFor,
  issueMembership,
  NostrWebRTC,
  OPEN_ROOM_DISCLOSURE,
  P2PRoom,
  verifyMembership,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;
// Keep every room on the fake transport; same-process BroadcastChannels would
// otherwise bypass it.
globalThis.BroadcastChannel = class {
  postMessage() {}
  close() {}
};

const ORIGIN = "https://site.example";
const ROOM = "research";
const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// Poll for a condition instead of guessing how many event-loop turns the
// async signature checks need; fail loudly (not by hanging) on timeout.
async function waitFor(condition, label = "condition", timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Every participant is closed even when an assertion fails mid-test, so a
// failure can never leave a heartbeat interval keeping the process alive.
const participants = [];
afterEach(async () => {
  await Promise.all(participants.splice(0).map((p) => p.leave()));
});

async function makeWallet(name) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const id = await identityFor(publicKey);
  return { id, name, publicKey, privateKey: keys.privateKey };
}

// Minimal Trystero-shaped hub: targeted sends, join/leave notifications, and a
// log of everything each peer's transport actually received.
function createHub() {
  const peers = new Map();
  let counter = 0;
  return {
    peers,
    joinRoom() {
      const peerId = `peer-${++counter}`;
      const me = {
        peerId,
        inbox: [],
        message: null,
        join: null,
        leave: null,
      };
      peers.set(peerId, me);
      queueMicrotask(() => {
        for (const other of peers.values()) {
          if (other === me) continue;
          other.join?.({ peerId });
          me.join?.({ peerId: other.peerId });
        }
      });
      return {
        makeAction: () => ({
          onMessage(h) {
            me.message = h;
            return () => (me.message = null);
          },
          async send(data, targets) {
            const wire = JSON.parse(JSON.stringify(data));
            for (const other of peers.values()) {
              if (other === me || (targets && !targets.includes(other.peerId)))
                continue;
              other.inbox.push(wire);
              setImmediate(() => other.message?.(wire, { peerId }));
            }
          },
        }),
        onPeerJoin(h) {
          me.join = h;
          return () => (me.join = null);
        },
        onPeerLeave(h) {
          me.leave = h;
          return () => (me.leave = null);
        },
        onError: () => () => {},
        getPeers: () => ({}),
        async leave() {
          peers.delete(peerId);
          for (const other of peers.values()) other.leave?.({ peerId });
        },
        me,
      };
    },
  };
}

async function join(hub, wallet, options = {}) {
  const room = new P2PRoom(wallet, ROOM, { origin: ORIGIN, ...options });
  let transport;
  const adapter = new NostrWebRTC(room, {
    joinRoom: (...args) => (transport = hub.joinRoom(...args)),
  });
  const seen = [];
  room.subscribe((e) => e.direction === "in" && seen.push(e.envelope.body));
  const participant = {
    wallet,
    room,
    adapter,
    seen,
    inbox: () => transport.me.inbox,
    types: (from) =>
      seen.filter((b) => !from || b.issuer === from).map((b) => b.type),
    async leave() {
      await adapter.close();
      await room.close();
    },
  };
  participants.push(participant);
  await adapter.start();
  return participant;
}

async function setup() {
  const host = await makeWallet("Host");
  const alice = await makeWallet("Alice");
  const mallory = await makeWallet("Alice"); // same nickname, different key
  const trustPolicy = { issuers: [host.publicKey] };
  const policy = () =>
    createParticipationPolicy({
      mode: "restricted",
      trustPolicy,
      origin: ORIGIN,
      room: ROOM,
    });
  const proofFor = (subject, extra = {}) =>
    issueMembership(host, {
      subject,
      origin: ORIGIN,
      room: ROOM,
      role: "member",
      scopes: ["presence.read", "messages.send", "tools.invoke"],
      ...extra,
    });
  return { host, alice, mallory, trustPolicy, policy, proofFor };
}

async function joinRestricted(hub, ctx, wallet, proof) {
  return join(hub, wallet, {
    participation: { policy: ctx.policy(), membership: proof },
  });
}

test("an uninvited wallet that knows origin and room cannot act or read", async () => {
  const hub = createHub();
  const ctx = await setup();
  const hostP = await joinRestricted(
    hub,
    ctx,
    ctx.host,
    await ctx.proofFor(ctx.host.id, { role: "owner", scopes: ["*"] }),
  );
  const aliceP = await joinRestricted(
    hub,
    ctx,
    ctx.alice,
    await ctx.proofFor(ctx.alice.id),
  );
  // Mallory runs a plain open room and knows the origin + room name.
  const malP = await join(hub, ctx.mallory);
  await waitFor(
    () => hostP.room.policy.isMember(ctx.alice.id),
    "alice admitted",
  );
  await waitFor(
    () => aliceP.room.policy.isMember(ctx.host.id),
    "host admitted",
  );
  assert.equal(hostP.room.policy.isMember(ctx.mallory.id), false);

  await malP.room.send("agent/action", { name: "danger", state: "started" });
  await malP.room.send("collab/text", { text: "let me in" });
  await hostP.room.send("collab/text", { text: "restricted secret" });
  await hostP.room.send("agent/action", { kind: "tool-catalog", tools: [] });
  await waitFor(
    () => aliceP.types(ctx.host.id).includes("collab/text"),
    "host text at alice",
  );
  await tick(20);

  assert.equal(hostP.types(ctx.mallory.id).length, 0);
  assert.equal(aliceP.types(ctx.mallory.id).length, 0);
  assert.ok(aliceP.types(ctx.host.id).includes("collab/text"));
  const leaked = malP
    .inbox()
    .filter((e) => !e.body.type.startsWith("peer/"))
    .map((e) => e.body.type);
  assert.deepEqual(leaked, []);
  assert.equal(
    malP.inbox().some((e) => JSON.stringify(e).includes("restricted secret")),
    false,
  );
});

test("forged, expired, cross-room, cross-origin, wrong-subject and stolen proofs are rejected", async () => {
  const ctx = await setup();
  const rogue = await makeWallet("Rogue issuer");
  const base = {
    trustPolicy: ctx.trustPolicy,
    expectedOrigin: ORIGIN,
    expectedRoom: ROOM,
    expectedSubject: ctx.alice.id,
  };
  const good = await ctx.proofFor(ctx.alice.id);
  assert.equal((await verifyMembership(good, base)).ok, true);

  const reason = async (proof, over = {}) =>
    (await verifyMembership(proof, { ...base, ...over })).reason;
  const forged = await issueMembership(rogue, {
    subject: ctx.alice.id,
    origin: ORIGIN,
    room: ROOM,
    scopes: [],
  });
  assert.equal(await reason(forged), "untrusted-issuer");
  // Trusted issuer key pasted over a rogue signature.
  assert.equal(
    await reason({ ...forged, issuer: ctx.host.publicKey }),
    "bad-signature",
  );
  assert.equal(
    await reason({ ...good, role: "owner", scopes: ["*"] }),
    "bad-signature",
  );
  const old = await ctx.proofFor(ctx.alice.id, {
    now: Date.now() - 7_200_000,
    ttlMs: 60_000,
  });
  assert.equal(await reason(old), "expired");
  assert.equal(await reason(good, { expectedRoom: "other" }), "wrong-room");
  assert.equal(
    await reason(good, { expectedOrigin: "https://evil.example" }),
    "wrong-origin",
  );
  assert.equal(
    await reason(good, { expectedSubject: ctx.mallory.id }),
    "wrong-subject",
  );
  assert.equal(
    await reason(good, { trustPolicy: { issuers: [] } }),
    "untrusted-issuer",
  );
  assert.equal(
    await reason(good, { expectedSubject: undefined }),
    "expectations-required",
  );
  await assert.rejects(
    ctx.proofFor(ctx.alice.id, { ttlMs: 10 * 24 * 3_600_000 }),
    /out of bounds/u,
  );
  assert.equal(await reason({ ...good, extra: 1 }), "malformed");

  // Stolen proof presented by another wallet through the policy.
  const policy = ctx.policy();
  assert.equal((await policy.admit(ctx.mallory.id, good)).ok, false);
  assert.equal(policy.isMember(ctx.mallory.id), false);
  // Proof for another room cannot join this room's policy.
  const otherRoom = await ctx.proofFor(ctx.alice.id, { room: "other" });
  assert.equal((await policy.admit(ctx.alice.id, otherRoom)).ok, false);
});

test("a stolen proof replayed by a different wallet over the wire is ignored", async () => {
  const hub = createHub();
  const ctx = await setup();
  const hostP = await joinRestricted(
    hub,
    ctx,
    ctx.host,
    await ctx.proofFor(ctx.host.id, { role: "owner", scopes: ["*"] }),
  );
  const aliceProof = await ctx.proofFor(ctx.alice.id);
  const malP = await join(hub, ctx.mallory, {
    participation: { policy: ctx.policy(), membership: aliceProof },
  });
  await waitFor(() => malP.room.directPeerCount > 0, "mallory linked");
  await malP.room.send("collab/text", { text: "using alice's proof" });
  await tick(30);
  assert.equal(hostP.types(ctx.mallory.id).length, 0);
  assert.equal(hostP.room.policy.roleOf(ctx.mallory.id), null);
});

test("remove and block take effect immediately, in both directions", async () => {
  const hub = createHub();
  const ctx = await setup();
  const hostP = await joinRestricted(
    hub,
    ctx,
    ctx.host,
    await ctx.proofFor(ctx.host.id, { role: "owner", scopes: ["*"] }),
  );
  const aliceP = await joinRestricted(
    hub,
    ctx,
    ctx.alice,
    await ctx.proofFor(ctx.alice.id),
  );
  await waitFor(
    () => hostP.room.policy.isMember(ctx.alice.id),
    "alice admitted",
  );
  await waitFor(
    () => aliceP.room.policy.isMember(ctx.host.id),
    "host admitted",
  );
  await aliceP.room.send("collab/text", { text: "one" });
  await waitFor(
    () => hostP.types(ctx.alice.id).includes("collab/text"),
    "alice text at host",
  );

  const before = aliceP.inbox().length;
  hostP.room.policy.remove(ctx.alice.id);
  await aliceP.room.send("collab/text", { text: "two" });
  await hostP.room.send("collab/text", { text: "after removal" });
  await tick(30); // alice's heartbeats re-present the (now revoked) proof
  assert.equal(
    hostP.types(ctx.alice.id).filter((t) => t === "collab/text").length,
    1,
  );
  assert.equal(hostP.room.policy.isMember(ctx.alice.id), false);
  assert.equal(
    aliceP
      .inbox()
      .slice(before)
      .some((e) => e.body.type === "collab/text"),
    false,
  );
  await assert.rejects(
    hostP.room.send("collab/text", { text: "x" }, { to: ctx.alice.id }),
    /not a member/u,
  );

  // A freshly issued proof re-admits after remove; block is permanent.
  const fresh = await ctx.proofFor(ctx.alice.id);
  assert.equal((await hostP.room.policy.admit(ctx.alice.id, fresh)).ok, true);
  hostP.room.policy.block(ctx.alice.id);
  assert.equal(hostP.room.policy.isMember(ctx.alice.id), false);
  assert.equal(hostP.room.policy.can(ctx.alice.id, "messages.send"), false);
  assert.equal((await hostP.room.policy.admit(ctx.alice.id, fresh)).ok, false);
});

test("join, leave and reconnect keep the same verified identity", async () => {
  const hub = createHub();
  const ctx = await setup();
  const hostP = await joinRestricted(
    hub,
    ctx,
    ctx.host,
    await ctx.proofFor(ctx.host.id, { role: "owner", scopes: ["*"] }),
  );
  const proof = await ctx.proofFor(ctx.alice.id);
  const first = await joinRestricted(hub, ctx, ctx.alice, proof);
  await waitFor(
    () => hostP.room.policy.isMember(ctx.alice.id),
    "alice admitted",
  );
  const firstSession = first.room.session;
  assert.equal(hostP.room.policy.roleOf(ctx.alice.id), "member");
  await first.leave();

  const second = await joinRestricted(hub, ctx, ctx.alice, proof);
  await waitFor(
    () => second.room.directPeerCount > 0,
    "reconnected alice linked",
  );
  assert.notEqual(second.room.session, firstSession);
  await second.room.send("collab/text", { text: "back" });
  await waitFor(
    () => hostP.seen.some((b) => b.type === "collab/text"),
    "alice text after reconnect",
  );
  const texts = hostP.seen.filter((b) => b.type === "collab/text");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].issuer, ctx.alice.id);
  assert.equal(hostP.room.policy.roleOf(ctx.alice.id), "member");
});

test("a nickname is never identity and observers cannot exceed their scopes", async () => {
  const ctx = await setup();
  const policy = ctx.policy();
  const observer = await ctx.proofFor(ctx.alice.id, {
    role: "observer",
    scopes: ["presence.read"],
  });
  assert.equal((await policy.admit(ctx.alice.id, observer)).ok, true);
  assert.equal(policy.roleOf(ctx.alice.id), "observer");
  assert.equal(policy.can(ctx.alice.id, "presence.read"), true);
  assert.equal(policy.can(ctx.alice.id, "tools.invoke"), false);
  assert.equal(policy.roleOf("Alice"), null);
  assert.equal(policy.isMember(ctx.mallory.id), false);
  await assert.rejects(
    ctx.proofFor(ctx.alice.id, { role: "observer", scopes: ["tools.invoke"] }),
    /Invalid scopes/u,
  );
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.snapshot()));
});

test("open mode is unaffected and carries a disclosure", async () => {
  const hub = createHub();
  const ctx = await setup();
  const open = createParticipationPolicy({
    mode: "open",
    origin: ORIGIN,
    room: ROOM,
  });
  assert.equal(open.disclosure, OPEN_ROOM_DISCLOSURE);
  const a = await join(hub, ctx.host, { participation: { policy: open } });
  const b = await join(hub, ctx.alice);
  assert.equal(a.room.participationMode, "open");
  assert.match(a.room.disclosure, /Open room/u);
  await b.room.send("collab/text", { text: "hello public" });
  await a.room.send("collab/text", { text: "hello back" });
  await waitFor(
    () =>
      a.types(ctx.alice.id).includes("collab/text") &&
      b.types(ctx.host.id).includes("collab/text"),
    "open-room texts delivered",
  );
  assert.ok(a.types(ctx.alice.id).includes("collab/text"));
  assert.ok(b.types(ctx.host.id).includes("collab/text"));
  assert.throws(
    () =>
      new P2PRoom(ctx.host, ROOM, {
        origin: ORIGIN,
        participation: {
          policy: createParticipationPolicy({
            mode: "open",
            origin: ORIGIN,
            room: "other",
          }),
        },
      }),
    /must match/u,
  );
});

async function revocationWorld(t) {
  const hub = createHub();
  const ctx = await setup();
  const bob = await makeWallet("Bob");
  const owner = await ctx.proofFor(ctx.host.id, {
    role: "owner",
    scopes: ["*"],
  });
  const hostP = await joinRestricted(hub, ctx, ctx.host, owner);
  const aliceP = await joinRestricted(
    hub,
    ctx,
    ctx.alice,
    await ctx.proofFor(ctx.alice.id),
  );
  const bobP = await joinRestricted(hub, ctx, bob, await ctx.proofFor(bob.id));
  for (const p of [hostP, aliceP, bobP]) {
    const gossip = createRevocationGossip(p.room);
    p.gossip = gossip;
    t.after(() => gossip.close());
  }
  await waitFor(
    () =>
      bobP.room.policy.isMember(ctx.alice.id) &&
      bobP.room.policy.isMember(ctx.host.id) &&
      hostP.room.policy.isMember(ctx.alice.id),
    "everyone admitted",
  );
  const revoke = (kind, target) =>
    createRevocation(ctx.host, { kind, target, origin: ORIGIN, room: ROOM });
  return { ctx, hostP, aliceP, bobP, revoke };
}

test("a revocation propagates to a second peer and that identity is then rejected", async (t) => {
  const { ctx, hostP, aliceP, bobP, revoke } = await revocationWorld(t);
  await aliceP.room.send("collab/text", { text: "before revoke" });
  await waitFor(
    () => bobP.types(ctx.alice.id).includes("collab/text"),
    "alice text at bob",
  );
  const record = await revoke("wallet", ctx.alice.id);
  assert.equal((await hostP.gossip.publish(record)).applied, true);
  await waitFor(
    () => bobP.room.policy.isRevoked("wallet", ctx.alice.id),
    "revocation at bob",
  );
  assert.equal(bobP.room.policy.isMember(ctx.alice.id), false);
  assert.deepEqual(
    authorizeProtected({
      policy: bobP.room.policy,
      walletId: ctx.alice.id,
      scope: "tools.invoke",
    }),
    { allow: false, reason: "revoked" },
  );
  const before = bobP.types(ctx.alice.id).length;
  await aliceP.room.send("collab/text", { text: "after revoke" });
  await aliceP.room.send("agent/action", { name: "danger", state: "started" });
  await tick(20);
  assert.equal(
    bobP.types(ctx.alice.id).length,
    before,
    "no further events from the revoked wallet",
  );
  assert.equal(JSON.stringify(bobP.seen).includes("after revoke"), false);
  // The revoked wallet cannot rejoin with a fresh, validly signed proof.
  const fresh = await ctx.proofFor(ctx.alice.id);
  assert.equal(
    (await bobP.room.policy.admit(ctx.alice.id, fresh)).reason,
    "revoked",
  );
});

test("gossip over the fake transport is deduplicated and replays are no-ops", async (t) => {
  const { ctx, hostP, bobP, aliceP, revoke } = await revocationWorld(t);
  const record = await revoke(
    "membership",
    (await ctx.proofFor(ctx.mallory.id)).id,
  );
  const countGossip = () =>
    bobP.inbox().filter((e) => e.body.type === "revocation/gossip").length;
  await hostP.gossip.publish(record);
  await waitFor(
    () => bobP.room.policy.isRevoked("membership", record.target),
    "applied at bob",
  );
  await tick(20);
  const seenOnce = countGossip();
  assert.ok(seenOnce >= 1);
  const settled = hostP.inbox().length + aliceP.inbox().length;
  // A replay from the host, and a manual re-send by another peer, change nothing.
  assert.equal((await hostP.gossip.publish(record)).applied, false);
  await aliceP.room.send("revocation/gossip", { revocation: record });
  await tick(20);
  // Bob admitted host and alice; the unrelated revocation evicted nobody.
  assert.equal(bobP.room.policy.snapshot().length, 2);
  assert.equal(bobP.gossip.diagnostics().length, 0);
  // Only the manual re-send reached the wire; the replays were not relayed.
  assert.equal(hostP.inbox().length + aliceP.inbox().length, settled + 1);
});

test("a forged revocation over the wire changes nothing", async (t) => {
  const { ctx, aliceP, bobP } = await revocationWorld(t);
  const forged = await createRevocation(ctx.mallory, {
    kind: "wallet",
    target: ctx.host.id,
    origin: ORIGIN,
    room: ROOM,
  });
  await aliceP.room.send("revocation/gossip", { revocation: forged });
  await waitFor(
    () => bobP.gossip.diagnostics().length > 0,
    "diagnostic recorded",
  );
  assert.equal(bobP.room.policy.isRevoked("wallet", ctx.host.id), false);
  assert.equal(bobP.room.policy.isMember(ctx.host.id), true);
  assert.equal(bobP.gossip.diagnostics()[0].reason, "untrusted-issuer");
});
