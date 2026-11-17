// Wallet-side checks before it confirms a saved session can be resumed. The
// pure canResumeSession keeps every signature/origin/expiry/idle/version/
// descriptor check; canResumeStoredSession adds the wallet's durable grant
// record as the source of truth. No new scope is granted here.
import { CONSENT_VERSION, verifyConsentAgent } from "./connect.js";
import { verifyEnvelope } from "./index.js";

const MAX_STORED_CONSENT_AGE_MS = 7 * 24 * 60 * 60_000;
const ACTIVITY_SKEW_TOLERANCE_MS = 30_000;

function exactOrigin(value) {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

export async function canResumeSession(
  consent,
  {
    audience,
    sessionId,
    room,
    walletId,
    endedIds = new Set(),
    lastActivity,
    now = Date.now(),
  } = {},
) {
  const payload = consent?.body?.payload;
  if (!payload || typeof walletId !== "string" || !exactOrigin(audience))
    return false;
  if (
    payload.version !== CONSENT_VERSION ||
    payload.audience !== audience ||
    payload.requestNonce !== sessionId ||
    payload.room !== room ||
    endedIds.has(sessionId)
  )
    return false;
  // The signed descriptor is checked exactly as on a fresh connect, using the
  // saved session id as the nonce it was signed against.
  if (payload.agentDescriptor !== undefined) {
    const agent = await verifyConsentAgent(
      consent,
      { room, nonce: sessionId },
      { expectedOrigin: audience, expectedWallet: walletId, now },
    );
    if (!agent.ok) return false;
  }
  if (payload.expiresAt !== null && payload.expiresAt <= now) return false;
  // The site-supplied activity time is only a claim, bounded by the signed
  // expiry above and by these sanity limits; a wallet-side activity ledger is
  // not built yet, so the wallet cannot independently attest to it.
  if (lastActivity !== undefined && lastActivity !== null) {
    if (
      !Number.isFinite(lastActivity) ||
      lastActivity > now + ACTIVITY_SKEW_TOLERANCE_MS ||
      lastActivity < payload.issuedAt
    )
      return false;
  }
  if (
    payload.idleTimeoutMs !== null &&
    now - (lastActivity ?? payload.issuedAt) >= payload.idleTimeoutMs
  )
    return false;
  return verifyEnvelope(consent, {
    expectedIssuer: walletId,
    now,
    maxAgeMs: MAX_STORED_CONSENT_AGE_MS,
  });
}

function envelopeFingerprint(value) {
  if (Array.isArray(value))
    return `[${value.map(envelopeFingerprint).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${envelopeFingerprint(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * Confirm a resume against the wallet's durable grant record, never memory.
 * The site must present the exact envelope the wallet saved when it approved,
 * so a resume cannot widen a scope. Every existing canResumeSession check
 * (signature, origin, expiry, idle, version, descriptor, wallet binding) still
 * applies; this only adds the durable record as the source of the ended flag
 * and the wallet-owned activity time.
 */
export async function canResumeStoredSession(
  consent,
  { audience, sessionId, room, walletId, store, now = Date.now() } = {},
) {
  if (
    !store ||
    typeof store.get !== "function" ||
    typeof audience !== "string" ||
    typeof sessionId !== "string"
  )
    return false;
  const record = await store.get(audience, sessionId);
  if (!record || record.ended || !record.consent) return false;
  if (
    record.room !== room ||
    envelopeFingerprint(record.consent) !== envelopeFingerprint(consent)
  )
    return false;
  return canResumeSession(record.consent, {
    audience,
    sessionId,
    room,
    walletId,
    endedIds: new Set(),
    lastActivity: record.lastActivity,
    now,
  });
}
