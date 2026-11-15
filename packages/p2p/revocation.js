import { canonicalize, identityFor } from "./index.js";
import {
  isObject,
  publicJwk,
  randomId,
  signDomain,
  verifyDomain,
} from "./codec.js";

export const REVOCATION_TYPE = "ai-auth-revocation";
export const REVOCATION_VERSION = 1;
export const REVOCATION_KINDS = Object.freeze(["membership", "link", "wallet"]);
export const REVOCATION_GOSSIP_EVENT = "revocation/gossip";

const DOMAIN = "ai-auth-revocation/v1\n";
const CLOCK_SKEW_MS = 30_000;
const MAX_SEEN = 4096;
const KEYS = [
  "type",
  "v",
  "id",
  "kind",
  "target",
  "origin",
  "room",
  "issuer",
  "issuedAt",
];
const TARGET_PATTERNS = {
  membership: /^[A-Za-z0-9_-]{16,64}$/u,
  link: /^link:[0-9a-f]{64}$/u,
  wallet: /^agent:[A-Za-z0-9_-]{20,64}$/u,
};

const fail = (reason) => Object.freeze({ ok: false, reason });
const bodyOf = (r) =>
  canonicalize(Object.fromEntries(KEYS.map((k) => [k, r[k]])));

/**
 * Sign a revocation of one membership id, link id, or wallet id. The signer
 * must be a key the verifying side trusts (a site/host issuer), except that a
 * wallet may always revoke itself (`kind: "wallet"`, target = its own id).
 */
export async function createRevocation(
  signerWallet,
  { kind, target, origin, room, now = Date.now() } = {},
) {
  if (!signerWallet?.privateKey || !signerWallet.publicKey)
    throw new TypeError("A signer wallet with a signing key is required");
  if (!REVOCATION_KINDS.includes(kind))
    throw new TypeError("Unknown revocation kind");
  if (typeof target !== "string" || !TARGET_PATTERNS[kind].test(target))
    throw new TypeError("Invalid revocation target for this kind");
  if (typeof origin !== "string" || !origin || origin.length > 200)
    throw new TypeError("An exact origin is required");
  if (typeof room !== "string" || !room || room.length > 100)
    throw new TypeError("A room name is required");
  if (!Number.isFinite(now)) throw new TypeError("Invalid timestamp");
  const fields = {
    type: REVOCATION_TYPE,
    v: REVOCATION_VERSION,
    id: randomId(),
    kind,
    target,
    origin,
    room,
    issuer: publicJwk(signerWallet.publicKey),
    issuedAt: now,
  };
  const signature = await signDomain(
    signerWallet.privateKey,
    DOMAIN,
    bodyOf(fields),
  );
  return Object.freeze({ ...fields, signature });
}

function shapeError(r) {
  if (!isObject(r) || r.type !== REVOCATION_TYPE || r.v !== REVOCATION_VERSION)
    return "malformed";
  const keys = Object.keys(r);
  if (keys.length !== KEYS.length + 1 || !KEYS.every((k) => k in r))
    return "malformed";
  if (
    typeof r.id !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/u.test(r.id) ||
    typeof r.signature !== "string" ||
    !REVOCATION_KINDS.includes(r.kind) ||
    typeof r.target !== "string" ||
    !TARGET_PATTERNS[r.kind].test(r.target) ||
    typeof r.origin !== "string" ||
    typeof r.room !== "string" ||
    !isObject(r.issuer) ||
    !Number.isFinite(r.issuedAt)
  )
    return "malformed";
  return null;
}

async function issuerTrusted(record, issuerId, issuers) {
  if (record.kind === "wallet" && record.target === issuerId) return true;
  if (!Array.isArray(issuers)) return false;
  for (const entry of issuers) {
    try {
      const id =
        typeof entry === "string" ? entry : await identityFor(publicJwk(entry));
      if (id === issuerId) return true;
    } catch {
      /* an unusable trust entry never widens trust */
    }
  }
  return false;
}

/** Locally verify a revocation record. Fails closed on any missing input. */
export async function verifyRevocation(
  record,
  { trustPolicy, expectedOrigin, expectedRoom, now } = {},
) {
  const at = typeof now === "function" ? now() : (now ?? Date.now());
  const bad = shapeError(record);
  if (bad) return fail(bad);
  if (!expectedOrigin || !expectedRoom) return fail("expectations-required");
  if (record.origin !== expectedOrigin) return fail("wrong-origin");
  if (record.room !== expectedRoom) return fail("wrong-room");
  if (record.issuedAt > at + CLOCK_SKEW_MS) return fail("not-yet-valid");
  let issuerId;
  try {
    issuerId = await identityFor(publicJwk(record.issuer));
  } catch {
    return fail("malformed");
  }
  if (!(await issuerTrusted(record, issuerId, trustPolicy?.issuers)))
    return fail("untrusted-issuer");
  if (
    !(await verifyDomain(
      record.issuer,
      record.signature,
      DOMAIN,
      bodyOf(record),
    ))
  )
    return fail("bad-signature");
  return Object.freeze({ ok: true, record, issuerId });
}

/**
 * Propagate revocations over a room's existing publish/subscribe API
 * (`room.send` / `room.subscribe`). Inbound records are verified and applied
 * to the local policy; each record id is processed once, so replays and relay
 * loops are no-ops. Invalid records are never relayed.
 */
export function createRevocationGossip(
  room,
  { policy = room?.policy, onApplied } = {},
) {
  if (typeof room?.send !== "function" || typeof room?.subscribe !== "function")
    throw new TypeError("A room with send() and subscribe() is required");
  if (typeof policy?.applyRevocation !== "function")
    throw new TypeError(
      "A participation policy with applyRevocation() is required",
    );
  const seen = new Set();
  const diagnostics = [];
  let closed = false;
  const note = (id, reason) => {
    if (diagnostics.length < 64)
      diagnostics.push(Object.freeze({ id, reason }));
  };
  async function handle(record, relay) {
    const id = typeof record?.id === "string" ? record.id : null;
    if (closed || !id || seen.has(id)) return { ok: true, applied: false };
    if (seen.size >= MAX_SEEN)
      return { ok: false, reason: "gossip-store-full" };
    // Claim the id before the async verify so concurrent copies are dropped.
    seen.add(id);
    const result = await policy.applyRevocation(record);
    if (!result.ok) {
      seen.delete(id);
      note(id, result.reason);
      return result;
    }
    if (result.applied) onApplied?.(record);
    if (relay && !closed)
      await room
        .send(REVOCATION_GOSSIP_EVENT, { revocation: record })
        .catch(() => {});
    return result;
  }
  const unsubscribe = room.subscribe((event) => {
    const body = event?.direction === "in" ? event.envelope?.body : null;
    if (body?.type !== REVOCATION_GOSSIP_EVENT) return;
    void handle(body.payload?.revocation, true).catch(() => {});
  });
  return Object.freeze({
    /** Apply a locally created record, then broadcast it to connected peers. */
    publish: (record) => handle(record, true),
    diagnostics: () => Object.freeze([...diagnostics]),
    close() {
      closed = true;
      unsubscribe();
    },
  });
}
