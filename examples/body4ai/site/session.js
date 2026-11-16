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
  const approved = await askConsent({
    title: "Connect to BODY4AI",
    origin,
    capabilities: request.capabilities,
    expiresInMs: HANDSHAKE_MS,
  });
  if (!approved?.length) throw new Error("The wallet declined this request");
  const consent = await approvePermissionRequest(wallet, request, approved);
  const guard = new NonceGuard();
  const valid = await verifyPermissionConsent(consent, request, {
    expectedOrigin: origin,
    expectedWallet: wallet.id,
    nonceGuard: guard,
  });
  if (!valid) throw new Error("The wallet consent could not be verified");
  return {
    request,
    consent,
    guard,
    lease: new SessionLease(consent.body.payload),
  };
}

export async function renewSession(session, { wallet, origin, room }) {
  const request = await createPermissionRequest(
    origin,
    session.consent.body.payload.capabilities,
    {
      room,
      expiresInMs: HANDSHAKE_MS,
      renews: session.consent.body.payload.requestNonce,
    },
  );
  const approved = await askConsent({
    title: "Renew BODY4AI session",
    origin,
    capabilities: request.capabilities,
    expiresInMs: HANDSHAKE_MS,
  });
  if (!approved?.length) throw new Error("The wallet declined to renew");
  const consent = await approvePermissionRequest(wallet, request, approved, {
    previousConsent: session.consent,
  });
  const valid = await verifyPermissionConsent(consent, request, {
    expectedOrigin: origin,
    expectedWallet: wallet.id,
    nonceGuard: session.guard,
    previousConsent: session.consent,
  });
  if (!valid || !session.lease.renew(consent.body.payload))
    throw new Error("The wallet renewal could not be verified");
  return { ...session, request, consent };
}
