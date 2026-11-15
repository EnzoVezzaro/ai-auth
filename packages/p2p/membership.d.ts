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
  signature: string;
}

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
    now?: number;
  },
): Promise<Readonly<MembershipProof>>;

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
  }>[];
}

export function createParticipationPolicy(options: {
  mode?: RoomMode;
  trustPolicy?: MembershipTrustPolicy;
  origin: string;
  room: string;
  now?: () => number;
}): ParticipationPolicy;
