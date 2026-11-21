// Typed connection lifecycle for the P2P transport.
// Illegal transitions THROW from `transition()`; `tryTransition()` returns
// false and leaves state untouched (used by transports that must never throw).

export const CONNECTION_STATUSES = Object.freeze([
  "idle",
  "approval-pending",
  "wallet-authorized",
  "connecting",
  "signaling",
  "waiting-for-peers",
  "direct-peer-connected",
  "reconnecting",
  "degraded",
  "expired",
  "revoked",
  "disconnected",
]);

const table = {
  idle: [
    "approval-pending",
    "wallet-authorized",
    "connecting",
    "signaling",
    "disconnected",
  ],
  "approval-pending": ["wallet-authorized", "expired", "disconnected"],
  "wallet-authorized": ["connecting", "signaling", "expired", "disconnected"],
  connecting: [
    "signaling",
    "waiting-for-peers",
    "direct-peer-connected",
    "reconnecting",
    "degraded",
    "expired",
    "disconnected",
  ],
  signaling: [
    "waiting-for-peers",
    "direct-peer-connected",
    "reconnecting",
    "degraded",
    "expired",
    "disconnected",
  ],
  "waiting-for-peers": [
    "signaling",
    "direct-peer-connected",
    "reconnecting",
    "degraded",
    "expired",
    "disconnected",
  ],
  "direct-peer-connected": [
    "waiting-for-peers",
    "reconnecting",
    "degraded",
    "expired",
    "revoked",
    "disconnected",
  ],
  reconnecting: [
    "connecting",
    "signaling",
    "waiting-for-peers",
    "direct-peer-connected",
    "degraded",
    "expired",
    "revoked",
    "disconnected",
  ],
  degraded: [
    "signaling",
    "waiting-for-peers",
    "direct-peer-connected",
    "reconnecting",
    "expired",
    "revoked",
    "disconnected",
  ],
  expired: ["idle", "disconnected"],
  revoked: ["idle", "disconnected"],
  disconnected: [
    "idle",
    "approval-pending",
    "wallet-authorized",
    "connecting",
    "signaling",
  ],
};

export const CONNECTION_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(table).map(([from, to]) => [from, Object.freeze([...to])]),
  ),
);

// Ended sessions are final: a lost transport must not revive them. Recovery
// needs an explicit reauthorization and reconnect (via idle), never invalidate.
const TERMINAL_STATUSES = new Set(["expired", "revoked", "disconnected"]);

export function canTransition(from, to) {
  return CONNECTION_TRANSITIONS[from]?.includes(to) === true;
}

function freezeSnapshot(state) {
  return Object.freeze({
    status: state.status,
    // Legacy transport connectivity: a live data channel. Kept lenient for
    // mirrors that only track peer ids. It never comes from a saved identity,
    // grant, room, registration, discovery event or HTTP endpoint.
    connected:
      state.status === "direct-peer-connected" &&
      state.peers.length > 0 &&
      state.authorization === "active",
    // Strict connectivity for the "connected now" contract: an open channel is
    // not enough. At least one peer must be AUTHENTICATED (identity from a
    // verified signed envelope) and still live, with an authorization that has
    // not expired or been revoked. Consumers expecting a SPECIFIC agent must
    // still match `authenticatedPeers` against that agent; a different live
    // peer never makes the expected agent online (audit B02).
    authenticatedConnected:
      state.status === "direct-peer-connected" &&
      state.authenticatedPeers.length > 0 &&
      state.authorization === "active",
    generation: state.generation,
    authorization: state.authorization,
    directPeerCount: state.peers.length,
    peers: Object.freeze(state.peers.map((peer) => Object.freeze({ ...peer }))),
    // Identity/session/generation of every live AUTHENTICATED peer. Kept
    // separate from `peers` (raw open channels) so a channel alone cannot
    // impersonate the agent the page is waiting for.
    authenticatedPeers: Object.freeze(
      state.authenticatedPeers.map((peer) => Object.freeze({ ...peer })),
    ),
    diagnostics: Object.freeze({
      relaysConnected: state.relaysConnected,
      ...(state.lastIceError ? { lastIceError: state.lastIceError } : {}),
      waitingSinceMs: state.waitingSince
        ? Math.max(0, state.now() - state.waitingSince)
        : 0,
    }),
    updatedAt: state.updatedAt,
  });
}

export function createConnectionState(options = {}) {
  const now = options.now ?? Date.now;
  const listeners = new Set();
  const state = {
    status: "idle",
    peers: [],
    authenticatedPeers: [],
    relaysConnected: null,
    lastIceError: undefined,
    waitingSince: 0,
    generation: null,
    authorization: "active",
    updatedAt: now(),
    now,
  };
  let snapshot = freezeSnapshot(state);

  function publish() {
    state.updatedAt = now();
    snapshot = freezeSnapshot(state);
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A failing subscriber must not break the lifecycle.
      }
    }
  }

  function enter(status) {
    state.status = status;
    state.waitingSince =
      status === "waiting-for-peers" || status === "signaling"
        ? state.waitingSince || now()
        : 0;
    if (status === "direct-peer-connected") {
      state.lastIceError = undefined;
    }
    if (
      ["expired", "revoked", "reconnecting", "disconnected", "idle"].includes(
        status,
      )
    ) {
      state.peers = [];
      // Losing transport presence loses every authenticated identity with it:
      // a peer that must reauthenticate after a reconnect is not the same peer.
      state.authenticatedPeers = [];
    }
  }

  function transition(status) {
    if (!CONNECTION_STATUSES.includes(status))
      throw new TypeError(`Unknown connection status: ${String(status)}`);
    if (!canTransition(state.status, status))
      throw new Error(
        `Illegal connection transition ${state.status} -> ${status}`,
      );
    enter(status);
    publish();
    return snapshot;
  }

  function tryTransition(status) {
    if (!canTransition(state.status, status)) return false;
    transition(status);
    return true;
  }

  function validPeerId(peerId) {
    if (typeof peerId !== "string" || !peerId || peerId.length > 256)
      throw new TypeError("peerId must be a non-empty string");
  }

  function addPeer({ peerId, walletId, fingerprint } = {}) {
    validPeerId(peerId);
    if (TERMINAL_STATUSES.has(state.status)) return snapshot;
    if (state.peers.some((peer) => peer.peerId === peerId)) return snapshot;
    state.peers = [
      ...state.peers,
      {
        peerId,
        ...(walletId ? { walletId } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        since: now(),
      },
    ];
    if (state.status !== "direct-peer-connected") {
      if (canTransition(state.status, "direct-peer-connected"))
        enter("direct-peer-connected");
    }
    publish();
    return snapshot;
  }

  function removePeer(peerId) {
    validPeerId(peerId);
    const hadAuthenticated = state.authenticatedPeers.some(
      (peer) => peer.peerId === peerId,
    );
    if (
      !state.peers.some((peer) => peer.peerId === peerId) &&
      !hadAuthenticated
    )
      return snapshot;
    state.peers = state.peers.filter((peer) => peer.peerId !== peerId);
    if (hadAuthenticated)
      state.authenticatedPeers = state.authenticatedPeers.filter(
        (peer) => peer.peerId !== peerId,
      );
    if (state.peers.length === 0 && state.status === "direct-peer-connected")
      enter("waiting-for-peers");
    publish();
    return snapshot;
  }

  // Authoritative, replaceable set of live authenticated peers. The transport
  // derives it from verified signed envelopes (issuer + session), so identity
  // cannot be attached to a peer merely because a data channel opened. A
  // goodbye, closed channel or expired lease removes the entry at the source.
  function setAuthenticatedPeers(peers) {
    if (!Array.isArray(peers))
      throw new TypeError("authenticatedPeers must be an array");
    const next = peers.map((peer) => {
      if (!peer || typeof peer.walletId !== "string" || !peer.walletId)
        throw new TypeError(
          "each authenticated peer needs a non-empty walletId",
        );
      if (
        peer.sessionId !== null &&
        peer.sessionId !== undefined &&
        typeof peer.sessionId !== "string"
      )
        throw new TypeError("sessionId must be a string or null");
      return {
        ...(peer.peerId ? { peerId: peer.peerId } : {}),
        walletId: peer.walletId,
        sessionId: peer.sessionId ?? null,
        generation: peer.generation ?? state.generation ?? null,
      };
    });
    // Avoid a publish storm on every heartbeat: only a real change matters.
    if (JSON.stringify(next) === JSON.stringify(state.authenticatedPeers))
      return snapshot;
    state.authenticatedPeers = next;
    publish();
    return snapshot;
  }

  function recordError(error) {
    const message = String(error?.message ?? error?.code ?? error ?? "error");
    state.lastIceError = message.slice(0, 200);
    publish();
    return snapshot;
  }

  // A generation identifies one authenticated transport session. Peers must
  // reject signed events whose session is not the current generation.
  function setGeneration(id) {
    if (id !== null && (typeof id !== "string" || !id)) {
      throw new TypeError("generation must be a non-empty string or null");
    }
    if (id !== state.generation) {
      // A new generation is a new authenticated transport session. Proofs
      // bound to the previous generation must not survive it.
      state.generation = id;
      state.authenticatedPeers = [];
    }
    publish();
    return snapshot;
  }

  function setAuthorization(value) {
    if (!["active", "expired", "revoked"].includes(value))
      throw new TypeError("authorization must be active, expired or revoked");
    state.authorization = value;
    if (value !== "active") {
      // The status must report what actually ended the authorization: an
      // expiry is "expired", a revocation is "revoked". Either way presence is
      // invalidated, even from a state whose table forbids a direct transition.
      if (!tryTransition(value)) enter(value);
    }
    publish();
    return snapshot;
  }

  // A transport failure is not a healthy connection. It immediately drops the
  // live flag and clears peers; recovery must reauthenticate before `connected`
  // can be true again.
  function invalidate({ terminal = false } = {}) {
    state.lastIceError = state.lastIceError ?? "transport-lost";
    // C5/B10: a revoked, expired or closed session is terminal. A transport
    // failure must not revive it into reconnecting and imply recovery is
    // possible. It only drops live presence; reconnect requires explicit
    // reauthorization and a fresh transition out of the terminal state.
    if (!TERMINAL_STATUSES.has(state.status)) {
      if (!tryTransition(terminal ? "disconnected" : "reconnecting")) {
        enter(terminal ? "disconnected" : "reconnecting");
      }
    }
    state.peers = [];
    // The old generation can no longer authenticate any late signed event.
    state.generation = null;
    state.authenticatedPeers = [];
    publish();
    return snapshot;
  }

  function setRelaysConnected(count) {
    if (count !== null && (!Number.isInteger(count) || count < 0))
      throw new TypeError(
        "relaysConnected must be null (unknown) or a non-negative integer",
      );
    state.relaysConnected = count;
    publish();
    return snapshot;
  }

  return Object.freeze({
    get snapshot() {
      return snapshot;
    },
    transition,
    tryTransition,
    addPeer,
    removePeer,
    setAuthenticatedPeers,
    recordError,
    setGeneration,
    setAuthorization,
    invalidate,
    setRelaysConnected,
    subscribe(listener) {
      if (typeof listener !== "function")
        throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
