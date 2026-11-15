import { canonicalize, identityFor } from "./index.js";
import {
  isObject,
  publicJwk,
  randomId,
  signDomain,
  verifyDomain,
} from "./codec.js";
import { verifyEpochRecord, verifyRevocation } from "./revocation.js";
import { verifyLinkRevocation } from "./links.js";

export const MEMBERSHIP_TYPE = "ai-auth-membership";
export const MEMBERSHIP_VERSION = 1;
export const MAX_MEMBERSHIP_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MEMBERSHIP_TTL_MS = 60 * 60 * 1000;
export const ROOM_MODES = Object.freeze(["open", "restricted"]);
export const ROLES = Object.freeze(["owner", "member", "observer"]);
export const OPEN_ROOM_DISCLOSURE =
  "Open room: anyone who knows this site's origin and room name can join, see public content, and send events. The room topic hash is public. Do not share private data here.";

export const EXECUTION_GRANT_TYPE = "ai-auth-execution-grant";
export const MAX_EXECUTION_GRANT_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_EXECUTION_GRANT_TTL_MS = 5 * 60 * 1000;
export const DURATION_KINDS = Object.freeze([
  "short",
  "configured",
  "long",
  "until-revoked",
]);
/** Upper bound (ms) of the signed lifetime for each duration kind. */
export const DURATION_LIMITS = Object.freeze({
  short: 60 * 60 * 1000,
  configured: 24 * 60 * 60 * 1000,
  long: 30 * 24 * 60 * 60 * 1000,
  "until-revoked": 365 * 24 * 60 * 60 * 1000,
});

const DOMAIN = "ai-auth-membership/v1\n";
const GRANT_DOMAIN = "ai-auth-execution-grant/v1\n";
const MAX_REVOCATIONS = 4096;
export const CATCHUP_MAX_RECORDS = 32;
export const CATCHUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SHORT_TTL_MS = 15 * 60 * 1000;
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
// Optional signed fields; absent on proofs issued without them, so existing
// proofs keep verifying byte-for-byte.
const OPTIONAL_KEYS = ["epoch", "durationKind"];
const GRANT_KEYS = [
  "type",
  "v",
  "id",
  "issuer",
  "subject",
  "origin",
  "room",
  "membershipId",
  "scopes",
  "epoch",
  "issuedAt",
  "expiresAt",
];
const validEpoch = (n) => Number.isSafeInteger(n) && n >= 0;

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

function signedBody(fields) {
  const body = {};
  for (const key of [...KEYS, ...OPTIONAL_KEYS])
    if (key in fields && (KEYS.includes(key) || fields[key] !== undefined))
      body[key] = fields[key];
  return canonicalize(body);
}

/**
 * Resolve a membership `duration` policy to a signed lifetime. `long` is
 * clamped to its cap; `until-revoked` has no caller-chosen ttl and is signed
 * with a fixed one-year horizon (renew by re-issuing).
 */
export function resolveDuration(duration) {
  if (!isObject(duration) || !DURATION_KINDS.includes(duration.kind))
    throw new TypeError("Unknown membership duration kind");
  const { kind } = duration;
  if (kind === "until-revoked")
    return Object.freeze({ kind, ttlMs: DURATION_LIMITS[kind] });
  const ttl =
    duration.ttlMs ?? (kind === "short" ? DEFAULT_SHORT_TTL_MS : undefined);
  if (!Number.isFinite(ttl) || ttl <= 0)
    throw new TypeError("Membership duration needs a positive ttlMs");
  if (kind === "configured" && ttl > DURATION_LIMITS.configured)
    throw new TypeError("Configured membership lifetime is out of bounds");
  return Object.freeze({ kind, ttlMs: Math.min(ttl, DURATION_LIMITS[kind]) });
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
    duration,
    epoch,
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
  const resolved = duration === undefined ? null : resolveDuration(duration);
  const lifetime = resolved?.ttlMs ?? ttlMs;
  if (
    !Number.isFinite(lifetime) ||
    lifetime <= 0 ||
    (!resolved && lifetime > MAX_MEMBERSHIP_TTL_MS)
  )
    throw new TypeError("Membership lifetime is out of bounds");
  if (epoch !== undefined && !validEpoch(epoch))
    throw new TypeError("epoch must be a non-negative integer");
  const fields = {
    type: MEMBERSHIP_TYPE,
    v: MEMBERSHIP_VERSION,
    id: randomId(),
    issuer: publicJwk(issuerWallet.publicKey),
    subject,
    origin,
    room,
    role,
    scopes: [...scopes],
    issuedAt: now,
    expiresAt: now + lifetime,
    ...(epoch === undefined ? {} : { epoch }),
    ...(resolved ? { durationKind: resolved.kind } : {}),
  };
  const signature = await signDomain(
    issuerWallet.privateKey,
    DOMAIN,
    signedBody(fields),
  );
  return Object.freeze({ ...fields, signature });
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
  const optional = OPTIONAL_KEYS.filter((k) => k in p);
  if (
    keys.length !== KEYS.length + 1 + optional.length ||
    !KEYS.every((k) => k in p)
  )
    return "malformed";
  if ("epoch" in p && !validEpoch(p.epoch)) return "malformed";
  if ("durationKind" in p && !DURATION_KINDS.includes(p.durationKind))
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
  const maxLifetime = DURATION_LIMITS[p.durationKind] ?? MAX_MEMBERSHIP_TTL_MS;
  if (p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > maxLifetime)
    return "lifetime-out-of-bounds";
  if (p.issuedAt > now + CLOCK_SKEW_MS) return "not-yet-valid";
  if (p.expiresAt <= now) return "expired";
  return null;
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
  if (
    !(await verifyDomain(
      proof.issuer,
      proof.signature,
      DOMAIN,
      signedBody(proof),
    ))
  )
    return fail("bad-signature");
  return Object.freeze({
    ok: true,
    id: proof.id,
    issuerId,
    subject: proof.subject,
    role: proof.role,
    scopes: Object.freeze([...proof.scopes]),
    expiresAt: proof.expiresAt,
    epoch: proof.epoch ?? 0,
    durationKind: proof.durationKind ?? null,
  });
}

const grantBody = (g) =>
  canonicalize(Object.fromEntries(GRANT_KEYS.map((k) => [k, g[k]])));

/**
 * Issue a short-lived execution grant. Membership says who may take part; the
 * grant is what lets a member run protected operations, and it expires fast
 * (at most 15 minutes) so a missed revocation stays bounded. Renew by issuing
 * a new grant (see `renewExecutionGrant`).
 */
export async function issueExecutionGrant(
  issuerWallet,
  {
    subject,
    origin,
    room,
    membershipId,
    scopes = [],
    epoch = 0,
    ttlMs = DEFAULT_EXECUTION_GRANT_TTL_MS,
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
  if (typeof membershipId !== "string" || !ID_PATTERN.test(membershipId))
    throw new TypeError("membershipId is required");
  if (!validScopes(scopes, "member")) throw new TypeError("Invalid scopes");
  if (!validEpoch(epoch)) throw new TypeError("Invalid epoch");
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_EXECUTION_GRANT_TTL_MS
  )
    throw new TypeError("Execution grant lifetime is out of bounds");
  const fields = {
    type: EXECUTION_GRANT_TYPE,
    v: 1,
    id: randomId(),
    issuer: publicJwk(issuerWallet.publicKey),
    subject,
    origin,
    room,
    membershipId,
    scopes: [...scopes],
    epoch,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const signature = await signDomain(
    issuerWallet.privateKey,
    GRANT_DOMAIN,
    grantBody(fields),
  );
  return Object.freeze({ ...fields, signature });
}

/** Re-issue a grant with the same bindings and a fresh lifetime. */
export function renewExecutionGrant(issuerWallet, grant, { ttlMs, now } = {}) {
  if (!isObject(grant) || grant.type !== EXECUTION_GRANT_TYPE)
    return Promise.reject(new TypeError("Not an execution grant"));
  const { subject, origin, room, membershipId, scopes, epoch } = grant;
  return issueExecutionGrant(issuerWallet, {
    subject,
    origin,
    room,
    membershipId,
    scopes,
    epoch,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(now === undefined ? {} : { now }),
  });
}

function grantShapeError(g, now) {
  if (!isObject(g) || g.type !== EXECUTION_GRANT_TYPE || g.v !== 1)
    return "malformed";
  if (
    Object.keys(g).length !== GRANT_KEYS.length + 1 ||
    !GRANT_KEYS.every((k) => k in g) ||
    typeof g.signature !== "string" ||
    typeof g.id !== "string" ||
    !ID_PATTERN.test(g.id) ||
    typeof g.membershipId !== "string" ||
    !ID_PATTERN.test(g.membershipId) ||
    typeof g.subject !== "string" ||
    typeof g.origin !== "string" ||
    typeof g.room !== "string" ||
    !isObject(g.issuer) ||
    !validEpoch(g.epoch) ||
    !validScopes(g.scopes, "member") ||
    !Number.isFinite(g.issuedAt) ||
    !Number.isFinite(g.expiresAt)
  )
    return "malformed";
  if (
    g.expiresAt <= g.issuedAt ||
    g.expiresAt - g.issuedAt > MAX_EXECUTION_GRANT_TTL_MS
  )
    return "lifetime-out-of-bounds";
  if (g.issuedAt > now + CLOCK_SKEW_MS) return "not-yet-valid";
  if (g.expiresAt <= now) return "expired";
  return null;
}

/** Locally verify an execution grant; fails closed like `verifyMembership`. */
export async function verifyExecutionGrant(
  grant,
  { trustPolicy, expectedOrigin, expectedRoom, expectedSubject, now } = {},
) {
  const at = typeof now === "function" ? now() : (now ?? Date.now());
  const fail = (reason) => Object.freeze({ ok: false, reason });
  const bad = grantShapeError(grant, at);
  if (bad) return fail(bad);
  if (!expectedOrigin || !expectedRoom || !expectedSubject)
    return fail("expectations-required");
  if (grant.origin !== expectedOrigin) return fail("wrong-origin");
  if (grant.room !== expectedRoom) return fail("wrong-room");
  if (grant.subject !== expectedSubject) return fail("wrong-subject");
  let issuerId;
  try {
    issuerId = await identityFor(publicJwk(grant.issuer));
  } catch {
    return fail("malformed");
  }
  if (!(await trustedIssuerIds(trustPolicy?.issuers)).has(issuerId))
    return fail("untrusted-issuer");
  if (
    !(await verifyDomain(
      grant.issuer,
      grant.signature,
      GRANT_DOMAIN,
      grantBody(grant),
    ))
  )
    return fail("bad-signature");
  return Object.freeze({
    ok: true,
    id: grant.id,
    issuerId,
    subject: grant.subject,
    membershipId: grant.membershipId,
    scopes: Object.freeze([...grant.scopes]),
    epoch: grant.epoch,
    expiresAt: grant.expiresAt,
  });
}

const deny = (reason) => Object.freeze({ allow: false, reason });

/**
 * Fail-closed gate for protected operations. Allows only when the membership
 * is valid and unrevoked, its epoch is current, the identity is not revoked,
 * and a live execution grant of the current epoch covers `scope`. Any missing,
 * unknown or stale input denies with a reason. Open rooms never allow.
 */
export function authorizeProtected({ policy, walletId, scope, now } = {}) {
  if (typeof policy?.inspect !== "function") return deny("missing-policy");
  if (typeof walletId !== "string" || !walletId) return deny("missing-wallet");
  if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope))
    return deny("missing-scope");
  const at = typeof now === "function" ? now() : (now ?? Date.now());
  if (!Number.isFinite(at)) return deny("invalid-time");
  let s;
  try {
    s = policy.inspect(walletId, at);
  } catch {
    return deny("policy-error");
  }
  if (!s || s.mode !== "restricted") return deny("restricted-room-required");
  if (s.walletRevoked) return deny("revoked");
  if (!s.member) return deny("no-membership");
  if (s.membershipRevoked) return deny("revoked");
  if (s.member.epoch < s.epoch) return deny("stale-epoch");
  const owner = s.member.role === "owner" && s.member.scopes.includes("*");
  if (!owner && !s.member.scopes.includes(scope))
    return deny("scope-not-granted");
  if (!s.grant) return deny("no-execution-grant");
  if (s.grant.expiresAt <= at) return deny("grant-expired");
  if (s.grant.epoch < s.epoch) return deny("stale-epoch");
  if (s.grant.membershipId !== s.member.id)
    return deny("grant-membership-mismatch");
  if (!s.grant.scopes.includes(scope)) return deny("scope-not-granted");
  return Object.freeze({
    allow: true,
    reason: "ok",
    role: s.member.role,
    grantExpiresAt: s.grant.expiresAt,
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
  epoch: initialEpoch = 0,
  now = () => Date.now(),
} = {}) {
  if (!ROOM_MODES.includes(mode)) throw new TypeError("Unknown room mode");
  if (typeof origin !== "string" || !origin)
    throw new TypeError("An exact origin is required");
  if (typeof room !== "string" || !ROOM_PATTERN.test(room))
    throw new TypeError("A valid room name is required");
  if (!validEpoch(initialEpoch)) throw new TypeError("Invalid epoch");
  const issuers = Object.freeze([...(trustPolicy?.issuers ?? [])]);
  const members = new Map();
  const grants = new Map();
  const blocked = new Set();
  const revoked = new Map();
  const revocations = {
    membership: new Set(),
    link: new Set(),
    wallet: new Set(),
  };
  const appliedIds = new Set();
  // Applied records kept for bounded catch-up of peers that were offline.
  const log = [];
  let latestEpochRecord = null;
  let epoch = initialEpoch;
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
  const denied = (walletId) =>
    blocked.has(walletId) || revocations.wallet.has(walletId);
  const raiseEpoch = (next) => {
    if (next > epoch) {
      epoch = next;
      for (const [id, m] of members) if (m.epoch < epoch) members.delete(id);
      for (const [id, g] of grants) if (g.epoch < epoch) grants.delete(id);
    }
    return epoch;
  };
  const evict = ({ kind, target }) => {
    if (kind === "wallet") {
      members.delete(target);
      grants.delete(target);
    } else if (kind === "membership") {
      for (const [id, m] of members) if (m.id === target) members.delete(id);
      for (const [id, g] of grants)
        if (g.membershipId === target) grants.delete(id);
    }
  };
  const refuse = (reason) => Object.freeze({ ok: false, reason });
  return Object.freeze({
    mode,
    origin,
    room,
    disclosure: open ? OPEN_ROOM_DISCLOSURE : null,
    get epoch() {
      return epoch;
    },
    /** Invalidate every proof and grant issued under an older epoch. */
    bumpEpoch: () => raiseEpoch(epoch + 1),
    /** Learn a newer epoch from elsewhere; never lowers the epoch. */
    observeEpoch: (next) => (validEpoch(next) ? raiseEpoch(next) : epoch),
    /** Link revocations, shaped for `verifyLink({ revokedLinks })`. */
    revokedLinks: Object.freeze({ has: (id) => revocations.link.has(id) }),
    async admit(peerWalletId, proof) {
      if (denied(peerWalletId))
        return refuse(blocked.has(peerWalletId) ? "blocked" : "revoked");
      if (open) return Object.freeze({ ok: true, role: "member" });
      const result = await verifyMembership(proof, {
        trustPolicy: { issuers },
        expectedOrigin: origin,
        expectedRoom: room,
        expectedSubject: peerWalletId,
        now,
      });
      if (!result.ok) return result;
      pruneRevoked();
      if (
        denied(peerWalletId) ||
        revoked.has(result.id) ||
        revocations.membership.has(result.id)
      )
        return refuse("revoked");
      if (result.epoch < epoch) return refuse("stale-epoch");
      if (members.size >= MAX_MEMBERS && !members.has(peerWalletId))
        return refuse("roster-full");
      members.set(peerWalletId, {
        id: result.id,
        role: result.role,
        scopes: result.scopes,
        expiresAt: result.expiresAt,
        epoch: result.epoch,
        durationKind: result.durationKind,
      });
      return result;
    },
    /** Store a verified execution grant for a wallet (latest expiry wins). */
    async admitGrant(walletId, grant) {
      const result = await verifyExecutionGrant(grant, {
        trustPolicy: { issuers },
        expectedOrigin: origin,
        expectedRoom: room,
        expectedSubject: walletId,
        now,
      });
      if (!result.ok) return result;
      if (denied(walletId) || revocations.membership.has(result.membershipId))
        return refuse("revoked");
      if (result.epoch < epoch) return refuse("stale-epoch");
      const current = grants.get(walletId);
      if (!current || current.expiresAt <= result.expiresAt)
        grants.set(walletId, result);
      return result;
    },
    /**
     * Verify and apply a signed revocation record. Idempotent: a record id is
     * applied once; a replay returns `{ ok: true, applied: false }`.
     */
    async applyRevocation(record) {
      if (appliedIds.has(record?.id))
        return Object.freeze({ ok: true, applied: false });
      const result = await verifyRevocation(record, {
        trustPolicy: { issuers },
        expectedOrigin: origin,
        expectedRoom: room,
        now,
      });
      if (!result.ok) return result;
      if (appliedIds.has(record.id))
        return Object.freeze({ ok: true, applied: false });
      if (appliedIds.size >= MAX_REVOCATIONS)
        return refuse("revocation-store-full");
      appliedIds.add(record.id);
      revocations[record.kind].add(record.target);
      log.push({ at: record.issuedAt, kind: "revocations", record });
      evict(record);
      return Object.freeze({ ok: true, applied: true, kind: record.kind });
    },
    /**
     * Verify and apply a wallet-signed `ai-auth-link-revocation` event so the
     * site's revoked-link view follows peers. Idempotent by link id.
     */
    async applyLinkRevocation(event) {
      const result = await verifyLinkRevocation(event, {
        expectedOrigin: origin,
        now: now(),
      });
      if (!result.valid) return refuse(result.reason);
      const { linkId } = result.revocation;
      if (revocations.link.has(linkId))
        return Object.freeze({ ok: true, applied: false, kind: "link" });
      if (appliedIds.size >= MAX_REVOCATIONS)
        return refuse("revocation-store-full");
      appliedIds.add(`link-event:${linkId}`);
      revocations.link.add(linkId);
      log.push({
        at: result.revocation.revokedAt,
        kind: "linkRevocations",
        record: event,
      });
      return Object.freeze({ ok: true, applied: true, kind: "link" });
    },
    /**
     * Verify and apply a signed `ai-auth-epoch` announcement. The epoch only
     * moves forward; a stale or equal announcement is a no-op.
     */
    async applyEpoch(record) {
      const result = await verifyEpochRecord(record, {
        trustPolicy: { issuers },
        expectedOrigin: origin,
        expectedRoom: room,
        now,
      });
      if (!result.ok) return result;
      if (record.epoch > epoch) {
        raiseEpoch(record.epoch);
        latestEpochRecord = record;
        return Object.freeze({ ok: true, applied: true, kind: "epoch" });
      }
      if (record.epoch === epoch && !latestEpochRecord)
        latestEpochRecord = record;
      return Object.freeze({ ok: true, applied: false, kind: "epoch" });
    },
    /**
     * Bounded, newest-first slice of applied records for catch-up: at most
     * `limit` records (never above CATCHUP_MAX_RECORDS) no older than
     * `maxAgeMs`, plus the latest epoch announcement if it is current.
     */
    recentRecords({
      limit = CATCHUP_MAX_RECORDS,
      maxAgeMs = CATCHUP_MAX_AGE_MS,
    } = {}) {
      const t = now();
      const cap = Math.min(Math.max(0, limit | 0), CATCHUP_MAX_RECORDS);
      const out = { epoch: null, revocations: [], linkRevocations: [] };
      if (latestEpochRecord?.epoch === epoch) out.epoch = latestEpochRecord;
      for (let i = log.length - 1; i >= 0; i--) {
        const entry = log[i];
        if (out.revocations.length + out.linkRevocations.length >= cap) break;
        if (t - entry.at <= maxAgeMs) out[entry.kind].push(entry.record);
      }
      return Object.freeze(out);
    },
    isRevoked: (kind, target) => revocations[kind]?.has(target) ?? false,
    /** Read-only view used by `authorizeProtected`. */
    inspect(walletId) {
      const m = live(walletId);
      return Object.freeze({
        mode,
        epoch,
        walletRevoked: denied(walletId),
        member: m && Object.freeze({ ...m }),
        membershipRevoked:
          Boolean(m) && (revocations.membership.has(m.id) || revoked.has(m.id)),
        grant: grants.get(walletId) ?? null,
      });
    },
    remove(walletId) {
      const m = members.get(walletId);
      if (m && revoked.size < MAX_TRACKED) revoked.set(m.id, m.expiresAt);
      grants.delete(walletId);
      return members.delete(walletId);
    },
    block(walletId) {
      if (blocked.size >= MAX_TRACKED && !blocked.has(walletId)) return false;
      blocked.add(walletId);
      members.delete(walletId);
      grants.delete(walletId);
      return true;
    },
    unblock: (walletId) => blocked.delete(walletId),
    isBlocked: (walletId) => blocked.has(walletId),
    isMember: (walletId) =>
      !denied(walletId) && (open || live(walletId) !== null),
    roleOf: (walletId) =>
      denied(walletId) ? null : (live(walletId)?.role ?? null),
    can(walletId, scope) {
      if (denied(walletId)) return false;
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
              epoch: members.get(id).epoch,
              durationKind: members.get(id).durationKind,
            }),
          ),
      ),
  });
}
