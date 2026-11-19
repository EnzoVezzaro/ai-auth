import type {
  Protocol,
  ToolDescriptorInput,
  ToolRisk,
  UnifiedToolDescriptor,
} from "./tool-descriptor.js";

export interface AuditRecord {
  readonly caller: string;
  readonly providerId: string;
  readonly protocol: string;
  readonly toolId: string;
  readonly decision: "allow" | "deny";
  readonly outcome: string;
  readonly timestamp: number;
}

/** Minimal structural contract the registry needs from an audit sink. */
export interface ToolAuditLike {
  record(entry: {
    caller?: unknown;
    providerId?: unknown;
    protocol?: unknown;
    toolId: unknown;
    decision: "allow" | "deny";
    outcome?: unknown;
  }): unknown;
  list(): readonly AuditRecord[];
}

export interface InvocationContext {
  caller?: string;
  origin?: string;
  approvedCapabilities?: readonly string[];
  ownerApproved?: boolean;
  siteApproved?: boolean;
  nativeAuthorized?: boolean;
  [key: string]: unknown;
}

export interface MatchResult {
  ok: boolean;
  reason: string;
}

export interface GateResult {
  allowed: boolean;
  decision: "allow" | "deny";
  reason: string;
  toolId: string;
}

/** Safe metadata only: no description, native descriptor, args or payloads. */
export interface PolicyContext {
  readonly toolId: string;
  readonly protocol: Protocol;
  readonly providerId: string;
  readonly caller: string | undefined;
  readonly origin: string | undefined;
  readonly capabilities: readonly string[];
  readonly risk: ToolRisk;
  readonly requiredAuthorization: UnifiedToolDescriptor["requiredAuthorization"];
  readonly approvedCapabilities: readonly string[];
  readonly matched: boolean;
}

export type PolicyVerdict = boolean | { allow: boolean; reason?: string };
export type PolicyHook = (
  context: PolicyContext,
) => PolicyVerdict | Promise<PolicyVerdict>;

export interface RegistryFilter {
  protocol?: Protocol;
  providerId?: string;
  origin?: string;
  endpoint?: string;
  page?: string;
}

export interface SourceRecord {
  readonly toolId: string;
  readonly protocol: Protocol;
  readonly providerId: string;
  readonly origin: string | undefined;
  readonly endpoint: string | undefined;
  readonly page: string | undefined;
}

export const DENY_REASONS: Readonly<{
  OK: "ok";
  NOT_FOUND: "tool-not-found";
  EXPIRED: "tool-expired";
  UNAVAILABLE: "tool-unavailable";
  CAPABILITY_DENIED: "capability-denied";
  AUTH_REQUIRED: "authorization-required";
  AUDIENCE_DENIED: "audience-denied";
  POLICY_DENIED: "policy-denied";
  POLICY_ERROR: "policy-error";
}>;

export const ALLOW_ALL_POLICY: PolicyHook;
export const denyByDefault: PolicyHook;

export interface ToolRegistry {
  readonly audit: ToolAuditLike;
  register(
    descriptor: UnifiedToolDescriptor | ToolDescriptorInput,
  ): UnifiedToolDescriptor;
  unregister(id: string): boolean;
  get(id: string): UnifiedToolDescriptor | undefined;
  list(filter?: RegistryFilter): UnifiedToolDescriptor[];
  sources(): SourceRecord[];
  match(id: string, ctx?: InvocationContext): MatchResult;
  invokeGate(id: string, ctx?: InvocationContext): Promise<GateResult>;
}

export function createToolRegistry(options?: {
  audit?: ToolAuditLike;
  policy?: PolicyHook;
}): ToolRegistry;
