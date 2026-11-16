import { randomNonce, signEnvelope, verifyEnvelope } from "./index.js";
import {
  createAgentDescriptor,
  verifyAgentDescriptor,
} from "./agent-identity.js";

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
    // A request that names no lifetime opts in to Never; the wallet still shows
    // the visitor the choice and defaults to it.
    ...(sessionTtlMs === undefined ? { sessionPolicy: "never" } : {}),
    ...(sessionTtlMs === undefined
      ? {}
      : {
          sessionTtlMs:
            sessionTtlMs === null
              ? null
              : boundedMs(sessionTtlMs, "Session lifetime"),
        }),
    ...(idleTimeoutMs === undefined
      ? {}
      : {
          idleTimeoutMs:
            idleTimeoutMs === null
              ? null
              : boundedMs(idleTimeoutMs, "Idle timeout"),
        }),
    ...(renews === undefined ? {} : { renews }),
  };
}

/**
 * The longest session a request may be granted. A request can only ask for
 * less than the hard cap; it can never extend its own grant.
 */
export function sessionLimits(request) {
  // null means Never: no fixed end and no idle end. Only a request that opts
  // in (sessionPolicy "never", or an explicit null) allows Never. A numeric
  // hint caps the grant. A request without either comes from an SDK that
  // predates Never; its verifier needs a finite expiry, so it keeps the
  // 30 minute default.
  const hint = request?.sessionTtlMs;
  const maxSessionTtlMs =
    typeof hint === "number"
      ? hint
      : hint === null || request?.sessionPolicy === "never"
        ? null
        : DEFAULT_SESSION_TTL_MS;
  const idleHint = request?.idleTimeoutMs;
  const maxIdleTimeoutMs =
    idleHint !== undefined
      ? idleHint
      : maxSessionTtlMs === null
        ? null
        : Math.min(DEFAULT_IDLE_TIMEOUT_MS, maxSessionTtlMs);
  return { maxSessionTtlMs, maxIdleTimeoutMs };
}

// A signed or hinted limit: Never (null) or an integer grant length.
function optionalLimit(value, name) {
  return value === null ? null : optionalBounded(value, name);
}

// The wallet's choice must fit the request's limit. Never is allowed only when
// the request allows it; an undefined choice takes the request's limit.
function chooseLimit(choice, allowed, name) {
  if (choice === undefined) return allowed;
  if (choice === null) {
    if (allowed !== null)
      throw new RangeError(`${name} exceeds the allowed grant`);
    return null;
  }
  const value = boundedMs(choice, name);
  if (allowed !== null && value > allowed)
    throw new RangeError(`${name} exceeds the allowed grant`);
  return value;
}

// Whether a signed limit is valid under the request's limit (see chooseLimit).
function withinLimit(value, allowed) {
  if (value === null) return allowed === null;
  if (
    !Number.isInteger(value) ||
    value < MIN_SESSION_TTL_MS ||
    value > MAX_SESSION_TTL_MS
  )
    return false;
  return allowed === null || value <= allowed;
}

export async function approvePermissionRequest(
  wallet,
  request,
  approvedCapabilities,
  {
    sessionTtlMs,
    idleTimeoutMs,
    previousConsent,
    agent,
    now = Date.now(),
  } = {},
) {
  // Check the wallet first: without a wallet there is nothing to sign with.
  if (!wallet || typeof wallet.id !== "string")
    throw new TypeError("Create your wallet first, then connect.");
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
  if (request.version === 1) {
    // Version 1 requests come from sites bundling an older SDK that only
    // accepts the legacy consent: no version field and an expiry bounded by
    // the handshake. Session options are ignored; long sessions need a v2 SDK.
    return signEnvelope(wallet, "connect/consent", {
      audience: request.audience,
      requestNonce: request.nonce,
      capabilities: approved,
      expiresAt: request.expiresAt,
      room: validRoom(request.room ?? "default"),
    });
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
  const ttl = chooseLimit(
    sessionTtlMs,
    limits.maxSessionTtlMs,
    "Session lifetime",
  );
  // A numeric lifetime without an idle choice keeps the 10 minute idle default
  // (never longer than the lifetime), even when the site set no idle limit.
  let idle =
    idleTimeoutMs === undefined &&
    ttl !== null &&
    limits.maxIdleTimeoutMs === null
      ? Math.min(DEFAULT_IDLE_TIMEOUT_MS, ttl)
      : chooseLimit(idleTimeoutMs, limits.maxIdleTimeoutMs, "Idle timeout");
  if (idle !== null && ttl !== null) idle = Math.min(idle, ttl);
  // Optional signed self-description (`ai-auth-agent-descriptor` v1), bound to
  // this request's nonce, origin and room. Old verifiers ignore the extra
  // field; verifiers that know it check it. Legacy v1 consents never carry it.
  const agentDescriptor = agent
    ? await createAgentDescriptor(wallet, {
        ...agent,
        origin: request.audience,
        room: validRoom(request.room ?? "default"),
        sessionId: request.nonce,
        nonce: request.nonce,
        capabilities: approved,
        now,
        expiresAt: request.expiresAt,
      })
    : undefined;
  return signEnvelope(wallet, "connect/consent", {
    version: CONSENT_VERSION,
    ...(agentDescriptor ? { agentDescriptor } : {}),
    audience: request.audience,
    requestNonce: request.nonce,
    capabilities: approved,
    room: validRoom(request.room ?? "default"),
    issuedAt: now,
    challengeExpiresAt: request.expiresAt,
    expiresAt: ttl === null ? null : now + ttl,
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
        request.sessionPolicy !== undefined ||
        request.renews !== undefined
      )
        return false;
    } else {
      optionalLimit(request.sessionTtlMs, "Session lifetime");
      optionalLimit(request.idleTimeoutMs, "Idle timeout");
      if (
        request.sessionPolicy !== undefined &&
        (request.sessionPolicy !== "never" ||
          typeof request.sessionTtlMs === "number")
      )
        return false;
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
    // A version 2 grant may be Never (expiresAt null); every other grant
    // needs a finite expiry still in the future.
    const neverExpires =
      payload.version === CONSENT_VERSION && payload.expiresAt === null;
    if (
      payload.requestNonce !== request.nonce ||
      (!neverExpires &&
        (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= now))
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
        !withinLimit(payload.sessionTtlMs, limits.maxSessionTtlMs) ||
        (payload.sessionTtlMs === null
          ? payload.expiresAt !== null
          : payload.expiresAt !== payload.issuedAt + payload.sessionTtlMs) ||
        !withinLimit(payload.idleTimeoutMs, limits.maxIdleTimeoutMs) ||
        (payload.idleTimeoutMs !== null &&
          payload.sessionTtlMs !== null &&
          payload.idleTimeoutMs > payload.sessionTtlMs)
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
    if (payload.agentDescriptor !== undefined) {
      const agent = await verifyConsentAgent(consent, request, {
        expectedOrigin,
        expectedWallet,
        now,
      });
      if (!agent.ok) return false;
    }
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
 * Verify the agent descriptor attached to a consent, if any. Pure: it does not
 * consume the nonce guard. Returns `{ ok: true, participant: null }` when the
 * consent carries none. `participant.claims` are the agent's own claims, not
 * attestations; only `identity.id` is verified.
 */
export async function verifyConsentAgent(
  consent,
  request,
  { expectedOrigin, expectedWallet, now = Date.now() } = {},
) {
  const payload = consent?.body?.payload;
  const descriptor = payload?.agentDescriptor;
  if (descriptor === undefined) return { ok: true, participant: null };
  if (payload.version !== CONSENT_VERSION)
    return { ok: false, reason: "descriptor-not-allowed" };
  const verified = await verifyAgentDescriptor(descriptor, {
    expectedOrigin,
    expectedRoom: request?.room ?? "default",
    expectedNonce: request?.nonce,
    now,
  });
  if (!verified.ok) return verified;
  if (
    verified.walletId !== expectedWallet ||
    verified.walletId !== consent.body.issuer ||
    verified.sessionId !== request.nonce ||
    !descriptor.capabilities.every((c) => payload.capabilities.includes(c))
  )
    return { ok: false, reason: "descriptor-mismatch" };
  return {
    ok: true,
    participant: Object.freeze({
      identity: Object.freeze({ id: verified.walletId }),
      instanceId: verified.instanceId,
      sessionId: verified.sessionId,
      // Self-declared by the agent. Not attested; never use for authorization.
      claims: verified.claims,
      claimsAttested: false,
    }),
  };
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
    if (payload?.expiresAt !== null && !Number.isFinite(payload?.expiresAt))
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
    const ends = [
      this.expiresAt,
      this.idleTimeoutMs === null
        ? null
        : this.#lastActivityAt + this.idleTimeoutMs,
    ].filter((time) => time !== null);
    return ends.length === 0 ? null : Math.min(...ends);
  }

  status() {
    if (this.#revoked) return "revoked";
    const now = this.#clock();
    if (this.#payload.expiresAt !== null && this.#payload.expiresAt <= now)
      return "expired";
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
    if (
      !this.isActive() ||
      (payload?.expiresAt !== null && !Number.isFinite(payload?.expiresAt))
    )
      return false;
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
