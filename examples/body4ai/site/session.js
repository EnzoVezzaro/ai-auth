// Consent and session lifetime for the in-page wallet. All cryptography and
// every acceptance rule comes from the SDK: the site only asks the wallet
// owner, verifies the signed consent and follows the SessionLease.
import {
  NonceGuard,
  SessionLease,
  approvePermissionRequest,
  createPermissionRequest,
  verifyPermissionConsent,
} from "../../../packages/p2p/browser.js";
import { askConsent } from "./consent-dialog.js";
import {
  EXTEND_LABEL,
  PlainError,
  approvalFailureMessage,
} from "./messages.js";

const HANDSHAKE_MS = 120_000;

export async function negotiateSession({
  wallet,
  origin,
  room,
  requested,
  sessionTtlMs,
}) {
  const request = await createPermissionRequest(origin, requested, {
    room,
    expiresInMs: HANDSHAKE_MS,
    ...(sessionTtlMs ? { sessionTtlMs } : {}),
  });
  const outcome = await askConsent({
    title: "Connect to BODY4AI",
    capabilities: request.capabilities,
    expiresInMs: HANDSHAKE_MS,
  });
  if (!outcome.approved)
    throw new PlainError(approvalFailureMessage(outcome.reason));
  const consent = await approvePermissionRequest(
    wallet,
    request,
    outcome.approved,
  );
  const guard = new NonceGuard();
  const valid = await verifyPermissionConsent(consent, request, {
    expectedOrigin: origin,
    expectedWallet: wallet.id,
    nonceGuard: guard,
  });
  if (!valid)
    throw new PlainError(
      "We could not verify your approval. Click Connect agent to try again.",
    );
  return {
    request,
    consent,
    guard,
    lease: new SessionLease(consent.body.payload),
  };
}

export async function renewSession(session, { wallet, origin, room }) {
  const endsAt = session.consent.body.payload.expiresAt;
  const request = await createPermissionRequest(
    origin,
    session.consent.body.payload.capabilities,
    {
      room,
      expiresInMs: HANDSHAKE_MS,
      renews: session.consent.body.payload.requestNonce,
    },
  );
  const outcome = await askConsent({
    title: EXTEND_LABEL,
    capabilities: request.capabilities,
    expiresInMs: HANDSHAKE_MS,
  });
  if (!outcome.approved)
    throw new PlainError(
      approvalFailureMessage(outcome.reason, { renewal: true, endsAt }),
    );
  const consent = await approvePermissionRequest(
    wallet,
    request,
    outcome.approved,
    {
      previousConsent: session.consent,
    },
  );
  const valid = await verifyPermissionConsent(consent, request, {
    expectedOrigin: origin,
    expectedWallet: wallet.id,
    nonceGuard: session.guard,
    previousConsent: session.consent,
  });
  if (!valid || !session.lease.renew(consent.body.payload))
    throw new PlainError("We could not extend the session. Try again.");
  return { ...session, request, consent };
}
