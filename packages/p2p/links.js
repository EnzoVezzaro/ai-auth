import {
  canonicalize,
  identityFor,
  randomNonce,
  signEnvelope,
  verifyEnvelope,
} from "./index.js";

export const LINK_TYPE = "ai-auth-link";
export const LINK_CHALLENGE_TYPE = "ai-auth-link-challenge";
export const LINK_REVOCATION_TYPE = "ai-auth-link-revocation";
export const LINK_POLICY = Object.freeze({
  maxChallengeSeconds: 600,
  defaultChallengeSeconds: 300,
  maxLinkSeconds: 30 * 24 * 60 * 60,
  defaultLinkSeconds: 7 * 24 * 60 * 60,
  clockSkewMs: 30_000,
});

const LINK_STORAGE_NAME = "ai-auth-wallet-links-v1";
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u;
const MAX_NONCE_STORE_ENTRIES = 10_000;
const REVOCATION_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const LINK_FIELDS = [
  "type",
  "v",
  "linkId",
  "origin",
  "resource",
  "walletId",
  "publicKey",
  "capabilities",
  "nonce",
  "createdAt",
  "expiresAt",
  "subject",
];
const REVOCATION_FIELDS = [
  "type",
  "v",
  "linkId",
  "origin",
  "resource",
  "walletId",
  "nonce",
  "revokedAt",
];

function fail(reason) {
  return { valid: false, reason };
}

function validOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" || url.protocol === "http:")
    );
  } catch {
    return false;
  }
}

function validResource(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 512;
}

function validSubject(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256;
}

function validNonce(value) {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function isCanonicalCapabilityList(values) {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((v) => typeof v === "string" && CAPABILITY_PATTERN.test(v)) &&
    values.every((v, i) => i === 0 || values[i - 1] < v)
  );
}

function normalizeCapabilities(values) {
  if (!Array.isArray(values) || values.length === 0)
    throw new TypeError("Choose at least one explicit capability");
  if (values.includes("*"))
    throw new TypeError("Capability wildcards are not supported");
  const sorted = [...new Set(values)].sort();
  if (
    sorted.length !== values.length ||
    !sorted.every((v) => typeof v === "string" && CAPABILITY_PATTERN.test(v))
  )
    throw new TypeError("Capabilities must be unique named operations");
  return sorted;
}

function hasExactKeys(object, allowed, required) {
  if (
    object === null ||
    typeof object !== "object" ||
    Object.getPrototypeOf(object) !== Object.prototype
  )
    return false;
  const keys = Object.keys(object);
  return (
    keys.every((key) => allowed.includes(key)) &&
    required.every((key) => keys.includes(key))
  );
}

export async function deriveLinkId({ origin, walletId, resource, nonce }) {
  const bytes = new TextEncoder().encode(
    canonicalize({ nonce, origin, resource, walletId }),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `link:${hex}`;
}

/** Site-side single-use nonce store. Sites may supply their own durable one. */
export function createLinkNonceStore() {
  const issued = new Map();
  return {
    issue(nonce, expiresAt) {
      if (issued.size >= MAX_NONCE_STORE_ENTRIES) {
        const now = Date.now();
        for (const [value, expiry] of issued)
          if (expiry <= now) issued.delete(value);
        if (issued.size >= MAX_NONCE_STORE_ENTRIES)
          throw new Error("Link nonce store is full");
      }
      issued.set(nonce, expiresAt);
    },
    consume(nonce, { now = Date.now() } = {}) {
      const expiresAt = issued.get(nonce);
      if (expiresAt === undefined) return false;
      issued.delete(nonce);
      return expiresAt > now;
    },
  };
}

/** Site-side set of revoked link ids, fed by verified revocation events. */
export function createRevokedLinkSet() {
  const revoked = new Map();
  return {
    has: (linkId) => revoked.has(linkId),
    async add(event, { expectedOrigin, now } = {}) {
      const result = await verifyLinkRevocation(event, { expectedOrigin, now });
      if (result.valid)
        revoked.set(result.revocation.linkId, result.revocation.revokedAt);
      return result;
    },
    list: () => [...revoked.keys()],
  };
}

export function createLinkChallenge({
  origin,
  resource,
  capabilities,
  subject,
  ttlSeconds = LINK_POLICY.defaultChallengeSeconds,
  nonceStore,
  now = Date.now(),
}) {
  if (!validOrigin(origin)) throw new TypeError("Challenge needs an origin");
  if (!validResource(resource))
    throw new TypeError("Challenge needs a resource identifier");
  if (subject !== undefined && !validSubject(subject))
    throw new TypeError("Invalid account subject");
  if (
    !Number.isFinite(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > LINK_POLICY.maxChallengeSeconds
  )
    throw new RangeError("Challenge lifetime is outside policy");
  const challenge = {
    type: LINK_CHALLENGE_TYPE,
    v: 1,
    origin,
    resource,
    capabilities: normalizeCapabilities(capabilities),
    nonce: randomNonce(),
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    ...(subject === undefined ? {} : { subject }),
  };
  nonceStore?.issue(challenge.nonce, challenge.expiresAt);
  return challenge;
}

function validateChallenge(challenge, now) {
  const ok =
    hasExactKeys(
      challenge,
      [
        "type",
        "v",
        "origin",
        "resource",
        "capabilities",
        "nonce",
        "createdAt",
        "expiresAt",
        "subject",
      ],
      [
        "type",
        "v",
        "origin",
        "resource",
        "capabilities",
        "nonce",
        "createdAt",
        "expiresAt",
      ],
    ) &&
    challenge.type === LINK_CHALLENGE_TYPE &&
    challenge.v === 1 &&
    validOrigin(challenge.origin) &&
    validResource(challenge.resource) &&
    isCanonicalCapabilityList(challenge.capabilities) &&
    validNonce(challenge.nonce) &&
    Number.isFinite(challenge.createdAt) &&
    Number.isFinite(challenge.expiresAt) &&
    challenge.expiresAt > now &&
    challenge.expiresAt - challenge.createdAt <=
      LINK_POLICY.maxChallengeSeconds * 1000 &&
    (challenge.subject === undefined || validSubject(challenge.subject));
  if (!ok) throw new Error("Link challenge is invalid or expired");
}

// ---- wallet-side local link records (origin-scoped IndexedDB) ----

function openLinks() {
  if (!globalThis.indexedDB)
    throw new Error("IndexedDB is unavailable in this browser");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LINK_STORAGE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("links", { keyPath: "linkId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withLinks(mode, action) {
  const db = await openLinks();
  try {
    const transaction = db.transaction("links", mode);
    const store = transaction.objectStore("links");
    const result = await new Promise((resolve, reject) => {
      const request = action(store);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Link storage was aborted"));
      transaction.oncomplete = () => resolve(request?.result);
    });
    return result;
  } finally {
    db.close();
  }
}

/** Removes every local link record; used when the wallet identity is forgotten. */
export async function clearLinkRecords() {
  await withLinks("readwrite", (store) => store.clear());
}

export async function approveLink(
  wallet,
  challenge,
  { capabilities, linkTtlSeconds = LINK_POLICY.defaultLinkSeconds, now } = {},
) {
  const at = now ?? Date.now();
  validateChallenge(challenge, at);
  const granted = normalizeCapabilities(capabilities);
  if (!granted.every((c) => challenge.capabilities.includes(c)))
    throw new Error("Approval contains a capability the site did not request");
  if (
    !Number.isFinite(linkTtlSeconds) ||
    linkTtlSeconds <= 0 ||
    linkTtlSeconds > LINK_POLICY.maxLinkSeconds
  )
    throw new RangeError("Link lifetime is outside policy");
  const base = {
    origin: challenge.origin,
    resource: challenge.resource,
    walletId: wallet.id,
    nonce: challenge.nonce,
  };
  const payload = {
    type: LINK_TYPE,
    v: 1,
    linkId: await deriveLinkId(base),
    ...base,
    publicKey: wallet.publicKey,
    capabilities: granted,
    createdAt: at,
    expiresAt: at + linkTtlSeconds * 1000,
    ...(challenge.subject === undefined ? {} : { subject: challenge.subject }),
  };
  const proof = await signEnvelope(wallet, LINK_TYPE, payload);
  await withLinks("readwrite", (store) =>
    store.put({ ...payload, walletId: wallet.id, proof }),
  );
  return proof;
}

export async function listLinks(wallet, { includeExpired = false, now } = {}) {
  const at = now ?? Date.now();
  const records = await withLinks("readonly", (store) => store.getAll());
  return records
    .filter((r) => r.walletId === wallet.id)
    .filter((r) => includeExpired || r.expiresAt > at)
    .map(({ proof, ...link }) => ({
      ...link,
      proof,
      expired: link.expiresAt <= at,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function unlink(wallet, linkId, { now } = {}) {
  const links = await listLinks(wallet, { includeExpired: true });
  const link = links.find((item) => item.linkId === linkId);
  if (!link) throw new Error("No such link for this wallet");
  const event = await signEnvelope(wallet, LINK_REVOCATION_TYPE, {
    type: LINK_REVOCATION_TYPE,
    v: 1,
    linkId: link.linkId,
    origin: link.origin,
    resource: link.resource,
    walletId: wallet.id,
    nonce: link.nonce,
    revokedAt: now ?? Date.now(),
  });
  await withLinks("readwrite", (store) => store.delete(linkId));
  return event;
}

// ---- site-side verification ----

// Envelope freshness is wallet-clock; link and revocation lifetimes are checked
// on their own signed payload fields, so only signature/issuer binding is used.
function verifySignature(envelope, type, now) {
  const stamp = Date.parse(envelope?.body?.createdAt);
  if (!Number.isFinite(stamp) || envelope.body.type !== type) return false;
  return verifyEnvelope(envelope, {
    now: Math.max(now, stamp),
    maxAgeMs: Number.MAX_SAFE_INTEGER,
  });
}

async function checkIdentity(payload, envelope) {
  try {
    return (
      (await identityFor(payload.publicKey)) === payload.walletId &&
      envelope.body.issuer === payload.walletId &&
      canonicalize(envelope.proof.publicKey) === canonicalize(payload.publicKey)
    );
  } catch {
    return false;
  }
}

function checkPayload(payload, expected, now) {
  if (
    !hasExactKeys(payload, LINK_FIELDS, LINK_FIELDS.slice(0, -1)) ||
    payload.type !== LINK_TYPE ||
    payload.v !== 1
  )
    return "malformed";
  if (payload.origin !== expected.expectedOrigin) return "origin-mismatch";
  if (payload.resource !== expected.expectedResource)
    return "resource-mismatch";
  if (
    !isCanonicalCapabilityList(payload.capabilities) ||
    !validNonce(payload.nonce)
  )
    return "malformed";
  if (
    !Number.isFinite(payload.createdAt) ||
    !Number.isFinite(payload.expiresAt)
  )
    return "malformed";
  if (
    payload.createdAt > now + LINK_POLICY.clockSkewMs ||
    payload.expiresAt - payload.createdAt > LINK_POLICY.maxLinkSeconds * 1000
  )
    return "lifetime-out-of-policy";
  if (payload.expiresAt <= now) return "expired";
  if (!payload.capabilities.every((c) => expected.capabilities.includes(c)))
    return "scope-escalation";
  if (
    expected.expectedSubject !== undefined &&
    payload.subject !== expected.expectedSubject
  )
    return "subject-mismatch";
  return null;
}

export async function verifyLink(
  proof,
  {
    expectedOrigin,
    expectedResource,
    expectedCapabilities,
    expectedSubject,
    nonceStore,
    revokedLinks,
    now = Date.now(),
  } = {},
) {
  if (
    !validOrigin(expectedOrigin) ||
    !validResource(expectedResource) ||
    !isCanonicalCapabilityList(expectedCapabilities) ||
    typeof nonceStore?.consume !== "function"
  )
    return fail("invalid-verifier-options");
  const payload = proof?.body?.payload;
  const problem = checkPayload(
    payload,
    {
      expectedOrigin,
      expectedResource,
      capabilities: expectedCapabilities,
      expectedSubject,
    },
    now,
  );
  if (problem) return fail(problem);
  if (!(await verifySignature(proof, LINK_TYPE, now)))
    return fail("bad-signature");
  if (!(await checkIdentity(payload, proof))) return fail("identity-mismatch");
  if (payload.linkId !== (await deriveLinkId(payload)))
    return fail("link-id-mismatch");
  if (revokedLinks?.has(payload.linkId)) return fail("revoked");
  if (!(await nonceStore.consume(payload.nonce, { now })))
    return fail("nonce-rejected");
  return { valid: true, link: payload };
}

export async function verifyLinkRevocation(
  event,
  { expectedOrigin, now = Date.now() } = {},
) {
  if (!validOrigin(expectedOrigin)) return fail("invalid-verifier-options");
  const payload = event?.body?.payload;
  if (
    !hasExactKeys(payload, REVOCATION_FIELDS, REVOCATION_FIELDS) ||
    payload.type !== LINK_REVOCATION_TYPE ||
    payload.v !== 1 ||
    !validResource(payload.resource) ||
    !validNonce(payload.nonce) ||
    !Number.isFinite(payload.revokedAt)
  )
    return fail("malformed");
  if (payload.origin !== expectedOrigin) return fail("origin-mismatch");
  if (payload.revokedAt > now + LINK_POLICY.clockSkewMs)
    return fail("revoked-in-future");
  if (now - payload.revokedAt > REVOCATION_MAX_AGE_MS) return fail("stale");
  if (
    !(await verifySignature(event, LINK_REVOCATION_TYPE, now)) ||
    event.body.issuer !== payload.walletId
  )
    return fail("bad-signature");
  if (payload.linkId !== (await deriveLinkId(payload)))
    return fail("link-id-mismatch");
  return { valid: true, revocation: payload };
}
