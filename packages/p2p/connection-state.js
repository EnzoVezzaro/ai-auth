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

const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
});

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative integer`);
  return value;
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
      retryAttempt: state.retryAttempt,
    }),
    updatedAt: state.updatedAt,
  });
}

export function createConnectionState(options = {}) {
  const retry = {
    maxAttempts: positiveInt(
      options.maxAttempts,
      DEFAULT_RETRY.maxAttempts,
      "maxAttempts",
    ),
    baseDelayMs: positiveInt(
      options.baseDelayMs,
      DEFAULT_RETRY.baseDelayMs,
      "baseDelayMs",
    ),
    maxDelayMs: positiveInt(
      options.maxDelayMs,
      DEFAULT_RETRY.maxDelayMs,
      "maxDelayMs",
    ),
  };
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const listeners = new Set();
  const state = {
    status: "idle",
    peers: [],
    relaysConnected: 0,
    lastIceError: undefined,
    waitingSince: 0,
    retryAttempt: 0,
    updatedAt: now(),
    now,
  };
  let timer = null;
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
      state.retryAttempt = 0;
      state.lastIceError = undefined;
    }
    if (["expired", "disconnected", "idle"].includes(status)) {
      cancelRetry();
      state.peers = [];
    }
  }

  function cancelRetry() {
    if (timer !== null) clearTimer(timer);
    timer = null;
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
    if (!Number.isInteger(count) || count < 0)
      throw new TypeError("relaysConnected must be a non-negative integer");
    state.relaysConnected = count;
    publish();
    return snapshot;
  }

  function scheduleRetry(attempt) {
    if (typeof attempt !== "function")
      throw new TypeError("attempt must be a function");
    cancelRetry();
    if (state.retryAttempt >= retry.maxAttempts) {
      tryTransition("degraded");
      return { scheduled: false, delayMs: 0 };
    }
    const delayMs = Math.min(
      retry.maxDelayMs,
      retry.baseDelayMs * 2 ** state.retryAttempt,
    );
    state.retryAttempt += 1;
    publish();
    timer = setTimer(async () => {
      timer = null;
      try {
        await attempt(state.retryAttempt);
      } catch (error) {
        recordError(error);
        scheduleRetry(attempt);
      }
    }, delayMs);
    return { scheduled: true, delayMs };
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
    scheduleRetry,
    cancelRetry,
    subscribe(listener) {
      if (typeof listener !== "function")
        throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
