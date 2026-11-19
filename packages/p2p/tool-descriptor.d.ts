export type Protocol = "mcp" | "webmcp" | "utcp";
export type SideEffect = "read" | "write" | "consequential";
export type AuthorizationKind = "owner" | "site" | "native" | "none";
export type Availability = "online" | "offline" | "expired" | "unknown";

export interface ToolSource {
  origin?: string;
  endpoint?: string;
  page?: string;
}

export interface ToolRisk {
  sideEffect: SideEffect;
  untrustedContent: boolean;
}

export interface ToolAudience {
  origins?: string[];
  walletIds?: string[];
}

export interface RequiredAuthorization {
  kind: AuthorizationKind;
  detail?: string;
}

export interface ToolDescriptorInput {
  id?: string;
  protocol: Protocol;
  providerId: string;
  name: string;
  source?: ToolSource;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  capabilities?: string[];
  risk: ToolRisk;
  audience?: ToolAudience;
  requiredAuthorization?: RequiredAuthorization;
  availability?: Availability;
  /** Original provider descriptor, preserved verbatim; never weakened. */
  native: Record<string, unknown>;
}

export interface UnifiedToolDescriptor {
  readonly id: string;
  readonly protocol: Protocol;
  readonly providerId: string;
  readonly source: ToolSource | undefined;
  readonly name: string;
  readonly title: string | undefined;
  /** Untrusted text. Data only, never an instruction or permission source. */
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown> | undefined;
  readonly capabilities: readonly string[];
  readonly risk: ToolRisk;
  readonly audience: ToolAudience | undefined;
  readonly requiredAuthorization: RequiredAuthorization;
  readonly availability: Availability;
  readonly native: Record<string, unknown>;
}

export interface ToolIdParts {
  protocol: Protocol;
  providerId: string;
  name: string;
}

export const PROTOCOLS: readonly Protocol[];
export const SIDE_EFFECTS: readonly SideEffect[];
export const AUTHORIZATION_KINDS: readonly AuthorizationKind[];
export const AVAILABILITIES: readonly Availability[];
export const TOOL_ID_SEPARATOR: ":";
export const LIMITS: Readonly<{
  MAX_NAME_LENGTH: number;
  MAX_PROVIDER_ID_LENGTH: number;
  MAX_TITLE_LENGTH: number;
  MAX_DESCRIPTION_LENGTH: number;
  MAX_DETAIL_LENGTH: number;
  MAX_SOURCE_FIELD_LENGTH: number;
  MAX_CAPABILITIES: number;
  MAX_ORIGINS: number;
  MAX_WALLET_IDS: number;
  MAX_ORIGIN_LENGTH: number;
  MAX_SCHEMA_BYTES: number;
}>;

export function isProtocol(value: unknown): value is Protocol;
export function isSideEffect(value: unknown): value is SideEffect;
export function isAuthorizationKind(value: unknown): value is AuthorizationKind;
export function isAvailability(value: unknown): value is Availability;
export function isValidToolName(value: unknown): boolean;
export function isValidProviderId(value: unknown): boolean;
export function isWalletId(value: unknown): boolean;

export function makeToolId(parts: ToolIdParts): string;
export function parseToolId(id: string): ToolIdParts | null;

/** Classify native auth without synthesizing capabilities. */
export function authorizationFromNative(
  native: Record<string, unknown>,
): RequiredAuthorization;

export function validateToolDescriptor(
  input: ToolDescriptorInput,
): UnifiedToolDescriptor;
export const buildToolDescriptor: typeof validateToolDescriptor;
export function isToolDescriptor(
  value: unknown,
): value is UnifiedToolDescriptor;
