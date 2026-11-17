// Per-agent session records kept in the SITE origin's localStorage. Only
// public data lives here: the signed consent envelope, the wallet's public key,
// granted capabilities and activity time. Private keys and recovery passphrases
// stay in the wallet origin's IndexedDB and are never written by this module.
import { verifyEnvelope } from "./index.js";
import { CONSENT_VERSION } from "./connect.js";

export const SESSION_RECORD_VERSION = 1;
// A stored consent is re-verified at restore time, long after the one-use
// challenge expired. Its own signed expiry bounds a timed grant, so envelope
// age may be generous here; Never grants have no time bound at all and are
// exempt from this age cap so they stay resumable however old they get.
const STORED_CONSENT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PREFIX = "ai-auth:sessions";

function originKey(origin) {
  return `${PREFIX}:v${SESSION_RECORD_VERSION}:${origin}`;
}

export function agentKeyFor({ walletId, instanceId }) {
  if (typeof walletId !== "string" || typeof instanceId !== "string")
    throw new TypeError("A wallet id and instance id are required");
  return `${walletId}::${instanceId}`;
}

/**
 * Build a record from an already-verified consent. The consent is public and
 * copied by reference only for storage; callers never put a key in a record.
 */
export function recordFromConsent(
  consent,
  { origin, room, participant, now = () => Date.now() } = {},
) {
  const payload = consent?.body?.payload;
  if (!payload || typeof origin !== "string" || typeof room !== "string")
    throw new TypeError("A verified consent, origin and room are required");
  const walletId = consent.body.issuer;
  const instanceId = participant?.instanceId ?? payload.requestNonce;
  const at = now();
  return Object.freeze({
    schemaVersion: SESSION_RECORD_VERSION,
    audience: origin,
    agentKey: agentKeyFor({ walletId, instanceId }),
    walletId,
    // The proof's JWK is the public half already carried by the signed envelope.
    publicKey: consent.proof?.publicKey ?? null,
    instanceId,
    sessionId: participant?.sessionId ?? payload.requestNonce,
    consent,
    expiresAt: payload.expiresAt,
    idleTimeoutMs: payload.idleTimeoutMs ?? null,
    capabilities: Object.freeze([...(payload.capabilities ?? [])]),
    room,
    lastActivity: at,
    savedAt: at,
  });
}

/**
 * Re-verify a stored consent without the short-lived challenge that originally
 * carried it. Signature, audience, wallet binding, room and grant expiry are
 * all checked; a grant is never widened because the stored envelope is used
 * verbatim by the caller.
 */
export async function verifyStoredConsent(
  consent,
  { origin, walletId, room, now = Date.now() } = {},
) {
  try {
    const payload = consent?.body?.payload;
    if (
      consent?.body?.type !== "connect/consent" ||
      payload?.version !== CONSENT_VERSION ||
      typeof origin !== "string" ||
      typeof payload.audience !== "string" ||
      payload.audience !== origin ||
      (room !== undefined && payload.room !== room) ||
      typeof walletId !== "string" ||
      consent.body.issuer !== walletId ||
      (payload.expiresAt !== null && !Number.isFinite(payload.expiresAt)) ||
      (payload.expiresAt !== null && payload.expiresAt <= now) ||
      !Array.isArray(payload.capabilities) ||
      typeof payload.requestNonce !== "string"
    )
      return false;
    return await verifyEnvelope(consent, {
      expectedIssuer: walletId,
      now,
      maxAgeMs:
        payload.expiresAt === null ? Infinity : STORED_CONSENT_MAX_AGE_MS,
    });
  } catch {
    return false;
  }
}

function usable(record, origin, at) {
  if (
    record?.schemaVersion !== SESSION_RECORD_VERSION ||
    record.audience !== origin ||
    (record.expiresAt !== null &&
      (!Number.isFinite(record.expiresAt) || record.expiresAt <= at))
  )
    return false;
  // The signed idle timeout is the inactivity rule. A null idle timeout is a
  // Never grant: it has no idle end, matching what the wallet itself enforces.
  if (
    Number.isFinite(record.idleTimeoutMs) &&
    (!Number.isFinite(record.lastActivity) ||
      at - record.lastActivity >= record.idleTimeoutMs)
  )
    return false;
  return true;
}

/**
 * Records the site may offer to resume. Filtering happens in `list`, so an
 * expired, idle, foreign-origin or tampered record never reaches the UI.
 */
export async function listResumableSessions(
  store,
  { origin, room, capabilities, now } = {},
) {
  if (!store || typeof origin !== "string") return [];
  return store.list(origin, { now, room, capabilities });
}

/**
 * localStorage-backed store, so a record survives a page refresh. `storage` is
 * injectable so tests use a plain object instead of a browser. All reads drop
 * invalid, expired, idle or foreign records so a tampered entry cannot grant
 * access after a refresh.
 */
export function createSessionStore({ storage, now = () => Date.now() } = {}) {
  const backing = storage ?? globalThis.localStorage;
  if (!backing || typeof backing.getItem !== "function")
    throw new TypeError("A localStorage-compatible store is required");

  const readAll = (origin) => {
    try {
      const parsed = JSON.parse(backing.getItem(originKey(origin)) ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const writeAll = (origin, records) => {
    try {
      if (records.length === 0) backing.removeItem(originKey(origin));
      else backing.setItem(originKey(origin), JSON.stringify(records));
    } catch {
      // A browser that blocks storage simply cannot resume later; the current
      // connection still works and no key material is ever involved.
    }
  };

  return {
    async list(origin, { now: at = now(), room, capabilities } = {}) {
      const records = readAll(origin);
      const kept = [];
      for (const record of records) {
        if (!usable(record, origin, at)) continue;
        if (room !== undefined && record.room !== room) continue;
        if (
          Array.isArray(capabilities) &&
          !capabilities.every((capability) =>
            record.capabilities?.includes(capability),
          )
        )
          continue;
        if (
          !(await verifyStoredConsent(record.consent, {
            origin,
            walletId: record.walletId,
            room: record.room,
            now: at,
          }))
        )
          continue;
        kept.push(record);
      }
      if (kept.length !== records.length) writeAll(origin, kept);
      return kept;
    },
    async save(origin, record) {
      if (!record || typeof record.agentKey !== "string")
        throw new TypeError("A session record with an agentKey is required");
      const at = now();
      const stored = {
        ...record,
        schemaVersion: SESSION_RECORD_VERSION,
        audience: record.audience ?? origin,
        lastActivity: record.lastActivity ?? at,
        savedAt: record.savedAt ?? at,
      };
      const records = readAll(origin).filter(
        (entry) => entry.agentKey !== record.agentKey,
      );
      records.push(stored);
      writeAll(origin, records);
      return stored;
    },
    touch(origin, agentKey, at = now()) {
      const records = readAll(origin);
      const index = records.findIndex((entry) => entry.agentKey === agentKey);
      if (index === -1) return false;
      records[index] = { ...records[index], lastActivity: at };
      writeAll(origin, records);
      return true;
    },
    remove(origin, agentKey) {
      writeAll(
        origin,
        readAll(origin).filter((entry) => entry.agentKey !== agentKey),
      );
    },
    clear(origin) {
      backing.removeItem(originKey(origin));
    },
  };
}
