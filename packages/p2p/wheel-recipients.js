// Recipient list and send gating for the collaboration wheel. Pure functions.
// Identity is ALWAYS the verified wallet id / key fingerprint, never a nickname.
import { identityFor } from "./index.js";

export const PRESENCE_STALE_MS = 24_000;
const MAX_KNOWN_PEERS = 16;

/** Short, display-only fingerprint of a wallet id, e.g. "Ab3x-9Zq_". */
export function fingerprintFromId(walletId) {
  const body = String(walletId).replace(/^agent:/u, "");
  return `${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

/** Derive id + fingerprint from a public key; null unless it matches `claimedId`. */
export async function verifyPeerKey(publicKey, claimedId) {
  try {
    const walletId = await identityFor(publicKey);
    if (claimedId !== undefined && walletId !== claimedId) return null;
    return { walletId, fingerprint: fingerprintFromId(walletId) };
  } catch {
    return null;
  }
}

const LIVE_STATUSES = new Set(["direct-peer-connected", "degraded"]);

/** Is the transport currently able to reach anyone directly? */
export function networkReachable(snapshot) {
  if (!snapshot) return true; // no state source: do not invent an outage
  return LIVE_STATUSES.has(snapshot.status) && snapshot.directPeerCount > 0;
}

/**
 * Merge verified peers with connection state. `known` is a Map of walletId →
 * {fingerprint, lastSeen}. Peers beyond the bound are dropped oldest-first.
 */
export function buildRecipients({ known, snapshot, selfId, now = Date.now() }) {
  const reachable = networkReachable(snapshot);
  const liveIds = new Set(
    (snapshot?.peers ?? []).map((peer) => peer.walletId).filter(Boolean),
  );
  const mustMatch = liveIds.size > 0;
  return [...known.entries()]
    .filter(([walletId]) => walletId !== selfId)
    .map(([walletId, peer]) => ({
      walletId,
      fingerprint: peer.fingerprint,
      verified: true,
      online:
        reachable &&
        now - peer.lastSeen <= PRESENCE_STALE_MS &&
        (!mustMatch || liveIds.has(walletId)),
    }))
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        a.fingerprint.localeCompare(b.fingerprint),
    );
}

/** Record a verified sighting without mutating the input map. */
export function rememberPeer(
  known,
  { walletId, fingerprint },
  now = Date.now(),
) {
  const next = new Map(known);
  next.delete(walletId);
  next.set(walletId, { fingerprint, lastSeen: now });
  while (next.size > MAX_KNOWN_PEERS) next.delete(next.keys().next().value);
  return next;
}

/**
 * Why sending is unavailable, or "" when it is allowed. `selection` is
 * "everyone" or a target wallet id. Never widens a targeted selection.
 */
export function explainSendBlock({
  selection,
  recipients,
  snapshot,
  expired,
  supportsTargets,
}) {
  if (expired)
    return "This session has expired. Reconnect to keep collaborating.";
  if (snapshot && ["expired", "disconnected", "idle"].includes(snapshot.status))
    return "Not connected. Controls return when a peer connects.";
  if (selection !== "everyone") {
    if (!supportsTargets)
      return "This connection cannot send to one recipient. Choose everyone or reconnect.";
    const peer = recipients.find((r) => r.walletId === selection);
    return peer?.online
      ? ""
      : "The selected recipient is offline. Choose another recipient to send.";
  }
  // Without a connection-state source the wheel cannot know peer count, so it
  // neither blocks nor claims anyone is connected.
  const anyone =
    !snapshot || recipients.some((r) => r.online) || networkReachable(snapshot);
  return anyone
    ? ""
    : "No peers are connected yet. Controls turn on when a peer joins.";
}
