// The BODY4AI "site operator" for the E2E. A static demo site has no backend,
// so the operator is a key holder: it admits members, issues execution grants,
// revokes, and verifies site links. It uses only the SDK's public functions
// and never touches a browser page except through harness calls.
import {
  createLinkChallenge,
  createLinkNonceStore,
  createRevocation,
  createRevokedLinkSet,
  identityFor,
  issueExecutionGrant,
  issueMembership,
  verifyLink,
  verifyLinkRevocation,
} from "../../packages/p2p/index.js";

export async function createSiteAuthority({ origin, room }) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const issuer = { publicKey, privateKey: pair.privateKey };
  const issuerId = await identityFor(publicKey);
  const nonceStore = createLinkNonceStore();
  const revokedLinks = createRevokedLinkSet();
  const links = new Map();
  const memberships = new Map();

  return {
    origin,
    room,
    issuerJwk: publicKey,
    issuerId,
    memberships,
    async admit(subject, scopes, { role = "member" } = {}) {
      const proof = await issueMembership(issuer, {
        subject,
        origin,
        room,
        role,
        scopes,
        duration: { kind: "configured", ttlMs: 20 * 60_000 },
      });
      memberships.set(subject, proof);
      return proof;
    },
    async forgeMembership(subject, scopes) {
      // A rogue issuer the site never trusted.
      const rogue = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      return issueMembership(
        {
          publicKey: await crypto.subtle.exportKey("jwk", rogue.publicKey),
          privateKey: rogue.privateKey,
        },
        { subject, origin, room, scopes, ttlMs: 10 * 60_000 },
      );
    },
    executionGrant(subject, scopes = ["tools.invoke"], ttlMs = 10 * 60_000) {
      const membership = memberships.get(subject);
      return issueExecutionGrant(issuer, {
        subject,
        origin,
        room,
        membershipId: membership.id,
        scopes,
        ttlMs,
      });
    },
    revokeWallet: (walletId) =>
      createRevocation(issuer, {
        kind: "wallet",
        target: walletId,
        origin,
        room,
      }),
    revokeMembership: (walletId) =>
      createRevocation(issuer, {
        kind: "membership",
        target: memberships.get(walletId).id,
        origin,
        room,
      }),
    linkChallenge(resource, capabilities) {
      return createLinkChallenge({
        origin,
        resource,
        capabilities,
        nonceStore,
      });
    },
    async acceptLink(proof, resource, capabilities) {
      const result = await verifyLink(proof, {
        expectedOrigin: origin,
        expectedResource: resource,
        expectedCapabilities: capabilities,
        nonceStore,
        revokedLinks,
      });
      if (result.valid) links.set(result.link.linkId, result.link);
      return result;
    },
    /** A link-authorized site operation: only approved scopes, never after unlink. */
    useLink(linkId, scope) {
      const link = links.get(linkId);
      if (!link) return { allow: false, reason: "unknown-link" };
      if (revokedLinks.has(linkId)) return { allow: false, reason: "revoked" };
      if (link.expiresAt <= Date.now())
        return { allow: false, reason: "expired" };
      if (!link.capabilities.includes(scope))
        return { allow: false, reason: "scope-not-approved" };
      return { allow: true, reason: "ok" };
    },
    async applyUnlink(event) {
      const verified = await verifyLinkRevocation(event, {
        expectedOrigin: origin,
      });
      if (!verified.valid) return verified;
      return revokedLinks.add(event, { expectedOrigin: origin });
    },
    verifyAgain: (proof, resource, capabilities) =>
      verifyLink(proof, {
        expectedOrigin: origin,
        expectedResource: resource,
        expectedCapabilities: capabilities,
        nonceStore: createLinkNonceStore(),
        revokedLinks,
      }),
  };
}
