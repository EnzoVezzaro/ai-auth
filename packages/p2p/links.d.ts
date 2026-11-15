import type { SignedEnvelope, WalletIdentity } from "./index.js";

export const LINK_POLICY: Readonly<{
  maxChallengeSeconds: number;
  defaultChallengeSeconds: number;
  maxLinkSeconds: number;
  defaultLinkSeconds: number;
  clockSkewMs: number;
}>;

export interface LinkChallenge {
  type: "ai-auth-link-challenge";
  v: 1;
  origin: string;
  resource: string;
  capabilities: string[];
  nonce: string;
  createdAt: number;
  expiresAt: number;
  subject?: string;
}

export interface LinkPayload {
  type: "ai-auth-link";
  v: 1;
  linkId: string;
  origin: string;
  resource: string;
  walletId: string;
  publicKey: JsonWebKey;
  capabilities: string[];
  nonce: string;
  createdAt: number;
  expiresAt: number;
  subject?: string;
}

export interface LinkRevocationPayload {
  type: "ai-auth-link-revocation";
  v: 1;
  linkId: string;
  origin: string;
  resource: string;
  walletId: string;
  nonce: string;
  revokedAt: number;
}

export type LinkProof = SignedEnvelope<LinkPayload>;
export type LinkRevocationEvent = SignedEnvelope<LinkRevocationPayload>;

export interface LinkRecord extends LinkPayload {
  proof: LinkProof;
  expired: boolean;
}

export interface LinkNonceStore {
  consume(nonce: string, options: { now: number }): boolean | Promise<boolean>;
}

export interface IssuingLinkNonceStore extends LinkNonceStore {
  issue(nonce: string, expiresAt: number): void;
}

export interface RevokedLinkSet {
  has(linkId: string): boolean;
  add(
    event: LinkRevocationEvent,
    options: { expectedOrigin: string; now?: number },
  ): Promise<LinkRevocationResult>;
  list(): string[];
}

export type LinkVerification =
  { valid: true; link: LinkPayload } | { valid: false; reason: string };

export type LinkRevocationResult =
  | { valid: true; revocation: LinkRevocationPayload }
  | { valid: false; reason: string };

export function createLinkNonceStore(): IssuingLinkNonceStore;
export function createRevokedLinkSet(): RevokedLinkSet;
export function deriveLinkId(fields: {
  origin: string;
  walletId: string;
  resource: string;
  nonce: string;
}): Promise<string>;

export function createLinkChallenge(options: {
  origin: string;
  resource: string;
  capabilities: string[];
  subject?: string;
  ttlSeconds?: number;
  nonceStore?: IssuingLinkNonceStore;
  now?: number;
}): LinkChallenge;

export function approveLink(
  wallet: WalletIdentity,
  challenge: LinkChallenge,
  options: { capabilities: string[]; linkTtlSeconds?: number; now?: number },
): Promise<LinkProof>;

export function listLinks(
  wallet: WalletIdentity,
  options?: { includeExpired?: boolean; now?: number },
): Promise<LinkRecord[]>;

export function unlink(
  wallet: WalletIdentity,
  linkId: string,
  options?: { now?: number },
): Promise<LinkRevocationEvent>;

export function verifyLink(
  proof: LinkProof,
  options: {
    expectedOrigin: string;
    expectedResource: string;
    expectedCapabilities: string[];
    expectedSubject?: string;
    nonceStore: LinkNonceStore;
    revokedLinks?: { has(linkId: string): boolean };
    now?: number;
  },
): Promise<LinkVerification>;

export function verifyLinkRevocation(
  event: LinkRevocationEvent,
  options: { expectedOrigin: string; now?: number },
): Promise<LinkRevocationResult>;
