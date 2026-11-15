import { randomNonce, signEnvelope, verifyEnvelope } from "./index.js";

const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u;
const MAX_NONCE_LENGTH = 512;
const MAX_NONCE_ENTRIES = 10_000;
const NONCE_CLEANUP_INTERVAL_MS = 1_000;

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
      expiresAt > now + 120_000 ||
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
  { expiresInMs = 60_000 } = {},
) {
  if (
    !Number.isInteger(expiresInMs) ||
    expiresInMs < 1_000 ||
    expiresInMs > 120_000
  ) {
    throw new RangeError(
      "Permission request lifetime must be between 1 and 120 seconds",
    );
  }
  return {
    type: "ai-auth/permission-request",
    version: 1,
    audience: validOrigin(origin),
    nonce: randomNonce(),
    createdAt: Date.now(),
    expiresAt: Date.now() + expiresInMs,
    capabilities: normalizeCapabilities(capabilities),
  };
}

export async function approvePermissionRequest(
  wallet,
  request,
  approvedCapabilities,
) {
  const approved = normalizeCapabilities(approvedCapabilities);
  const requestVerified = await verifyPermissionRequest(request, {
    expectedOrigin: request?.audience,
    now: Date.now(),
  });
  if (!requestVerified)
    throw new Error("Permission request is invalid or expired");
  const allowed = new Set(request.capabilities);
  if (approved.some((capability) => !allowed.has(capability))) {
    throw new Error(
      "Approval contains a capability the website did not request",
    );
  }
  return signEnvelope(wallet, "connect/consent", {
    audience: request.audience,
    requestNonce: request.nonce,
    capabilities: approved,
    expiresAt: request.expiresAt,
  });
}

export async function verifyPermissionRequest(
  request,
  { expectedOrigin, now = Date.now(), nonceGuard } = {},
) {
  try {
    if (request.type !== "ai-auth/permission-request" || request.version !== 1)
      return false;
    if (request.audience !== validOrigin(expectedOrigin)) return false;
    if (
      !Number.isFinite(request.expiresAt) ||
      request.expiresAt <= now ||
      request.expiresAt > now + 120_000
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
  { expectedOrigin, expectedWallet, now = Date.now(), nonceGuard } = {},
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
        maxAgeMs: 120_000,
      }))
    )
      return false;
    const payload = consent.body.payload;
    if (
      consent.body.type !== "connect/consent" ||
      payload.audience !== validOrigin(expectedOrigin) ||
      payload.audience !== request.audience
    )
      return false;
    if (
      payload.requestNonce !== request.nonce ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= now ||
      payload.expiresAt > request.expiresAt
    )
      return false;
    if (
      !Array.isArray(payload.capabilities) ||
      payload.capabilities.some(
        (capability) => !request.capabilities.includes(capability),
      )
    )
      return false;
    if (
      nonceGuard &&
      !nonceGuard.consume(payload.requestNonce, payload.expiresAt, now)
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
