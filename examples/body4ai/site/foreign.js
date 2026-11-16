// Verifies artifacts issued for another origin against THIS origin. The SDK
// verifiers must reject all of them; the E2E asserts each result.
import {
  NonceGuard,
  createLinkNonceStore,
  verifyLink,
  verifyMembership,
  verifyPermissionConsent,
} from "../../../packages/p2p/browser.js";

export async function foreignChecks(
  { consent, request, link, membership, issuer },
  state,
) {
  const origin = location.origin;
  const room = state.config.room;
  const consentAccepted = await verifyPermissionConsent(consent, request, {
    expectedOrigin: origin,
    expectedWallet: consent.body.issuer,
    nonceGuard: new NonceGuard(),
  });
  const linkResult = await verifyLink(link, {
    expectedOrigin: origin,
    expectedResource: link.body.payload.resource,
    expectedCapabilities: link.body.payload.capabilities,
    nonceStore: createLinkNonceStore(),
  });
  const membershipResult = await verifyMembership(membership, {
    trustPolicy: { issuers: [issuer] },
    expectedOrigin: origin,
    expectedRoom: room,
    expectedSubject: membership.subject,
  });
  return {
    origin,
    consentAccepted,
    linkValid: linkResult.valid,
    linkReason: linkResult.reason ?? null,
    membershipOk: membershipResult.ok,
    membershipReason: membershipResult.reason ?? null,
  };
}
