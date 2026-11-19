// Type declarations for the agent-interoperability BOUNDARY.
// See docs/architecture/AGENT_INTEROPERABILITY.md and
// docs/INTEROPERABILITY_CODE_MODE_RFC.md (P5). Additive only: no A2A task
// state, no ACP session semantics, no tool grants from agent coordination.

export type ProtocolId =
  | "a2a"
  | "agent-client-protocol"
  | "agentic-commerce-protocol"
  | "agent-communication-protocol"
  | "ambiguous"
  | "unknown";

export const PROTOCOL_IDS: Readonly<{
  readonly A2A: "a2a";
  readonly AGENT_CLIENT: "agent-client-protocol";
  readonly AGENTIC_COMMERCE: "agentic-commerce-protocol";
  readonly AGENT_COMMUNICATION: "agent-communication-protocol";
  readonly AMBIGUOUS: "ambiguous";
  readonly UNKNOWN: "unknown";
}>;

export const PROTOCOL_LABELS: Readonly<Record<ProtocolId, string>>;

/** Classify a protocol name; bare `ACP` yields `ambiguous`. */
export function classifyProtocol(name: string): ProtocolId;
/** Human label for an id or a raw name, or null when unknown. */
export function protocolLabel(idOrName: string): string | null;

export interface AcpHarnessBoundary {
  readonly protocol: "agent-client-protocol";
  readonly label: string;
  readonly protocolVersion: string;
  readonly transport: "jsonrpc-2.0-stdio";
  readonly ownsSessionSemantics: false;
  readonly ownsPermissionSemantics: false;
  readonly notTheSameAs: Readonly<{
    readonly historical: "agent-communication-protocol";
    readonly commerce: "agentic-commerce-protocol";
    readonly agentToAgent: "a2a";
  }>;
  readonly classify: (name: string) => ProtocolId;
}

export function createAcpHarnessBoundary(options?: {
  protocolVersion?: number | string;
}): AcpHarnessBoundary;

// --------------------------------------------------------------------------
// Untrusted A2A Agent Card view
// --------------------------------------------------------------------------

export interface UntrustedSkill {
  readonly id: string | null;
  readonly name: string | null;
  readonly description: string | null; // untrusted text, never instructions
}

export interface AuthScheme {
  readonly name: string | null;
  readonly type: string | null;
}

export interface UntrustedAgentCardView {
  readonly protocol: "a2a";
  readonly kind: "untrusted-agent-card-metadata";
  readonly untrusted: true;
  readonly name: string | null;
  readonly url: string | null;
  readonly skills: readonly UntrustedSkill[];
  readonly authSchemes: readonly AuthScheme[];
  readonly signed: boolean;
  readonly verification:
    "verified" | "unverified" | "not-checked" | "no-signature";
  /** Always empty: a card never grants authority. */
  readonly capabilities: readonly [];
  readonly toolPermissions: readonly [];
  readonly authority: "none";
  readonly note: string;
}

/** A verifier for a (possibly signed) Agent Card. */
export type CardVerifier = (
  card: unknown,
) => boolean | { ok: boolean } | Promise<boolean | { ok: boolean }>;

/** Read a card into an untrusted view. Never mutates `card`. */
export function fromAgentCard(
  card: unknown,
  options?: { verifier?: CardVerifier },
): Promise<UntrustedAgentCardView>;

// --------------------------------------------------------------------------
// Minimal identity claim bound to an existing signed AI Auth envelope
// --------------------------------------------------------------------------

export const IDENTITY_CLAIM_TYPE: "a2a/identity-claim";
export const CLAIM_VERSION: 1;

/** An existing signed AI Auth envelope (signEnvelope output), preserved verbatim. */
export interface SignedEnvelope {
  readonly body: {
    readonly protocol: string;
    readonly version: number;
    readonly type: string;
    readonly issuer: string; // agent:...
    readonly createdAt: string;
    readonly payload: unknown;
  };
  readonly proof: {
    readonly algorithm: string;
    readonly publicKey: Record<string, unknown>;
    readonly signature: string;
  };
}

export interface AgentInteraction {
  readonly protocol?: string | null;
  readonly kind?: string | null;
  readonly id: string;
}

export interface IdentityClaim {
  readonly version: 1;
  readonly type: "a2a/identity-claim";
  /** Envelope issuer (agent:...). Never fabricated by this module. */
  readonly identity: string;
  /** Requested identity label (agent: or did:key:), or null. */
  readonly subject: string | null;
  readonly interaction: Readonly<{
    readonly id: string;
    readonly protocol: string | null;
    readonly kind: string | null;
  }>;
  readonly audience: string | null;
  readonly envelope: SignedEnvelope;
  /** Always empty: an identity claim confers no tool permission. */
  readonly grants: readonly [];
  readonly capabilities: readonly [];
}

/** Verifies the carried envelope; signature validity is its decision. */
export type EnvelopeVerifier = (
  envelope: SignedEnvelope,
  expectations: { expectedIssuer: string },
) => boolean | { ok: boolean } | Promise<boolean | { ok: boolean }>;

export interface ClaimVerifyOk {
  readonly ok: true;
  readonly identity: string;
  readonly subject: string | null;
  readonly interaction: IdentityClaim["interaction"];
  readonly audience: string | null;
}

export interface InteropFailure {
  readonly ok: false;
  readonly reason: string;
}

export interface AgentIdentityClaimBinder {
  readonly identity: string | null;
  create(options: {
    envelope: SignedEnvelope;
    interaction: AgentInteraction;
    audience?: string | null;
  }): IdentityClaim;
  verify(
    claim: IdentityClaim,
    expectations?: {
      expectedIdentity?: string;
      expectedInteraction?: string | AgentInteraction;
      expectedAudience?: string | null;
    },
  ): Promise<ClaimVerifyOk | InteropFailure>;
}

/** Returns a claim binder. Never invents a signature or a credential format. */
export function createAgentIdentityClaim(options: {
  identity?: string | null;
  verifier: EnvelopeVerifier;
}): AgentIdentityClaimBinder;

/** Standalone verification with an injected verifier. */
export function verifyAgentIdentityClaim(
  claim: IdentityClaim,
  options: {
    verifier: EnvelopeVerifier;
    expectedIdentity?: string;
    expectedInteraction?: string | AgentInteraction;
    expectedAudience?: string | null;
  },
): Promise<ClaimVerifyOk | InteropFailure>;

// --------------------------------------------------------------------------
// Deny-by-default A2A task authorization
// --------------------------------------------------------------------------

export const INTEROP_DENIAL_CODES: Readonly<{
  readonly TASK_NOT_A_TOOL_CALL: "TASK_NOT_A_TOOL_CALL";
  readonly CAPABILITY_NOT_APPROVED: "CAPABILITY_NOT_APPROVED";
  readonly INVALID_IDENTITY: "INVALID_IDENTITY";
}>;

export interface AgentTaskAuthorization {
  /** Always false. */
  readonly allowed: false;
  readonly ok: false;
  readonly code:
    "TASK_NOT_A_TOOL_CALL" | "CAPABILITY_NOT_APPROVED" | "INVALID_IDENTITY";
  readonly reason: string;
  readonly identity: string | null;
  readonly requestedCapabilities: readonly string[];
  readonly missingCapabilities: readonly string[];
  /** Always empty: a task never grants capabilities. */
  readonly grantedCapabilities: readonly [];
  /** Always false: a task is never a tool permission. */
  readonly toolPermission: false;
}

/** Always denies with a clear reason. Never mutates inputs. */
export function authorizeAgentTask(options?: {
  task?: unknown;
  identity?: string | null;
  approvedCapabilities?: readonly string[];
}): AgentTaskAuthorization;

declare const agentInterop: {
  PROTOCOL_IDS: typeof PROTOCOL_IDS;
  PROTOCOL_LABELS: typeof PROTOCOL_LABELS;
  classifyProtocol: typeof classifyProtocol;
  protocolLabel: typeof protocolLabel;
  createAcpHarnessBoundary: typeof createAcpHarnessBoundary;
  fromAgentCard: typeof fromAgentCard;
  createAgentIdentityClaim: typeof createAgentIdentityClaim;
  verifyAgentIdentityClaim: typeof verifyAgentIdentityClaim;
  authorizeAgentTask: typeof authorizeAgentTask;
  INTEROP_DENIAL_CODES: typeof INTEROP_DENIAL_CODES;
  IDENTITY_CLAIM_TYPE: typeof IDENTITY_CLAIM_TYPE;
  CLAIM_VERSION: typeof CLAIM_VERSION;
};

export default agentInterop;

// NOTE: `attachToolGrant` is intentionally not declared or exported. An A2A
// task is not a tool call; a helper that attaches a tool grant from a task,
// card or metadata would collapse two distinct trust boundaries.
