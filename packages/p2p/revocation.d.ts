import type {
  MembershipIssuerKey,
  MembershipTrustPolicy,
} from "./membership.js";

export type RevocationKind = "membership" | "link" | "wallet";

/** Signed revocation of one membership id, link id, or wallet id. */
export interface RevocationRecord {
  type: "ai-auth-revocation";
  v: 1;
  id: string;
  kind: RevocationKind;
  target: string;
  origin: string;
  room: string;
  issuer: MembershipIssuerKey;
  issuedAt: number;
  signature: string;
}

export type RevocationVerification =
  | { ok: true; record: RevocationRecord; issuerId: string }
  | { ok: false; reason: string };

export const REVOCATION_TYPE: "ai-auth-revocation";
export const REVOCATION_VERSION: 1;
export const REVOCATION_KINDS: readonly RevocationKind[];
export const REVOCATION_GOSSIP_EVENT: "revocation/gossip";

export function createRevocation(
  signerWallet: { publicKey: JsonWebKey; privateKey: CryptoKey },
  options: {
    kind: RevocationKind;
    target: string;
    origin: string;
    room: string;
    now?: number;
  },
): Promise<Readonly<RevocationRecord>>;

export function verifyRevocation(
  record: unknown,
  options: {
    trustPolicy: MembershipTrustPolicy;
    expectedOrigin: string;
    expectedRoom: string;
    now?: number | (() => number);
  },
): Promise<RevocationVerification>;

export interface EpochRecord {
  type: "ai-auth-epoch";
  v: 1;
  id: string;
  epoch: number;
  origin: string;
  room: string;
  issuer: MembershipIssuerKey;
  issuedAt: number;
  signature: string;
}

export const EPOCH_TYPE: "ai-auth-epoch";
export const EPOCH_VERSION: 1;
export const REVOCATION_SYNC_REQUEST_EVENT: "revocation/sync-request";
export const REVOCATION_SYNC_EVENT: "revocation/sync";

export function createEpochRecord(
  signerWallet: { publicKey: JsonWebKey; privateKey: CryptoKey },
  options: { epoch: number; origin: string; room: string; now?: number },
): Promise<Readonly<EpochRecord>>;

export function verifyEpochRecord(
  record: unknown,
  options: {
    trustPolicy: MembershipTrustPolicy;
    expectedOrigin: string;
    expectedRoom: string;
    now?: number | (() => number);
  },
): Promise<
  | { ok: true; record: EpochRecord; issuerId: string }
  | { ok: false; reason: string }
>;

type GossipResult =
  { ok: true; applied: boolean } | { ok: false; reason: string };

export interface RevocationGossip {
  /** Apply a record locally, then broadcast it to connected peers. */
  publish(record: RevocationRecord): Promise<GossipResult>;
  /** Apply a wallet-signed `ai-auth-link-revocation` event, then broadcast it. */
  publishLinkRevocation(event: unknown): Promise<GossipResult>;
  /** Apply a signed epoch announcement, then broadcast it. */
  publishEpoch(record: EpochRecord): Promise<GossipResult>;
  /** Ask connected peers for their latest epoch and recent revocations. */
  requestSync(): Promise<void>;
  diagnostics(): readonly Readonly<{ id: string; reason: string }>[];
  close(): void;
}

export function createRevocationGossip(
  room: {
    send(type: string, payload?: unknown): Promise<unknown>;
    subscribe(listener: (event: any) => void): () => void;
    policy?: unknown;
    privateMode?: boolean;
  },
  options?: {
    policy?: {
      applyRevocation(
        record: unknown,
      ): Promise<
        { ok: true; applied: boolean } | { ok: false; reason: string }
      >;
    };
    onApplied?: (record: RevocationRecord) => void;
  },
): RevocationGossip;
