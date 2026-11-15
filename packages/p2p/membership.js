import { canonicalize, identityFor } from "./index.js";

export const MEMBERSHIP_TYPE = "ai-auth-membership";
export const MEMBERSHIP_VERSION = 1;
export const MAX_MEMBERSHIP_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MEMBERSHIP_TTL_MS = 60 * 60 * 1000;
export const ROOM_MODES = Object.freeze(["open", "restricted"]);
export const ROLES = Object.freeze(["owner", "member", "observer"]);
export const OPEN_ROOM_DISCLOSURE =
  "Open room: anyone who knows this site's origin and room name can join, see public content, and send events. The room topic hash is public. Do not share private data here.";

const DOMAIN = "ai-auth-membership/v1\n";
const MAX_SCOPES = 32;
const MAX_MEMBERS = 256;
const MAX_TRACKED = 1024;
const CLOCK_SKEW_MS = 30_000;
const SCOPE_PATTERN = /^[a-z*][a-z0-9._*-]{0,63}$/u;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const WALLET_PATTERN = /^agent:[A-Za-z0-9_-]{20,64}$/u;
const KEYS = [
  "type",
  "v",
  "id",
  "issuer",
  "subject",
  "origin",
  "room",
  "role",
  "scopes",
  "issuedAt",
  "expiresAt",
];
const encoder = new TextEncoder();

function b64u(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function unb64u(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value))
    throw new TypeError("Invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const publicJwk = (k) => ({ kty: k.kty, crv: k.crv, x: k.x, y: k.y });
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

function validScopes(scopes, role) {
  if (
    !Array.isArray(scopes) ||
    scopes.length > MAX_SCOPES ||
    new Set(scopes).size !== scopes.length ||
    !scopes.every((s) => typeof s === "string" && SCOPE_PATTERN.test(s))
  )
    return false;
  if (role === "observer") return scopes.every((s) => s.endsWith(".read"));
  return role === "owner" || !scopes.includes("*");
}

function signingBytes(fields) {
  const body = {};
  for (const key of KEYS) body[key] = fields[key];
  return encoder.encode(DOMAIN + canonicalize(body));
}

/** Issue a site/host-signed, room- and origin-bound membership proof. */
export async function issueMembership(
  issuerWallet,
  {
    subject,
    origin,
    room,
    role = "member",
    scopes = [],
    ttlMs = DEFAULT_MEMBERSHIP_TTL_MS,
    now = Date.now(),
  } = {},
) {
  if (!issuerWallet?.privateKey || !issuerWallet.publicKey)
    throw new TypeError("An issuer wallet with a signing key is required");
  if (typeof subject !== "string" || !WALLET_PATTERN.test(subject))
    throw new TypeError("subject must be a wallet id");
  if (typeof origin !== "string" || !origin || origin.length > 200)
    throw new TypeError("An exact origin is required");
  if (typeof room !== "string" || !ROOM_PATTERN.test(room))
    throw new TypeError("A valid room name is required");
  if (!ROLES.includes(role)) throw new TypeError("Unknown role");
  if (!validScopes(scopes, role)) throw new TypeError("Invalid scopes");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_MEMBERSHIP_TTL_MS)
    throw new TypeError("Membership lifetime is out of bounds");
  const fields = {
    type: MEMBERSHIP_TYPE,
    v: MEMBERSHIP_VERSION,
    id: b64u(crypto.getRandomValues(new Uint8Array(18))),
    issuer: publicJwk(issuerWallet.publicKey),
    subject,
    origin,
    room,
    role,
    scopes: [...scopes],
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    issuerWallet.privateKey,
    signingBytes(fields),
  );
  return Object.freeze({ ...fields, signature: b64u(signature) });
}

async function trustedIssuerIds(issuers) {
  const ids = new Set();
  if (!Array.isArray(issuers)) return ids;
  for (const entry of issuers) {
    try {
      ids.add(
        typeof entry === "string" ? entry : await identityFor(publicJwk(entry)),
      );
    } catch {
      /* an unusable trust entry never widens trust */
    }
  }
  return ids;
}

function shapeError(p, now) {
  if (!isObject(p) || p.type !== MEMBERSHIP_TYPE || p.v !== MEMBERSHIP_VERSION)
    return "malformed";
  const keys = Object.keys(p);
  if (keys.length !== KEYS.length + 1 || !KEYS.every((k) => k in p))
    return "malformed";
  if (
    typeof p.id !== "string" ||
    !ID_PATTERN.test(p.id) ||
    typeof p.signature !== "string" ||
    typeof p.subject !== "string" ||
    typeof p.origin !== "string" ||
    typeof p.room !== "string" ||
    !isObject(p.issuer) ||
    !ROLES.includes(p.role) ||
    !validScopes(p.scopes, p.role)
  )
    return "malformed";
  if (!Number.isFinite(p.issuedAt) || !Number.isFinite(p.expiresAt))
    return "malformed";
  if (
    p.expiresAt <= p.issuedAt ||
    p.expiresAt - p.issuedAt > MAX_MEMBERSHIP_TTL_MS
  )
    return "lifetime-out-of-bounds";
  if (p.issuedAt > now + CLOCK_SKEW_MS) return "not-yet-valid";
  if (p.expiresAt <= now) return "expired";
  return null;
}

async function signatureValid(proof) {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk(proof.issuer),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      unb64u(proof.signature),
      signingBytes(proof),
    );
  } catch {
    return false;
  }
}

/**
 * Locally verify a membership proof. Fails closed: the trust policy, origin,
 * room, and subject must all be supplied and must match exactly.
 */
export async function verifyMembership(
  proof,
  { trustPolicy, expectedOrigin, expectedRoom, expectedSubject, now } = {},
) {
  const at = typeof now === "function" ? now() : (now ?? Date.now());
  const fail = (reason) => Object.freeze({ ok: false, reason });
  const bad = shapeError(proof, at);
  if (bad) return fail(bad);
  if (!expectedOrigin || !expectedRoom || !expectedSubject)
    return fail("expectations-required");
  if (proof.origin !== expectedOrigin) return fail("wrong-origin");
  if (proof.room !== expectedRoom) return fail("wrong-room");
  if (proof.subject !== expectedSubject) return fail("wrong-subject");
  let issuerId;
  try {
    issuerId = await identityFor(publicJwk(proof.issuer));
  } catch {
    return fail("malformed");
  }
  const trusted = await trustedIssuerIds(trustPolicy?.issuers);
  if (!trusted.has(issuerId)) return fail("untrusted-issuer");
  if (!(await signatureValid(proof))) return fail("bad-signature");
  return Object.freeze({
    ok: true,
    id: proof.id,
    issuerId,
    subject: proof.subject,
    role: proof.role,
    scopes: Object.freeze([...proof.scopes]),
    expiresAt: proof.expiresAt,
  });
}

/**
 * Local roster and policy. State is held in closure-private maps; callers only
 * receive frozen snapshots.
 */
export function createParticipationPolicy({
  mode = "restricted",
  trustPolicy,
  origin,
  room,
  now = () => Date.now(),
} = {}) {
  if (!ROOM_MODES.includes(mode)) throw new TypeError("Unknown room mode");
  if (typeof origin !== "string" || !origin)
    throw new TypeError("An exact origin is required");
  if (typeof room !== "string" || !ROOM_PATTERN.test(room))
    throw new TypeError("A valid room name is required");
  const issuers = Object.freeze([...(trustPolicy?.issuers ?? [])]);
  const members = new Map();
  const blocked = new Set();
  const revoked = new Map();
  const live = (walletId) => {
    const m = members.get(walletId);
    if (!m) return null;
    if (m.expiresAt <= now()) {
      members.delete(walletId);
      return null;
    }
    return m;
  };
  const pruneRevoked = () => {
    for (const [id, exp] of revoked) if (exp <= now()) revoked.delete(id);
  };
  const open = mode === "open";
  return Object.freeze({
    mode,
    origin,
    room,
    disclosure: open ? OPEN_ROOM_DISCLOSURE : null,
    async admit(peerWalletId, proof) {
      if (open) return Object.freeze({ ok: true, role: "member" });
      if (blocked.has(peerWalletId))
        return Object.freeze({ ok: false, reason: "blocked" });
      const result = await verifyMembership(proof, {
        trustPolicy: { issuers },
        expectedOrigin: origin,
        expectedRoom: room,
        expectedSubject: peerWalletId,
        now,
      });
      if (!result.ok) return result;
      pruneRevoked();
      if (blocked.has(peerWalletId) || revoked.has(result.id))
        return Object.freeze({ ok: false, reason: "revoked" });
      if (members.size >= MAX_MEMBERS && !members.has(peerWalletId))
        return Object.freeze({ ok: false, reason: "roster-full" });
      members.set(peerWalletId, {
        id: result.id,
        role: result.role,
        scopes: result.scopes,
        expiresAt: result.expiresAt,
      });
      return result;
    },
    remove(walletId) {
      const m = members.get(walletId);
      if (m && revoked.size < MAX_TRACKED) revoked.set(m.id, m.expiresAt);
      return members.delete(walletId);
    },
    block(walletId) {
      if (blocked.size >= MAX_TRACKED && !blocked.has(walletId)) return false;
      blocked.add(walletId);
      members.delete(walletId);
      return true;
    },
    unblock: (walletId) => blocked.delete(walletId),
    isBlocked: (walletId) => blocked.has(walletId),
    isMember: (walletId) =>
      !blocked.has(walletId) && (open || live(walletId) !== null),
    roleOf: (walletId) =>
      blocked.has(walletId) ? null : (live(walletId)?.role ?? null),
    can(walletId, scope) {
      if (blocked.has(walletId)) return false;
      if (open) return true;
      const m = live(walletId);
      if (!m) return false;
      return (
        m.scopes.includes(scope) ||
        (m.role === "owner" && m.scopes.includes("*"))
      );
    },
    snapshot: () =>
      Object.freeze(
        [...members.keys()]
          .filter((id) => live(id))
          .map((id) =>
            Object.freeze({
              walletId: id,
              role: members.get(id).role,
              scopes: members.get(id).scopes,
              expiresAt: members.get(id).expiresAt,
            }),
          ),
      ),
  });
}
