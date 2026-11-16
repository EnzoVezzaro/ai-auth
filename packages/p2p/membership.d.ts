export type RoomMode = "open" | "restricted";
export type MembershipRole = "owner" | "member" | "observer";

export interface MembershipIssuerKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** Site/host-signed proof that a wallet may participate in one room. */
export interface MembershipProof {
  type: "ai-auth-membership";
  v: 1;
  id: string;
  issuer: MembershipIssuerKey;
  subject: string;
  origin: string;
  room: string;
  /** Authorization role. A human/agent label is only a claim. */
  role: MembershipRole;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  /** Authorization epoch; absent means epoch 0. */
  epoch?: number;
  durationKind?: DurationKind;
  signature: string;
}

export type DurationKind = "short" | "configured" | "long" | "until-revoked";
export type MembershipDuration =
  | { kind: "short"; ttlMs?: number }
  | { kind: "configured"; ttlMs: number }
  | { kind: "long"; ttlMs: number }
  | { kind: "until-revoked" };

/** Short-lived, renewable permission to run protected operations. */
export interface ExecutionGrant {
  type: "ai-auth-execution-grant";
  v: 1;
  id: string;
  issuer: MembershipIssuerKey;
  subject: string;
  origin: string;
  room: string;
  membershipId: string;
  scopes: string[];
  epoch: number;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export type ExecutionGrantVerification =
  | {
      ok: true;
      id: string;
      issuerId: string;
      subject: string;
      membershipId: string;
      scopes: readonly string[];
      epoch: number;
      expiresAt: number;
    }
  | { ok: false; reason: string };

export type ProtectedAuthorization =
  | {
      allow: true;
      reason: "ok";
      role: MembershipRole;
      grantExpiresAt: number;
    }
  | { allow: false; reason: string };

export interface MembershipTrustPolicy {
  /** Trusted issuer public keys (JWK) or `agent:` identity ids. */
  issuers: Array<JsonWebKey | string>;
}

export type MembershipVerification =
  | {
      ok: true;
      id: string;
      issuerId: string;
      subject: string;
      role: MembershipRole;
      scopes: readonly string[];
      expiresAt: number;
      epoch: number;
      durationKind: DurationKind | null;
    }
  | { ok: false; reason: string };

export const MEMBERSHIP_TYPE: "ai-auth-membership";
export const MEMBERSHIP_VERSION: 1;
export const MAX_MEMBERSHIP_TTL_MS: number;
export const ROOM_MODES: readonly RoomMode[];
export const ROLES: readonly MembershipRole[];
export const OPEN_ROOM_DISCLOSURE: string;

export function issueMembership(
  issuerWallet: { publicKey: JsonWebKey; privateKey: CryptoKey },
  options: {
    subject: string;
    origin: string;
    room: string;
    role?: MembershipRole;
    scopes?: string[];
    ttlMs?: number;
    /** Overrides `ttlMs`. `until-revoked` never grants execution by itself. */
    duration?: MembershipDuration;
    epoch?: number;
    now?: number;
  },
): Promise<Readonly<MembershipProof>>;

export const EXECUTION_GRANT_TYPE: "ai-auth-execution-grant";
export const MAX_EXECUTION_GRANT_TTL_MS: number;
export const DEFAULT_EXECUTION_GRANT_TTL_MS: number;
export const CATCHUP_MAX_RECORDS: number;
export const CATCHUP_MAX_AGE_MS: number;
export const DURATION_KINDS: readonly DurationKind[];
export const DURATION_LIMITS: Readonly<Record<DurationKind, number>>;

export function resolveDuration(
  duration: MembershipDuration,
): Readonly<{ kind: DurationKind; ttlMs: number }>;

export function issueExecutionGrant(
  issuerWallet: { publicKey: JsonWebKey; privateKey: CryptoKey },
  options: {
    subject: string;
    origin: string;
    room: string;
    membershipId: string;
    scopes?: string[];
    epoch?: number;
    ttlMs?: number;
    now?: number;
  },
): Promise<Readonly<ExecutionGrant>>;

export function renewExecutionGrant(
  issuerWallet: { publicKey: JsonWebKey; privateKey: CryptoKey },
  grant: ExecutionGrant,
  options?: { ttlMs?: number; now?: number },
): Promise<Readonly<ExecutionGrant>>;

export function verifyExecutionGrant(
  grant: unknown,
  options: {
    trustPolicy: MembershipTrustPolicy;
    expectedOrigin: string;
    expectedRoom: string;
    expectedSubject: string;
    now?: number | (() => number);
  },
): Promise<ExecutionGrantVerification>;

export function authorizeProtected(input: {
  policy: ParticipationPolicy;
  walletId: string;
  scope: string;
  now?: number | (() => number);
}): ProtectedAuthorization;

export function verifyMembership(
  proof: unknown,
  options: {
    trustPolicy: MembershipTrustPolicy;
    expectedOrigin: string;
    expectedRoom: string;
    expectedSubject: string;
    now?: number | (() => number);
  },
): Promise<MembershipVerification>;

export interface ParticipationPolicy {
  readonly mode: RoomMode;
  readonly origin: string;
  readonly room: string;
  /** Text the UI should show for open rooms; null for restricted rooms. */
  readonly disclosure: string | null;
  /** Latest known authorization epoch (monotonic). */
  readonly epoch: number;
  /** Invalidate all proofs and grants issued under an older epoch. */
  bumpEpoch(): number;
  /** Raise (never lower) the epoch to a value learned elsewhere. */
  observeEpoch(epoch: number): number;
  /** Shaped for `verifyLink({ revokedLinks })`. */
  readonly revokedLinks: { has(linkId: string): boolean };
  admitGrant(
    walletId: string,
    grant: unknown,
  ): Promise<ExecutionGrantVerification>;
  applyRevocation(
    record: unknown,
  ): Promise<
    | { ok: true; applied: boolean; kind?: "membership" | "link" | "wallet" }
    | { ok: false; reason: string }
  >;
  /** Verify and apply a wallet-signed `ai-auth-link-revocation` event. */
  applyLinkRevocation(
    event: unknown,
  ): Promise<
    { ok: true; applied: boolean; kind: "link" } | { ok: false; reason: string }
  >;
  /** Verify and apply a signed `ai-auth-epoch` announcement. */
  applyEpoch(
    record: unknown,
  ): Promise<
    | { ok: true; applied: boolean; kind: "epoch" }
    | { ok: false; reason: string }
  >;
  /** Bounded, newest-first records for catch-up of offline peers. */
  recentRecords(options?: { limit?: number; maxAgeMs?: number }): Readonly<{
    epoch: unknown | null;
    revocations: unknown[];
    linkRevocations: unknown[];
  }>;
  isRevoked(kind: "membership" | "link" | "wallet", target: string): boolean;
  inspect(walletId: string, now?: number): unknown;
  admit(
    peerWalletId: string,
    proof: unknown,
  ): Promise<MembershipVerification | { ok: true; role: "member" }>;
  /** Removes and revokes the admitting proof; a fresh proof may re-admit. */
  remove(walletId: string): boolean;
  block(walletId: string): boolean;
  unblock(walletId: string): boolean;
  isBlocked(walletId: string): boolean;
  isMember(walletId: string): boolean;
  roleOf(walletId: string): MembershipRole | null;
  can(walletId: string, scope: string): boolean;
  snapshot(): readonly Readonly<{
    walletId: string;
    role: MembershipRole;
    scopes: readonly string[];
    expiresAt: number;
    epoch: number;
    durationKind: DurationKind | null;
  }>[];
}

export function createParticipationPolicy(options: {
  mode?: RoomMode;
  trustPolicy?: MembershipTrustPolicy;
  origin: string;
  room: string;
  epoch?: number;
  now?: () => number;
}): ParticipationPolicy;
