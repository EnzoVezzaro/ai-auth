// Protocol-level virtual cursor and presence tracking (docs/PROTOCOL.md §6, §8).
// A cursor is published data about where an agent is working. It never moves an
// OS pointer and grants no permission to click, type, or run tools. The tracker
// takes inputs that the room already verified (signature, room, origin, replay,
// membership); it adds per-peer bookkeeping only.

export const CURSOR_TYPE = "ai-auth-cursor";
export const CURSOR_VERSION = 1;
export const HEARTBEAT_MS = 8_000;
export const OFFLINE_AFTER_MS = 16_000;
export const LEASE_MS = 24_000;
export const MAX_COORDINATE = 1_000_000;
const MAX_PEERS = 64;
const SESSION = /^[A-Za-z0-9_-]{8,100}$/u;
const WALLET = /^agent:[A-Za-z0-9_-]{20,100}$/u;

const bad = (reason) => ({ ok: false, reason });
const clean = (value, max) =>
  typeof value === "string" &&
  value.length <= max &&
  !/[\u0000-\u001f]/u.test(value);

/** Validate cursor fields; never clamps silently. */
export function validateCursor(input) {
  if (!input || typeof input !== "object") return bad("not-an-object");
  const { pageKey, x, y, selector, label, seq } = input;
  if (typeof pageKey !== "string" || !pageKey || !clean(pageKey, 200))
    return bad("bad-page-key");
  for (const value of [x, y])
    if (!Number.isFinite(value) || value < 0 || value > MAX_COORDINATE)
      return bad("bad-coordinate");
  if (selector !== undefined && (!clean(selector, 200) || !selector))
    return bad("bad-selector");
  if (label !== undefined && !clean(label, 60)) return bad("bad-label");
  if (!Number.isSafeInteger(seq) || seq < 0) return bad("bad-seq");
  return {
    ok: true,
    cursor: Object.freeze({
      pageKey,
      x,
      y,
      seq,
      ...(selector === undefined ? {} : { selector }),
      ...(label === undefined ? {} : { label }),
    }),
  };
}

/** Payload for `room.send("presence/cursor", ...)`-style publishing. */
export function buildCursorPayload(fields) {
  const result = validateCursor(fields);
  if (!result.ok) throw new TypeError(`Invalid cursor: ${result.reason}`);
  return { type: CURSOR_TYPE, v: CURSOR_VERSION, ...result.cursor };
}

/** Parse a received cursor payload (type and version checked). */
export function parseCursorPayload(payload) {
  if (payload?.type !== CURSOR_TYPE || payload.v !== CURSOR_VERSION)
    return bad("not-a-v1-cursor");
  return validateCursor(payload);
}

const view = (entry, now, offlineAfterMs) =>
  Object.freeze({
    walletId: entry.walletId,
    session: entry.session,
    label: entry.label,
    state: now - entry.lastSeen > offlineAfterMs ? "offline" : "online",
    lastSeen: entry.lastSeen,
    cursor: entry.cursor,
  });

/**
 * Tracks one entry per verified wallet and session. A peer is online while its
 * lease is fresh, shown offline when heartbeats are late, and removed (cursor
 * included) when the lease expires or the peer says goodbye.
 */
export function createPresenceTracker({
  now = Date.now,
  leaseMs = LEASE_MS,
  offlineAfterMs = OFFLINE_AFTER_MS,
  maxPeers = MAX_PEERS,
} = {}) {
  const entries = new Map();
  const listeners = new Set();
  const emit = () => {
    const snapshot = list();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A rendering failure must not corrupt presence state.
      }
    }
  };
  function sweep() {
    let removed = false;
    for (const [key, entry] of entries)
      if (now() - entry.lastSeen > leaseMs) {
        entries.delete(key);
        removed = true;
      }
    if (removed) emit();
    return removed;
  }
  function list() {
    const at = now();
    return [...entries.values()].map((entry) =>
      view(entry, at, offlineAfterMs),
    );
  }
  function touch(walletId, session, label) {
    if (!WALLET.test(walletId) || !SESSION.test(session ?? "")) return null;
    sweep();
    const key = `${walletId}:${session}`;
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxPeers) return null;
      entry = {
        walletId,
        session,
        lastSeen: 0,
        cursor: undefined,
        label: undefined,
      };
      entries.set(key, entry);
    }
    entry.lastSeen = now();
    if (typeof label === "string" && clean(label, 60)) entry.label = label;
    return entry;
  }
  return Object.freeze({
    /** peer/hello or peer/heartbeat from a verified wallet and session. */
    heartbeat({ walletId, session, label }) {
      const entry = touch(walletId, session, label);
      if (entry) emit();
      return Boolean(entry);
    },
    /** A verified cursor payload; stale or invalid sequence numbers are dropped. */
    cursor({ walletId, session, payload }) {
      const parsed = parseCursorPayload(payload);
      if (!parsed.ok) return parsed;
      const entry = touch(walletId, session, parsed.cursor.label);
      if (!entry) return bad("rejected-peer");
      if (entry.cursor && parsed.cursor.seq <= entry.cursor.seq)
        return bad("stale-seq");
      entry.cursor = parsed.cursor;
      emit();
      return { ok: true };
    },
    goodbye({ walletId, session }) {
      const removed = entries.delete(`${walletId}:${session}`);
      if (removed) emit();
      return removed;
    },
    sweep,
    list() {
      sweep();
      return list();
    },
    /** Cursors visible on one page/route; offline peers are excluded. */
    cursorsFor(pageKey) {
      return this.list().filter(
        (peer) => peer.state === "online" && peer.cursor?.pageKey === pageKey,
      );
    },
    subscribe(listener) {
      if (typeof listener !== "function")
        throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      entries.clear();
      emit();
    },
  });
}
