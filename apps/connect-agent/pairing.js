// Thin pairing coordinator for the Connect-an-Agent surface. It does not
// implement cryptography: it reuses the signed-envelope and agent-descriptor
// primitives from packages/p2p and binds them to an expected wallet + instance.
import {
  NonceGuard,
  randomNonce,
  signEnvelope,
  verifyAgentDescriptor,
  verifyEnvelope,
} from "../../packages/p2p/index.js";
import {
  ACCESS_GRANT_REVOCATION_TYPE,
  grantKey,
  verifyAccessGrantRevocation,
  verifyPairingGrant,
} from "../../packages/agent/pairing.js";

const CHALLENGE_TYPE = "agent/pair-challenge";
const PROOF_TYPE = "agent/pair-proof";
const MAX_TTL_MS = 120_000;

function requiredString(value, name) {
  if (typeof value !== "string" || !value)
    throw new TypeError(`${name} is required`);
  return value;
}

/**
 * Create a verifier that accepts a signed proof only from the one agent
 * installation the caller expects. Every other peer/event is ignored.
 *
 * The single-use guard is armed when a challenge is issued; the nonce is
 * consumed when a valid proof is accepted, so the same proof can never verify
 * twice. The descriptor signature and wallet identity are checked by
 * verifyAgentDescriptor, never by comparing event labels.
 */
export function createPairingVerifier({
  siteWallet,
  siteRoom,
  origin,
  room,
  expected,
  now = Date.now,
  ttlMs = 60_000,
}) {
  if (!siteWallet?.privateKey || !siteWallet?.id)
    throw new TypeError("A site wallet with a signing key is required");
  if (
    !siteRoom ||
    typeof siteRoom.send !== "function" ||
    typeof siteRoom.subscribe !== "function"
  )
    throw new TypeError("A room with send() and subscribe() is required");
  requiredString(origin, "origin");
  requiredString(room, "room");
  if (
    !expected ||
    typeof expected.walletId !== "string" ||
    !expected.walletId ||
    typeof expected.instanceId !== "string" ||
    !expected.instanceId
  )
    throw new TypeError("expected = { walletId, instanceId } is required");
  if (typeof now !== "function") now = Date.now;
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS)
    throw new RangeError("ttlMs must be between 1 and 120 seconds");

  const guard = new NonceGuard();
  const callbacks = new Set();
  const revokedCallbacks = new Set();
  const seenRevocations = new Set();
  // Revocations may arrive before the proof they target. Remembering their
  // grant key closes the race where a last-moment revocation would otherwise be
  // followed by an accepted proof and a false green state.
  const revokedGrantKeys = new Set();
  let active = null;
  let accepted = null;
  let closed = false;

  const notify = (proof) => {
    for (const callback of [...callbacks]) {
      try {
        callback(proof);
      } catch (error) {
        console.error("Pairing verification callback failed", error);
      }
    }
  };

  const notifyRevoked = (revocation) => {
    for (const callback of [...revokedCallbacks]) {
      try {
        callback(revocation);
      } catch (error) {
        console.error("Pairing revocation callback failed", error);
      }
    }
  };

  // Apply a verified, owner-signed revocation to the accepted grant. Idempotent
  // by both the revocation id (replay) and the grant key (already revoked), so
  // duplicates can never flip state twice or resurrect an authorization.
  const applyRevocation = async (raw) => {
    if (closed) return false;
    const envelope = raw?.envelope ?? raw;
    if (typeof envelope?.body?.type !== "string") return false;
    if (envelope.body.type !== ACCESS_GRANT_REVOCATION_TYPE) return false;
    const result = await verifyAccessGrantRevocation(envelope, {
      expectedIssuer: siteWallet.id,
      now,
    });
    if (!result || seenRevocations.has(result.id)) return false;
    seenRevocations.add(result.id);
    if (revokedGrantKeys.has(result.grantKey)) return false;
    revokedGrantKeys.add(result.grantKey);
    if (!accepted || accepted.revoked || accepted.grantKey !== result.grantKey)
      return false;
    accepted = Object.freeze({
      ...accepted,
      authorization: null,
      revoked: true,
    });
    notifyRevoked(
      Object.freeze({
        grantKey: accepted.grantKey,
        revokedAt: now(),
        reason: result.reason,
        id: result.id,
      }),
    );
    return true;
  };

  const unsubscribe = siteRoom.subscribe(async (event) => {
    try {
      if (closed || !event || event.direction !== "in") return;
      const envelope = event.envelope;
      if (!envelope || typeof envelope.body?.type !== "string") return;

      if (envelope.body.type === ACCESS_GRANT_REVOCATION_TYPE) {
        // The room authenticates the outer wire envelope; the inner owner
        // signature and issuer binding are checked by applyRevocation.
        await applyRevocation(envelope);
        return;
      }
      if (!active || envelope.body.type !== PROOF_TYPE) return;

      // The authenticated peer is the envelope issuer. A room verifies that
      // issuer against the signing key before delivering inbound events.
      const issuer = envelope.body.issuer;
      if (issuer !== expected.walletId) return;
      if (event.peer && event.peer.id !== expected.walletId) return;

      const at = now();
      if (at >= active.expiresAt) return;
      if (
        !(await verifyEnvelope(envelope, {
          expectedIssuer: expected.walletId,
          maxAgeMs: MAX_TTL_MS,
        }))
      )
        return;

      const descriptor = envelope.body.payload?.descriptor;
      if (!descriptor) return;
      const verified = await verifyAgentDescriptor(descriptor, {
        expectedOrigin: origin,
        expectedRoom: room,
        expectedNonce: active.nonce,
        now: at,
      });
      if (!verified.ok) return;
      if (verified.walletId !== expected.walletId) return;
      if (verified.instanceId !== expected.instanceId) return;

      // Authorization is a separate fact from identity. A grant is accepted
      // only when it is the exact one issued in the challenge, signed by this
      // site's wallet, and valid for this origin, room, expected agent and
      // every effective scope. Otherwise identity may still verify, but no
      // scope is ever presented as approved.
      let authorization = null;
      const raw = envelope.body.payload?.authorization;
      if (raw) {
        // Authorization is verified independently of how it reached the proof.
        // It is a signed, public grant: trust comes from the owner's signature
        // and its bindings to THIS challenge (origin, room, expected agent,
        // session, nonce and expiry), not from having seen it in the challenge
        // payload. A forged, replayed or mismatched grant fails closed.
        authorization = await verifyPairingGrant(raw, {
          expectedIssuer: siteWallet.id,
          audience: origin,
          room,
          walletId: expected.walletId,
          instanceId: expected.instanceId,
          sessionId: active.sessionId,
          nonce: active.nonce,
          expiresAt: active.expiresAt,
          now: at,
        });
        if (!authorization) return;
        // A grant attached to the challenge is the exact one the owner approved
        // for THIS challenge. Read the live challenge state here, at proof time:
        // a different (even validly signed) grant must never be substituted for
        // the one that travelled with the challenge.
        if (active?.authorization) {
          const expectedKey = grantKey(active.authorization);
          if (!expectedKey || grantKey(authorization) !== expectedKey) return;
        }
      }

      // Single use: a replayed proof cannot consume the nonce a second time.
      if (!guard.consume(active.nonce, active.expiresAt, at)) return;
      const acceptedKey = authorization ? grantKey(authorization) : null;
      // A revocation may land before the proof it targets. The signed proof
      // still verifies identity, but it must NOT carry the authorization claim:
      // emitting it would let a consumer go green for one tick until the
      // revocation callback clears access.
      const revokedBeforeProof = Boolean(
        acceptedKey && revokedGrantKeys.has(acceptedKey),
      );
      const proof = Object.freeze({
        walletId: verified.walletId,
        instanceId: verified.instanceId,
        sessionId: verified.sessionId,
        claims: Object.freeze({
          ...verified.claims,
          selfReported: true,
          ...(authorization && !revokedBeforeProof ? { authorization } : {}),
        }),
        verifiedAt: at,
      });
      // Retain the accepted grant so a later owner-signed revocation can be
      // matched against it. Clearing active keeps the challenge single-use.
      accepted = authorization
        ? Object.freeze({
            grantKey: acceptedKey,
            authorization: revokedBeforeProof ? null : authorization,
            proof,
            revoked: revokedBeforeProof,
          })
        : Object.freeze({
            grantKey: null,
            authorization: null,
            proof,
            revoked: false,
          });
      active = null;
      notify(proof);
      if (revokedBeforeProof)
        notifyRevoked(
          Object.freeze({
            grantKey: acceptedKey,
            revokedAt: at,
            reason: "revoked-before-proof",
            id: `early:${acceptedKey}`,
          }),
        );
    } catch (error) {
      console.error("Pairing proof verification failed", error);
    }
  });

  return Object.freeze({
    async start({ authorization } = {}) {
      if (closed) throw new Error("This pairing verifier is closed");
      const nonce = randomNonce();
      const challengeId = randomNonce();
      const sessionId = randomNonce();
      const expiresAt = now() + ttlMs;
      // A new pairing supersedes any previously accepted grant: start with a
      // clean revocation slate so an old revocation cannot affect this challenge.
      accepted = null;
      seenRevocations.clear();
      revokedGrantKeys.clear();
      const challenge = await signEnvelope(siteWallet, CHALLENGE_TYPE, {
        challengeId,
        nonce,
        origin,
        room,
        walletId: expected.walletId,
        instanceId: expected.instanceId,
        sessionId,
        capabilities: [],
        expiresAt,
      });
      // Arm the single-use challenge before publishing: a fast agent may answer
      // before send() resolves, and that proof must not be discarded. The
      // optional owner-signed grant travels in the challenge and is echoed in
      // the proof; without it, only identity can be verified.
      const challengePayload = {
        challenge,
        ...(authorization ? { authorization } : {}),
      };
      active = Object.freeze({
        nonce,
        challengeId,
        sessionId,
        expiresAt,
        authorization: authorization ?? null,
      });
      // Publish through the room; nesting the signed challenge keeps the
      // pairing nonce distinct from the room envelope's own wire nonce.
      try {
        await siteRoom.send(CHALLENGE_TYPE, challengePayload);
        // A harness may attach the owner-signed grant to the outgoing
        // challenge payload (e.g. after the owner approves in the wallet).
        // Capture it so the matching proof can be checked against that exact
        // grant. Never trust a grant that first appears in the proof.
        const attached =
          challengePayload.authorization ?? challengePayload.grant;
        if (attached && active?.nonce === nonce) {
          active = Object.freeze({ ...active, authorization: attached });
        }
      } catch (error) {
        if (active?.nonce === nonce) active = null;
        throw error;
      }
      return { nonce, challengeId, expiresAt, challenge };
    },
    onVerified(callback) {
      if (typeof callback !== "function")
        throw new TypeError("onVerified expects a callback");
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    /** Observe an owner-signed revocation of the currently accepted grant. */
    onRevoked(callback) {
      if (typeof callback !== "function")
        throw new TypeError("onRevoked expects a callback");
      revokedCallbacks.add(callback);
      return () => revokedCallbacks.delete(callback);
    },
    /** Apply an owner-signed revocation envelope directly (room-free seam). */
    revoke(raw) {
      return applyRevocation(raw);
    },
    /** True once a valid owner revocation invalidated the accepted grant. */
    get revoked() {
      return Boolean(accepted?.revoked);
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      active = null;
      accepted = null;
      callbacks.clear();
      revokedCallbacks.clear();
      seenRevocations.clear();
      revokedGrantKeys.clear();
    },
  });
}
