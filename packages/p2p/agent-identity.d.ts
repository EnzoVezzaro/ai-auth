export interface AgentRuntime {
  name: string;
  version?: string | null;
}

/**
 * Signed self-description. `agentType`, `runtime`, `provider` and `model` are
 * the agent's own claims, not attestations.
 */
export interface AgentDescriptor {
  type: "ai-auth-agent-descriptor";
  v: 1;
  protocolVersion: 1;
  walletId: string;
  publicKey: JsonWebKey;
  instanceId: string;
  agentType: string;
  runtime: { name: string; version: string | null };
  provider: string | null;
  model: string | null;
  sessionId: string;
  origin: string;
  room: string;
  capabilities: string[];
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface InstanceBinding {
  type: "ai-auth-instance-binding";
  v: 1;
  instanceId: string;
  walletId: string;
  publicKey: JsonWebKey;
  issuedAt: number;
  signature: string;
}

type SigningWallet = { publicKey: JsonWebKey; privateKey: CryptoKey };

export type AgentDescriptorVerification =
  | {
      ok: true;
      walletId: string;
      instanceId: string;
      sessionId: string;
      /** Self-declared; not attested. */
      claims: Readonly<{
        agentType: string;
        runtime: Readonly<{ name: string; version: string | null }>;
        provider: string | null;
        model: string | null;
      }>;
      expiresAt: number;
    }
  | { ok: false; reason: string };

export interface CloneDiagnostic {
  code: "clone-suspected";
  reason:
    | "wallet-multiple-instances"
    | "instance-multiple-sessions"
    | "instance-wallet-mismatch";
  walletId: string;
  instanceId: string;
}

export interface CloneDetector {
  observe(verified: {
    walletId: string;
    instanceId: string;
    sessionId: string;
    expiresAt: number;
  }): readonly CloneDiagnostic[];
  release(instanceId: string, sessionId: string): void;
  diagnostics(): readonly CloneDiagnostic[];
}

export const AGENT_DESCRIPTOR_TYPE: "ai-auth-agent-descriptor";
export const AGENT_DESCRIPTOR_VERSION: 1;
export const INSTANCE_BINDING_TYPE: "ai-auth-instance-binding";
export const AGENT_PROTOCOL_VERSION: 1;
export const MAX_DESCRIPTOR_TTL_MS: number;
export const DEFAULT_DESCRIPTOR_TTL_MS: number;

export function createInstanceId(): string;
export function bindInstance(
  wallet: SigningWallet,
  instanceId: string,
  options?: { now?: number },
): Promise<Readonly<InstanceBinding>>;
export function verifyInstanceBinding(
  binding: unknown,
): Promise<
  | { ok: true; walletId: string; instanceId: string }
  | { ok: false; reason: string }
>;
export function createAgentDescriptor(
  wallet: SigningWallet,
  options: {
    instanceId: string;
    agentType: string;
    runtime: AgentRuntime;
    provider?: string | null;
    model?: string | null;
    sessionId: string;
    origin: string;
    room: string;
    capabilities?: string[];
    nonce: string;
    expiresAt?: number;
    ttlMs?: number;
    now?: number;
  },
): Promise<Readonly<AgentDescriptor>>;
export function verifyAgentDescriptor(
  descriptor: unknown,
  options: {
    expectedOrigin: string;
    expectedRoom: string;
    expectedNonce: string;
    now?: number | (() => number);
  },
): Promise<AgentDescriptorVerification>;
export function createCloneDetector(options?: {
  now?: () => number;
}): CloneDetector;
