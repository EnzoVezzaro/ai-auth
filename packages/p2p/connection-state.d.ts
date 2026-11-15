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
    readonly relaysConnected: number;
    readonly lastIceError?: string;
    readonly waitingSinceMs: number;
    readonly retryAttempt: number;
  };
  readonly updatedAt: number;
}

export interface ConnectionStateOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

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
  setRelaysConnected(count: number): ConnectionSnapshot;
  scheduleRetry(attempt: (n: number) => unknown): {
    scheduled: boolean;
    delayMs: number;
  };
  cancelRetry(): void;
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
