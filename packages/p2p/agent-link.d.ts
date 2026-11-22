export declare const AGENT_LINK_PARAM: "ai-auth-link";
export declare const AGENT_LINK_EVENTS: Readonly<{
  hello: "agent/link-hello";
  accept: "agent/link-accept";
  challenge: "agent/site-challenge";
  response: "agent/site-response";
}>;
export declare const DEFAULT_AGENT_LINK_TTL_MS: number;
export declare const MAX_AGENT_LINK_TTL_MS: number;
export declare const AGENT_LINK_CAPABILITIES: readonly string[];

/** A one-time connect link payload. `code` is the secret; it lives only in the URL fragment. */
export interface AIAuthAgentLink {
  readonly type: "ai-auth-link";
  readonly v: 1;
  readonly origin: string;
  readonly room: string;
  /** The site page's short-lived room key id. */
  readonly site: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly code: string;
  readonly expiresAt: number;
}

export declare function validLinkOrigin(value: unknown): boolean;
export declare function validateAgentLink(
  payload: unknown,
  options?: { now?: number; allowExpired?: boolean },
): AIAuthAgentLink;
export declare function createAgentLinkPayload(options: {
  origin: string;
  room?: string;
  site: string;
  name: string;
  capabilities: readonly string[];
  ttlMs?: number;
  now?: number;
}): AIAuthAgentLink;
export declare function encodeAgentLinkToken(payload: AIAuthAgentLink): string;
export declare function agentLinkUrl(
  baseUrl: string,
  payload: AIAuthAgentLink,
): string;
export declare function isAgentLink(input: unknown): boolean;
/** Parses a full connect link URL; a bare token is refused. */
export declare function parseAgentLink(
  input: string,
  options?: { now?: number; allowExpired?: boolean },
): AIAuthAgentLink;
export declare function randomAgentLinkCode(): string;
export declare function randomAgentLinkNonce(): string;
export declare function agentLinkProof(fields: {
  code: string;
  origin: string;
  room: string;
  site: string;
  agent: string;
  linkNonce: string;
}): Promise<string>;
export declare function verifyAgentLinkProof(
  link: AIAuthAgentLink,
  fields: { agent: string; linkNonce: string; proof: string },
): Promise<boolean>;
export interface PairPublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}
export declare function isPairPublicKey(value: unknown): value is PairPublicKey;
export declare function createPairKeyPair(): Promise<{
  readonly privateKey: CryptoKey;
  readonly publicKey: Readonly<PairPublicKey>;
}>;
/** Mixes the link code with an ephemeral ECDH exchange; never sent. */
export declare function deriveAgentPairSecret(fields: {
  code: string;
  agent: string;
  linkNonce: string;
  privateKey: CryptoKey;
  peerPublicKey: PairPublicKey;
}): Promise<string>;
export interface AgentPairProofFields {
  role: "site-challenge" | "agent-response";
  origin: string;
  room: string;
  site: string;
  agent: string;
  challenge: string;
}
export declare function agentPairProof(
  secret: string,
  fields: AgentPairProofFields,
): Promise<string>;
export declare function verifyAgentPairProof(
  secret: string,
  fields: AgentPairProofFields,
  proof: unknown,
): Promise<boolean>;
export declare function isAgentPairSecret(value: unknown): boolean;
export declare function isAgentLinkNonce(value: unknown): boolean;
export declare function isAgentId(value: unknown): boolean;
