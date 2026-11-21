// Agent-side pairing responder. It only answers a verifier-issued, signed and
// unexpired challenge that matches this exact wallet, instance, origin and
// room. The private key stays in this process: createAgentDescriptor signs the
// proof locally and only the public descriptor is sent to the room.
//
// Authorization is a separate fact from identity. A site owner signs a narrow
// grant (audience, room, scopes, expiry, nonce/session and expected wallet),
// reusing signEnvelope/verifyEnvelope from packages/p2p. The responder verifies
// that grant before forwarding it; an absent grant still yields an identity
// proof, but never an authorization claim, so the UI cannot show "Connected".
import {
  createAgentDescriptor,
  randomNonce,
  signEnvelope,
  verifyEnvelope,
} from "../p2p/index.js";

const CHALLENGE_TYPE = "agent/pair-challenge";
const PROOF_TYPE = "agent/pair-proof";

export const ACCESS_GRANT_TYPE = "agent/access-grant";
export const ACCESS_GRANT_REVOCATION_TYPE = "agent/access-grant-revocation";
export const MAX_PAIRING_GRANT_TTL_MS = 10 * 60_000;
export const MAX_REVOCATION_TTL_MS = MAX_PAIRING_GRANT_TTL_MS;
const SCOPE_PATTERN = /^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u;
const REVOCATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

function requiredString(value, name) {
  if (typeof value !== "string" || !value)
    throw new TypeError(`${name} is required`);
  return value;
}

function scopesFrom(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.includes("*") ||
    new Set(value).size !== value.length ||
    value.some(
      (scope) => typeof scope !== "string" || !SCOPE_PATTERN.test(scope),
    )
  )
    return null;
  return [...value].sort();
}

/**
 * Owner-issued authorization bound to one pairing challenge. This is a thin
 * signEnvelope wrapper: no new cryptographic primitive and no new wire format.
 * The owner's private key is used locally and is never put in the payload.
 */
export async function createPairingGrant(
  ownerWallet,
  {
    audience,
    room,
    walletId,
    instanceId,
    sessionId,
    nonce,
    scopes,
    expiresAt,
    now = Date.now,
  },
) {
  const effectiveScopes = scopesFrom(scopes);
  if (!effectiveScopes)
    throw new TypeError("A non-empty list of explicit scopes is required");
  const at = typeof now === "function" ? now() : now;
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= at ||
    expiresAt - at > MAX_PAIRING_GRANT_TTL_MS
  )
    throw new RangeError("Grant expiry must be bounded to the pairing window");
  const payload = {
    audience: requiredString(audience, "audience"),
    room: requiredString(room, "room"),
    walletId: requiredString(walletId, "walletId"),
    instanceId: requiredString(instanceId, "instanceId"),
    sessionId: requiredString(sessionId, "sessionId"),
    nonce: requiredString(nonce, "nonce"),
    scopes: effectiveScopes,
    expiresAt,
  };
  return signEnvelope(ownerWallet, ACCESS_GRANT_TYPE, payload);
}

/** Flat authorization claim: app.js reads audience/scopes/expiresAt directly. */
export function claimFromGrant(envelope) {
  const payload = envelope?.body?.payload;
  if (!payload) return null;
  const scopes = scopesFrom(payload.scopes);
  if (!scopes) return null;
  return {
    audience: payload.audience,
    room: payload.room,
    walletId: payload.walletId,
    instanceId: payload.instanceId,
    sessionId: payload.sessionId,
    nonce: payload.nonce,
    scopes,
    expiresAt: payload.expiresAt,
    // The signed envelope travels with the claim so the verifier can check the
    // owner's signature instead of trusting self-reported authorization.
    envelope: { body: envelope.body, proof: envelope.proof },
  };
}

/**
 * Verify an owner grant cryptographically and against the challenge it binds
 * to. Returns null on every mismatch (audience, room, wallet, instance,
 * session, nonce, empty scopes, expiry, bad signature or wrong issuer).
 *
 * `now` governs the grant payload's expiry; the envelope's own createdAt
 * freshness is checked by verifyEnvelope against the wall clock, as in the
 * pairing verifier.
 */
export async function verifyPairingGrant(
  raw,
  {
    expectedIssuer,
    audience,
    room,
    walletId,
    instanceId,
    sessionId,
    nonce,
    expiresAt,
    now = Date.now,
  } = {},
) {
  const envelope = raw?.envelope ?? raw;
  if (!envelope?.body || !envelope?.proof) return null;
  if (envelope.body.type !== ACCESS_GRANT_TYPE) return null;
  if (typeof expectedIssuer !== "string" || !expectedIssuer) return null;
  if (!(await verifyEnvelope(envelope, { expectedIssuer }))) return null;

  const payload = envelope.body.payload ?? {};
  const at = typeof now === "function" ? now() : now;
  const scopes = scopesFrom(payload.scopes);
  if (!scopes) return null;
  if (
    payload.audience !== audience ||
    payload.room !== room ||
    payload.walletId !== walletId ||
    payload.instanceId !== instanceId ||
    payload.sessionId !== sessionId ||
    payload.nonce !== nonce
  )
    return null;
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= at)
    return null;
  if (Number.isFinite(expiresAt) && payload.expiresAt > expiresAt) return null;
  return claimFromGrant(envelope);
}

// A grant is identified by the exact binding that the owner signed and the
// verifier accepted. sessionId + nonce are single-use per challenge, and the
// remaining fields pin it to one site, room and agent instance. This is a
// stable, public identifier: nothing secret is needed to compute it.
const GRANT_KEY_FIELDS = [
  "audience",
  "room",
  "walletId",
  "instanceId",
  "sessionId",
  "nonce",
];

export function grantKey(value) {
  const source =
    value?.body?.payload ?? value?.envelope?.body?.payload ?? value;
  if (
    !source ||
    GRANT_KEY_FIELDS.some(
      (field) => typeof source[field] !== "string" || !source[field],
    )
  )
    return null;
  return GRANT_KEY_FIELDS.map((field) => `${field}:${source[field]}`).join("|");
}

/**
 * Owner-signed revocation of an accepted `agent/access-grant`. It reuses
 * signEnvelope/verifyEnvelope (same domain, key and freshness rules as the
 * grant) and names the grant by its signed binding, so a revocation for a
 * different site, room, agent, session or nonce cannot revoke this one.
 */
export async function createAccessGrantRevocation(
  ownerWallet,
  {
    grant,
    audience,
    room,
    walletId,
    instanceId,
    sessionId,
    nonce,
    expiresAt,
    reason = "revoked",
    now = Date.now,
  } = {},
) {
  if (!ownerWallet?.privateKey || !ownerWallet?.id)
    throw new TypeError("An owner wallet with a signing key is required");
  const source =
    grant?.body?.payload ?? grant?.envelope?.body?.payload ?? grant ?? {};
  const fields = {
    audience: audience ?? source.audience,
    room: room ?? source.room,
    walletId: walletId ?? source.walletId,
    instanceId: instanceId ?? source.instanceId,
    sessionId: sessionId ?? source.sessionId,
    nonce: nonce ?? source.nonce,
  };
  if (
    GRANT_KEY_FIELDS.some(
      (field) => typeof fields[field] !== "string" || !fields[field],
    )
  )
    throw new TypeError(
      "A grant binding (audience, room, walletId, instanceId, sessionId, nonce) is required",
    );
  if (!grantKey(fields)) throw new TypeError("Invalid grant binding");
  const at = typeof now === "function" ? now() : now;
  if (!Number.isFinite(at)) throw new TypeError("Invalid timestamp");
  const validUntil = expiresAt ?? at + MAX_REVOCATION_TTL_MS;
  if (
    !Number.isFinite(validUntil) ||
    validUntil <= at ||
    validUntil - at > MAX_REVOCATION_TTL_MS
  )
    throw new RangeError(
      "Revocation expiry must be bounded to the revocation window",
    );
  const payload = {
    id: randomNonce(),
    ...fields,
    expiresAt: validUntil,
    reason: typeof reason === "string" ? reason.slice(0, 120) : "revoked",
  };
  return signEnvelope(ownerWallet, ACCESS_GRANT_REVOCATION_TYPE, payload);
}

/**
 * Verify a signed grant revocation. Fails closed on a bad/forged signature, a
 * different owner, wrong envelope type/shape, an expired message or a missing
 * grant binding. Envelope freshness is checked by verifyEnvelope against the
 * wall clock, which bounds replay; payload expiry is checked against `now`.
 */
export async function verifyAccessGrantRevocation(
  raw,
  { expectedIssuer, now = Date.now, maxAgeMs } = {},
) {
  const envelope = raw?.envelope ?? raw;
  if (!envelope?.body || !envelope?.proof) return null;
  if (envelope.body.type !== ACCESS_GRANT_REVOCATION_TYPE) return null;
  if (typeof expectedIssuer !== "string" || !expectedIssuer) return null;
  const verifyOptions = { expectedIssuer };
  if (Number.isFinite(maxAgeMs)) verifyOptions.maxAgeMs = maxAgeMs;
  if (!(await verifyEnvelope(envelope, verifyOptions))) return null;
  const payload = envelope.body.payload ?? {};
  if (typeof payload.id !== "string" || !REVOCATION_ID_PATTERN.test(payload.id))
    return null;
  const key = grantKey(payload);
  if (!key) return null;
  if (typeof payload.reason !== "string") return null;
  const at = typeof now === "function" ? now() : now;
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= at)
    return null;
  return Object.freeze({
    id: payload.id,
    grantKey: key,
    audience: payload.audience,
    room: payload.room,
    walletId: payload.walletId,
    instanceId: payload.instanceId,
    sessionId: payload.sessionId,
    nonce: payload.nonce,
    expiresAt: payload.expiresAt,
    reason: payload.reason,
  });
}

/**
 * Listen for a matching pairing challenge and answer it with a freshly signed
 * agent descriptor. `provider` and `model` are self-reported claims; they are
 * never an attestation of the model, vendor or physical device.
 *
 * If the challenge carries an owner-signed grant (or the caller supplies one
 * via `grant`), it is verified and forwarded as `authorization` in the proof.
 * A missing grant yields an identity-only proof; an invalid one is refused.
 */
export function createPairingResponder({
  wallet,
  instanceId,
  origin,
  room,
  siteRoom,
  provider = "self-reported",
  model = "self-reported",
  agentType = "coding-agent",
  capabilities = [],
  grant = null,
  now = Date.now,
}) {
  if (!wallet?.privateKey || !wallet?.id)
    throw new TypeError("A wallet with a signing key is required");
  requiredString(instanceId, "instanceId");
  requiredString(origin, "origin");
  requiredString(room, "room");
  if (
    !siteRoom ||
    typeof siteRoom.send !== "function" ||
    typeof siteRoom.subscribe !== "function"
  )
    throw new TypeError("A room with send() and subscribe() is required");
  if (typeof now !== "function") now = Date.now;

  let closed = false;
  const unsubscribe = siteRoom.subscribe(async (event) => {
    try {
      if (closed || !event || event.direction !== "in") return;
      const outer = event.envelope;
      if (!outer || outer.body?.type !== CHALLENGE_TYPE) return;
      const challenge = outer.body.payload?.challenge;
      if (!challenge || challenge.body?.type !== CHALLENGE_TYPE) return;

      // The challenge is signed by the verifier's site wallet. The room has
      // already authenticated the outer envelope; verify the nested challenge
      // as well so a copied/replayed label cannot trigger a signature.
      if (!(await verifyEnvelope(challenge, {}))) return;
      const c = challenge.body.payload;
      if (c.origin !== origin || c.room !== room) return;
      if (c.walletId !== wallet.id || c.instanceId !== instanceId) return;

      const at = now();
      if (!Number.isFinite(c.expiresAt) || at >= c.expiresAt) return;
      const nonce = c.nonce;
      if (typeof nonce !== "string" || nonce.length < 16) return;
      if (typeof c.sessionId !== "string" || c.sessionId.length < 8) return;

      // The owner's grant may arrive in the challenge payload (preferred) or
      // be supplied by the caller. The owner's private key is never sent.
      const offered =
        outer.body.payload?.grant ?? c.grant ?? c.authorization ?? grant;
      const rawGrant =
        typeof offered === "function" ? await offered(c) : offered;
      let authorization = null;
      if (rawGrant) {
        authorization = await verifyPairingGrant(rawGrant, {
          expectedIssuer: challenge.body.issuer,
          audience: c.origin,
          room: c.room,
          walletId: wallet.id,
          instanceId,
          sessionId: c.sessionId,
          nonce,
          expiresAt: c.expiresAt,
          now: at,
        });
        if (!authorization) {
          console.error("Pairing grant verification failed; no proof sent");
          return;
        }
      }

      const descriptor = await createAgentDescriptor(wallet, {
        instanceId,
        agentType,
        origin,
        room,
        nonce,
        sessionId: c.sessionId,
        capabilities: Array.isArray(c.capabilities)
          ? c.capabilities
          : capabilities,
        provider,
        model,
        runtime: { name: "agent", version: "1" },
        expiresAt: c.expiresAt,
        now: at,
      });
      if (closed) return;
      const proofPayload = { descriptor };
      if (authorization) proofPayload.authorization = authorization;
      await siteRoom.send(PROOF_TYPE, proofPayload);
    } catch (error) {
      console.error("Pairing challenge handling failed", error);
    }
  });

  return Object.freeze({
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
    },
  });
}
