export const CURSOR_TYPE: "ai-auth-cursor";
export const CURSOR_VERSION: 1;
export const HEARTBEAT_MS: number;
export const OFFLINE_AFTER_MS: number;
export const LEASE_MS: number;
export const MAX_COORDINATE: number;

export interface VirtualCursor {
  readonly pageKey: string;
  /** Document coordinates in CSS pixels, not viewport coordinates. */
  readonly x: number;
  readonly y: number;
  readonly seq: number;
  readonly selector?: string;
  /** A claim, never an identity. */
  readonly label?: string;
}

export interface PresencePeer {
  readonly walletId: string;
  readonly session: string;
  readonly label?: string;
  readonly state: "online" | "offline";
  readonly lastSeen: number;
  readonly cursor?: VirtualCursor;
}

export function validateCursor(
  input: unknown,
): { ok: true; cursor: VirtualCursor } | { ok: false; reason: string };
export function buildCursorPayload(
  fields: Omit<VirtualCursor, never>,
): { type: "ai-auth-cursor"; v: 1 } & VirtualCursor;
export function parseCursorPayload(
  payload: unknown,
): { ok: true; cursor: VirtualCursor } | { ok: false; reason: string };

export interface PresenceTracker {
  heartbeat(peer: {
    walletId: string;
    session: string;
    label?: string;
  }): boolean;
  cursor(input: {
    walletId: string;
    session: string;
    payload: unknown;
  }): { ok: true } | { ok: false; reason: string };
  goodbye(peer: { walletId: string; session: string }): boolean;
  sweep(): boolean;
  list(): PresencePeer[];
  cursorsFor(pageKey: string): PresencePeer[];
  subscribe(listener: (peers: PresencePeer[]) => void): () => void;
  clear(): void;
}
export function createPresenceTracker(options?: {
  now?: () => number;
  leaseMs?: number;
  offlineAfterMs?: number;
  maxPeers?: number;
}): PresenceTracker;
