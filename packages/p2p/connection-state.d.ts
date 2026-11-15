export type ConnectionStatus =
  | "idle"
  | "approval-pending"
  | "wallet-authorized"
  | "signaling"
  | "waiting-for-peers"
  | "direct-peer-connected"
  | "degraded"
  | "expired"
  | "disconnected";

export interface ConnectionPeer {
  readonly peerId: string;
  readonly walletId?: string;
  readonly fingerprint?: string;
  readonly since: number;
}

export interface ConnectionSnapshot {
  readonly status: ConnectionStatus;
  readonly directPeerCount: number;
  readonly peers: readonly ConnectionPeer[];
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
  recordError(error: unknown): ConnectionSnapshot;
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
