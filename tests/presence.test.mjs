import assert from "node:assert/strict";
import test from "node:test";
import {
  LEASE_MS,
  OFFLINE_AFTER_MS,
  buildCursorPayload,
  createPresenceTracker,
  parseCursorPayload,
  validateCursor,
} from "../packages/p2p/presence.js";

const A = `agent:${"A".repeat(43)}`;
const B = `agent:${"B".repeat(43)}`;
const S1 = "session-one-aaaa";
const S2 = "session-two-bbbb";
const good = { pageKey: "/docs", x: 10, y: 2400.5, seq: 1 };

function tracker() {
  const clock = { t: 1_000_000 };
  return { clock, presence: createPresenceTracker({ now: () => clock.t }) };
}

test("cursor validation uses document coordinates and rejects malformed fields", () => {
  assert.equal(validateCursor(good).ok, true);
  assert.equal(
    validateCursor({ ...good, x: 2400 }).ok,
    true,
    "beyond viewport is fine",
  );
  for (const bad of [
    { ...good, x: -1 },
    { ...good, y: Number.NaN },
    { ...good, x: Infinity },
    { ...good, x: 1e9 },
    { ...good, pageKey: "" },
    { ...good, pageKey: "p".repeat(201) },
    { ...good, seq: -1 },
    { ...good, seq: 1.5 },
    { ...good, label: "x".repeat(61) },
    { ...good, selector: "" },
    null,
  ])
    assert.equal(validateCursor(bad).ok, false, JSON.stringify(bad));
  assert.equal(
    parseCursorPayload({ ...good, type: "ai-auth-cursor", v: 2 }).ok,
    false,
  );
  assert.deepEqual(parseCursorPayload(buildCursorPayload(good)).cursor, good);
  assert.throws(() => buildCursorPayload({ ...good, x: -5 }), /Invalid cursor/);
});

test("a peer is online while its lease is fresh, offline when late, removed at expiry", () => {
  const { clock, presence } = tracker();
  presence.heartbeat({ walletId: A, session: S1, label: "Agent A" });
  assert.equal(presence.list()[0].state, "online");
  clock.t += OFFLINE_AFTER_MS + 1;
  assert.equal(presence.list()[0].state, "offline");
  assert.deepEqual(presence.cursorsFor("/docs"), []);
  presence.heartbeat({ walletId: A, session: S1 });
  assert.equal(presence.list()[0].state, "online");
  clock.t += LEASE_MS + 1;
  assert.deepEqual(
    presence.list(),
    [],
    "lease expiry removes the peer and its cursor",
  );
});

test("cursors are keyed by wallet and session: updates replace, never duplicate", () => {
  const { presence } = tracker();
  const send = (walletId, session, seq, pageKey = "/docs") =>
    presence.cursor({
      walletId,
      session,
      payload: buildCursorPayload({ ...good, seq, pageKey }),
    });
  assert.equal(send(A, S1, 1).ok, true);
  assert.equal(send(A, S1, 2).ok, true);
  assert.equal(send(A, S1, 2).reason, "stale-seq");
  assert.equal(send(A, S1, 1).reason, "stale-seq");
  assert.equal(presence.list().length, 1);
  assert.equal(presence.list()[0].cursor.seq, 2);
  assert.equal(send(A, S2, 1).ok, true, "a second session is a separate entry");
  assert.equal(send(B, S1, 1, "/other").ok, true);
  assert.equal(presence.list().length, 3);
  assert.deepEqual(
    presence.cursorsFor("/other").map((p) => p.walletId),
    [B],
  );
  assert.equal(presence.cursorsFor("/docs").length, 2);
});

test("a late old-sequence cursor cannot resurrect a removed peer's position", () => {
  const { clock, presence } = tracker();
  presence.cursor({
    walletId: A,
    session: S1,
    payload: buildCursorPayload({ ...good, seq: 5 }),
  });
  presence.goodbye({ walletId: A, session: S1 });
  assert.deepEqual(presence.list(), []);
  clock.t += 10;
  // The entry is new again (a fresh session start); no ghost from before.
  presence.heartbeat({ walletId: A, session: S1 });
  assert.equal(presence.list()[0].cursor, undefined);
});

test("invalid identities, sessions and payloads never create entries", () => {
  const { presence } = tracker();
  assert.equal(presence.heartbeat({ walletId: "bob", session: S1 }), false);
  assert.equal(presence.heartbeat({ walletId: A, session: "x" }), false);
  assert.equal(
    presence.cursor({ walletId: A, session: S1, payload: { ...good } }).ok,
    false,
  );
  assert.equal(
    presence.cursor({
      walletId: A,
      session: S1,
      payload: { type: "ai-auth-cursor", v: 1, ...good, x: -1 },
    }).ok,
    false,
  );
  assert.deepEqual(presence.list(), []);
});

test("the roster is bounded and subscribers see removals", () => {
  const clock = { t: 5 };
  const presence = createPresenceTracker({ now: () => clock.t, maxPeers: 2 });
  const seen = [];
  const off = presence.subscribe((peers) => seen.push(peers.length));
  assert.equal(presence.heartbeat({ walletId: A, session: S1 }), true);
  assert.equal(presence.heartbeat({ walletId: B, session: S1 }), true);
  assert.equal(presence.heartbeat({ walletId: B, session: S2 }), false);
  clock.t += LEASE_MS + 1;
  presence.sweep();
  assert.equal(seen.at(-1), 0);
  off();
  assert.throws(() => presence.subscribe(null), TypeError);
});
