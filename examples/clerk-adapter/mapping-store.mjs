// In-memory, site-owned mapping from an AI Auth link to a Clerk account.
// Holds no tokens. A production site would back this with its own database.

function copyMapping(mapping) {
  return { ...mapping, scopes: [...mapping.scopes] };
}

export function createMappingStore() {
  const byLinkId = new Map();
  const revoked = new Set();

  return Object.freeze({
    // Returns false if the linkId already has a mapping (never overwrites).
    add(mapping) {
      if (byLinkId.has(mapping.linkId)) return false;
      byLinkId.set(mapping.linkId, copyMapping(mapping));
      return true;
    },
    get(linkId) {
      const mapping = byLinkId.get(linkId);
      return mapping ? copyMapping(mapping) : undefined;
    },
    // Marks the link revoked (so it cannot be re-linked) and deletes its mapping.
    revoke(linkId) {
      revoked.add(linkId);
      return byLinkId.delete(linkId);
    },
    // Shape expected by verifyLink's `revokedLinks` option.
    revokedLinks: Object.freeze({ has: (linkId) => revoked.has(linkId) }),
  });
}
