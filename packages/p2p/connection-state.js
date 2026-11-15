// Typed connection lifecycle for the P2P transport.
// Illegal transitions THROW from `transition()`; `tryTransition()` returns
// false and leaves state untouched (used by transports that must never throw).

export const CONNECTION_STATUSES = Object.freeze([
  "idle",
  "approval-pending",
  "wallet-authorized",
  "signaling",
  "waiting-for-peers",
  "direct-peer-connected",
  "degraded",
  "expired",
  "disconnected",
]);

const table = {
  idle: ["approval-pending", "wallet-authorized", "signaling", "disconnected"],
  "approval-pending": ["wallet-authorized", "expired", "disconnected"],
  "wallet-authorized": ["signaling", "expired", "disconnected"],
  signaling: [
    "waiting-for-peers",
    "direct-peer-connected",
    "degraded",
    "expired",
    "disconnected",
  ],
  "waiting-for-peers": [
    "signaling",
    "direct-peer-connected",
    "degraded",
    "expired",
    "disconnected",
  ],
  "direct-peer-connected": [
    "waiting-for-peers",
    "degraded",
    "expired",
    "disconnected",
  ],
  degraded: [
    "signaling",
    "waiting-for-peers",
    "direct-peer-connected",
    "expired",
    "disconnected",
  ],
  expired: ["idle", "disconnected"],
  disconnected: ["idle", "approval-pending", "signaling"],
};

export const CONNECTION_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(table).map(([from, to]) => [from, Object.freeze([...to])]),
  ),
);

export function canTransition(from, to) {
  return CONNECTION_TRANSITIONS[from]?.includes(to) === true;
}

function freezeSnapshot(state) {
  return Object.freeze({
    status: state.status,
    directPeerCount: state.peers.length,
    peers: Object.freeze(state.peers.map((peer) => Object.freeze({ ...peer }))),
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
    relaysConnected: null,
    lastIceError: undefined,
    waitingSince: 0,
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
    if (["expired", "disconnected", "idle"].includes(status)) {
      state.peers = [];
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
    if (state.status === "expired" || state.status === "disconnected")
      return snapshot;
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
    if (!state.peers.some((peer) => peer.peerId === peerId)) return snapshot;
    state.peers = state.peers.filter((peer) => peer.peerId !== peerId);
    if (state.peers.length === 0 && state.status === "direct-peer-connected")
      enter("waiting-for-peers");
    publish();
    return snapshot;
  }

  function recordError(error) {
    const message = String(error?.message ?? error?.code ?? error ?? "error");
    state.lastIceError = message.slice(0, 200);
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
    recordError,
    setRelaysConnected,
    subscribe(listener) {
      if (typeof listener !== "function")
        throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
