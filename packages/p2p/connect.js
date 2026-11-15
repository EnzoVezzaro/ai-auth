import { randomNonce, signEnvelope, verifyEnvelope } from "./index.js";

const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u;
const MAX_NONCE_LENGTH = 512;
const MAX_NONCE_ENTRIES = 10_000;
const NONCE_CLEANUP_INTERVAL_MS = 1_000;
export const CHALLENGE_MAX_MS = 120_000;
export const MIN_SESSION_TTL_MS = 1_000;
export const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
export const MAX_SESSION_TTL_MS = 60 * 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const CONSENT_VERSION = 2;
const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;

function validRoom(value) {
  if (typeof value !== "string" || !ROOM_PATTERN.test(value)) {
    throw new TypeError("A shared room name must be 1–100 safe characters");
  }
  return value;
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new TypeError("Choose at least one explicit capability");
  }
  const normalized = [...new Set(capabilities)];
  if (normalized.includes("*"))
    throw new TypeError("Capability wildcards are not supported");
  if (
    normalized.length !== capabilities.length ||
    normalized.some(
      (item) => typeof item !== "string" || !CAPABILITY_PATTERN.test(item),
    )
  ) {
    throw new TypeError(
      "Capabilities must be unique named operations; wildcards are not supported",
    );
  }
  return normalized.sort();
}

function validOrigin(value) {
  const origin = new URL(value);
  if (
    origin.origin !== value ||
    !["http:", "https:"].includes(origin.protocol)
  ) {
    throw new TypeError("Permission audience must be an exact HTTP origin");
  }
  return origin.origin;
}

function boundedMs(
  value,
  name,
  min = MIN_SESSION_TTL_MS,
  max = MAX_SESSION_TTL_MS,
) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be an integer between ${min} and ${max} milliseconds`,
    );
  }
  return value;
}

function optionalBounded(value, name) {
  return value === undefined ? undefined : boundedMs(value, name);
}

export class NonceGuard {
  #nonces = new Map();
  #nextCleanupAt = 0;

  consume(nonce, expiresAt, now = Date.now()) {
    if (now >= this.#nextCleanupAt) {
      for (const [value, expiry] of this.#nonces)
        if (expiry <= now) this.#nonces.delete(value);
      this.#nextCleanupAt = now + NONCE_CLEANUP_INTERVAL_MS;
    }
    if (
      typeof nonce !== "string" ||
      nonce.length < 20 ||
      nonce.length > MAX_NONCE_LENGTH ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(now) ||
      this.#nonces.has(nonce) ||
      expiresAt <= now ||
      expiresAt > now + CHALLENGE_MAX_MS ||
      this.#nonces.size >= MAX_NONCE_ENTRIES
    )
      return false;
    this.#nonces.set(nonce, expiresAt);
    return true;
  }
}

export async function createPermissionRequest(
  origin,
  capabilities,
  {
    expiresInMs = 60_000,
    room = "default",
    sessionTtlMs,
    idleTimeoutMs,
    renews,
  } = {},
) {
  if (
    !Number.isInteger(expiresInMs) ||
    expiresInMs < 1_000 ||
    expiresInMs > CHALLENGE_MAX_MS
  ) {
    throw new RangeError(
      "Permission request lifetime must be between 1 and 120 seconds",
    );
  }
  if (
    renews !== undefined &&
    (typeof renews !== "string" || renews.length > MAX_NONCE_LENGTH)
  )
    throw new TypeError("A renewal must name the consent request it renews");
  const now = Date.now();
  return {
    type: "ai-auth/permission-request",
    // Version 2 separates this short-lived, single-use challenge
    // (`expiresAt`) from the bounded session the wallet may grant.
    version: 2,
    audience: validOrigin(origin),
    nonce: randomNonce(),
    createdAt: now,
    expiresAt: now + expiresInMs,
    capabilities: normalizeCapabilities(capabilities),
    room: validRoom(room),
    ...(sessionTtlMs === undefined
      ? {}
      : { sessionTtlMs: boundedMs(sessionTtlMs, "Session lifetime") }),
    ...(idleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: boundedMs(idleTimeoutMs, "Idle timeout") }),
    ...(renews === undefined ? {} : { renews }),
  };
}

/**
 * The longest session a request may be granted. A request can only ask for
 * less than the hard cap; it can never extend its own grant.
 */
export function sessionLimits(request) {
  return {
    maxSessionTtlMs: Math.min(
      request?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      MAX_SESSION_TTL_MS,
    ),
    maxIdleTimeoutMs: Math.min(
      request?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      MAX_SESSION_TTL_MS,
    ),
  };
}

export async function approvePermissionRequest(
  wallet,
  request,
  approvedCapabilities,
  { sessionTtlMs, idleTimeoutMs, previousConsent, now = Date.now() } = {},
) {
  const approved = normalizeCapabilities(approvedCapabilities);
  const requestVerified = await verifyPermissionRequest(request, {
    expectedOrigin: request?.audience,
    now,
  });
  if (!requestVerified)
    throw new Error("Permission request is invalid or expired");
  const allowed = new Set(request.capabilities);
  if (approved.some((capability) => !allowed.has(capability))) {
    throw new Error(
      "Approval contains a capability the website did not request",
    );
  }
  if (request.renews !== undefined) {
    const previous = previousConsent?.body?.payload;
    if (
      !previous ||
      previous.requestNonce !== request.renews ||
      previous.audience !== request.audience ||
      previousConsent.body.issuer !== wallet.id
    )
      throw new Error("Renewal does not match the active consent");
    const before = new Set(previous.capabilities);
    if (approved.some((capability) => !before.has(capability)))
      throw new Error("Renewal cannot widen the approved capabilities");
  }
  const limits = sessionLimits(request);
  const ttl = boundedMs(
    sessionTtlMs ?? limits.maxSessionTtlMs,
    "Session lifetime",
  );
  if (ttl > limits.maxSessionTtlMs)
    throw new RangeError("Session lifetime exceeds the allowed grant");
  const idle = Math.min(
    boundedMs(idleTimeoutMs ?? limits.maxIdleTimeoutMs, "Idle timeout"),
    ttl,
  );
  if (idle > limits.maxIdleTimeoutMs)
    throw new RangeError("Idle timeout exceeds the allowed grant");
  return signEnvelope(wallet, "connect/consent", {
    version: CONSENT_VERSION,
    audience: request.audience,
    requestNonce: request.nonce,
    capabilities: approved,
    room: validRoom(request.room ?? "default"),
    issuedAt: now,
    challengeExpiresAt: request.expiresAt,
    expiresAt: now + ttl,
    sessionTtlMs: ttl,
    idleTimeoutMs: idle,
    ...(request.renews === undefined ? {} : { renewsNonce: request.renews }),
  });
}

export async function verifyPermissionRequest(
  request,
  { expectedOrigin, now = Date.now(), nonceGuard } = {},
) {
  try {
    if (
      request.type !== "ai-auth/permission-request" ||
      ![1, 2].includes(request.version)
    )
      return false;
    if (request.version === 1) {
      if (
        request.sessionTtlMs !== undefined ||
        request.idleTimeoutMs !== undefined ||
        request.renews !== undefined
      )
        return false;
    } else {
      optionalBounded(request.sessionTtlMs, "Session lifetime");
      optionalBounded(request.idleTimeoutMs, "Idle timeout");
      if (
        request.renews !== undefined &&
        (typeof request.renews !== "string" ||
          request.renews.length > MAX_NONCE_LENGTH)
      )
        return false;
    }
    if (request.audience !== validOrigin(expectedOrigin)) return false;
    validRoom(request.room ?? "default");
    if (
      !Number.isFinite(request.expiresAt) ||
      request.expiresAt <= now ||
      request.expiresAt > now + CHALLENGE_MAX_MS
    )
      return false;
    normalizeCapabilities(request.capabilities);
    if (
      typeof request.nonce !== "string" ||
      request.nonce.length < 20 ||
      request.nonce.length > MAX_NONCE_LENGTH
    )
      return false;
    const createdAt = Date.parse(
      request.issuerCreatedAt ?? new Date(request.createdAt).toISOString(),
    );
    if (!Number.isFinite(createdAt) || createdAt > now + 30_000) return false;
    return (
      !nonceGuard || nonceGuard.consume(request.nonce, request.expiresAt, now)
    );
  } catch {
    return false;
  }
}

export async function verifyPopupPermissionRequest(
  event,
  expectedSource,
  { now = Date.now() } = {},
) {
  try {
    if (
      !expectedSource ||
      event?.source !== expectedSource ||
      event.data?.type !== "ai-auth/connect-request"
    )
      return false;
    return await verifyPermissionRequest(event.data.request, {
      expectedOrigin: event.origin,
      now,
    });
  } catch {
    return false;
  }
}

export async function verifyPermissionConsent(
  consent,
  request,
  {
    expectedOrigin,
    expectedWallet,
    now = Date.now(),
    nonceGuard,
    previousConsent,
  } = {},
) {
  try {
    if (
      typeof expectedWallet !== "string" ||
      !expectedWallet.startsWith("agent:") ||
      typeof expectedOrigin !== "string" ||
      !nonceGuard ||
      !(await verifyPermissionRequest(request, { expectedOrigin, now }))
    )
      return false;
    if (
      !(await verifyEnvelope(consent, {
        expectedIssuer: expectedWallet,
        now,
        maxAgeMs: CHALLENGE_MAX_MS,
      }))
    )
      return false;
    const payload = consent.body.payload;
    if (
      consent.body.type !== "connect/consent" ||
      payload.audience !== validOrigin(expectedOrigin) ||
      payload.audience !== request.audience ||
      validRoom(payload.room ?? "default") !==
        validRoom(request.room ?? "default")
    )
      return false;
    if (
      payload.requestNonce !== request.nonce ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= now
    )
      return false;
    if (payload.version === CONSENT_VERSION) {
      // The signed expiry is the bounded session grant. It must be issued
      // while the single-use challenge was still valid, never outlast the
      // cap, and never exceed what the request itself allowed.
      const limits = sessionLimits(request);
      if (
        !Number.isFinite(payload.issuedAt) ||
        payload.issuedAt > now + 30_000 ||
        payload.issuedAt > request.expiresAt ||
        payload.challengeExpiresAt !== request.expiresAt ||
        !Number.isInteger(payload.sessionTtlMs) ||
        payload.sessionTtlMs < MIN_SESSION_TTL_MS ||
        payload.sessionTtlMs > limits.maxSessionTtlMs ||
        payload.expiresAt !== payload.issuedAt + payload.sessionTtlMs ||
        !Number.isInteger(payload.idleTimeoutMs) ||
        payload.idleTimeoutMs < MIN_SESSION_TTL_MS ||
        payload.idleTimeoutMs > payload.sessionTtlMs ||
        payload.idleTimeoutMs > limits.maxIdleTimeoutMs
      )
        return false;
      if (request.renews !== undefined) {
        const previous = previousConsent?.body?.payload;
        if (
          !previous ||
          previousConsent.body.issuer !== expectedWallet ||
          previous.requestNonce !== request.renews ||
          payload.renewsNonce !== request.renews ||
          previous.audience !== payload.audience ||
          (previous.room ?? "default") !== (payload.room ?? "default") ||
          !Array.isArray(payload.capabilities) ||
          payload.capabilities.some(
            (capability) => !previous.capabilities.includes(capability),
          )
        )
          return false;
      } else if (payload.renewsNonce !== undefined) return false;
    } else if (payload.version === undefined) {
      // Legacy consent: the signed expiry was the handshake expiry.
      if (payload.expiresAt > request.expiresAt) return false;
    } else return false;
    if (
      !Array.isArray(payload.capabilities) ||
      payload.capabilities.some(
        (capability) => !request.capabilities.includes(capability),
      )
    )
      return false;
    // The one-use guard tracks the challenge, not the session, so a replayed
    // consent is rejected for as long as the challenge could be valid.
    return nonceGuard.consume(payload.requestNonce, request.expiresAt, now);
  } catch {
    return false;
  }
}

/**
 * Tracks one verified session grant with an injectable clock. Expiry is the
 * signed grant expiry; idle timeout counts only authorized local activity.
 */
export class SessionLease {
  #payload;
  #clock;
  #lastActivityAt;
  #revoked = false;

  constructor(payload, { now = () => Date.now() } = {}) {
    if (!Number.isFinite(payload?.expiresAt))
      throw new TypeError("A signed session grant is required");
    this.#payload = payload;
    this.#clock = now;
    this.#lastActivityAt = now();
  }

  get expiresAt() {
    return this.#payload.expiresAt;
  }

  get idleTimeoutMs() {
    return this.#payload.idleTimeoutMs ?? null;
  }

  get lastActivityAt() {
    return this.#lastActivityAt;
  }

  /** Earliest time the lease can stop being usable without further activity. */
  get deadline() {
    return this.idleTimeoutMs === null
      ? this.expiresAt
      : Math.min(this.expiresAt, this.#lastActivityAt + this.idleTimeoutMs);
  }

  status() {
    if (this.#revoked) return "revoked";
    const now = this.#clock();
    if (this.#payload.expiresAt <= now) return "expired";
    if (
      this.idleTimeoutMs !== null &&
      this.#lastActivityAt + this.idleTimeoutMs <= now
    )
      return "idle";
    return "active";
  }

  isActive() {
    return this.status() === "active";
  }

  /** Records authorized activity. Returns false when the lease is unusable. */
  touch() {
    if (!this.isActive()) return false;
    this.#lastActivityAt = this.#clock();
    return true;
  }

  /** Replaces the grant after a verified renewal. Never revives a dead lease. */
  renew(payload) {
    if (!this.isActive() || !Number.isFinite(payload?.expiresAt)) return false;
    const before = this.#payload.capabilities ?? [];
    if (
      payload.capabilities?.some((capability) => !before.includes(capability))
    )
      return false;
    this.#payload = payload;
    this.#lastActivityAt = this.#clock();
    return true;
  }

  revoke() {
    this.#revoked = true;
  }
}
