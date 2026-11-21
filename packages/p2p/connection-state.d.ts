export type ConnectionStatus =
  | "idle"
  | "approval-pending"
  | "wallet-authorized"
  | "connecting"
  | "signaling"
  | "waiting-for-peers"
  | "direct-peer-connected"
  | "reconnecting"
  | "degraded"
  | "expired"
  | "revoked"
  | "disconnected";

export interface ConnectionPeer {
  readonly peerId: string;
  readonly walletId?: string;
  readonly fingerprint?: string;
  readonly since: number;
}

/**
 * A peer whose identity came from a verified signed envelope. An open data
 * channel (`ConnectionPeer`) is NOT an authenticated peer: consumers waiting
 * for a specific agent must match wallet + session here.
 */
export interface AuthenticatedPeer {
  readonly peerId?: string;
  readonly walletId: string;
  readonly sessionId: string | null;
  readonly generation: string | null;
}

export interface ConnectionSnapshot {
  readonly status: ConnectionStatus;
  /** Lenient: a live channel exists. Never from a saved grant or endpoint. */
  readonly connected: boolean;
  /** Strict: a live AUTHENTICATED peer exists. Still not tied to a specific agent. */
  readonly authenticatedConnected: boolean;
  readonly generation: string | null;
  readonly authorization: "active" | "expired" | "revoked";
  readonly directPeerCount: number;
  readonly peers: readonly ConnectionPeer[];
  readonly authenticatedPeers: readonly AuthenticatedPeer[];
  readonly diagnostics: {
    readonly relaysConnected: number | null;
    readonly lastIceError?: string;
    readonly waitingSinceMs: number;
  };
  readonly updatedAt: number;
}

export interface ConnectionStateOptions {}

export interface ConnectionState {
  readonly snapshot: ConnectionSnapshot;
  transition(status: ConnectionStatus): ConnectionSnapshot;
  tryTransition(status: ConnectionStatus): boolean;
  addPeer(peer: {
    peerId: string;
    walletId?: string;
    fingerprint?: string;
  }): ConnectionSnapshot;
  removePeer(peerId: string): ConnectionSnapshot;
  setAuthenticatedPeers(
    peers: readonly {
      peerId?: string;
      walletId: string;
      sessionId?: string | null;
      generation?: string | null;
    }[],
  ): ConnectionSnapshot;
  recordError(error: unknown): ConnectionSnapshot;
  setGeneration(id: string | null): ConnectionSnapshot;
  setAuthorization(value: "active" | "expired" | "revoked"): ConnectionSnapshot;
  invalidate(options?: { terminal?: boolean }): ConnectionSnapshot;
  setRelaysConnected(count: number | null): ConnectionSnapshot;
  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void;
}

export const CONNECTION_STATUSES: readonly ConnectionStatus[];
export const CONNECTION_TRANSITIONS: Readonly<
  Record<ConnectionStatus, readonly ConnectionStatus[]>
>;
export function canTransition(
  from: ConnectionStatus,
  to: ConnectionStatus,
): boolean;
export function createConnectionState(
  options?: ConnectionStateOptions,
): ConnectionState;
