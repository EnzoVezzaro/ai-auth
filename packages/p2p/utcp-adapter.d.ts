/** A protocol-neutral tool descriptor (REFERENCE_ARCHITECTURE.md §6). */
export interface UnifiedToolDescriptor {
  readonly id: string; // "utcp:<manual>:<tool>"
  readonly protocol: "mcp" | "webmcp" | "utcp";
  readonly providerId: string;
  readonly source: {
    readonly origin?: string;
    readonly endpoint?: string;
    readonly page?: string;
  };
  readonly name: string;
  readonly title?: string;
  readonly description: string; // untrusted text
  readonly inputSchema: object;
  readonly outputSchema?: object;
  readonly capabilities: string[];
  readonly risk: {
    readonly sideEffect: "read" | "write" | "consequential";
    readonly untrustedContent: boolean;
  };
  readonly audience?: {
    readonly origins?: string[];
    readonly walletIds?: string[];
  };
  readonly requiredAuthorization: {
    readonly kind: "owner" | "site" | "native" | "none";
    readonly detail?: string;
  };
  readonly availability: "online" | "offline" | "expired" | "unknown";
  /** The original native descriptor, preserved verbatim and never weakened. */
  readonly native: object;
}

export interface InvocationContext {
  readonly requestId?: string;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly timeoutMs?: number;
  readonly stream?: boolean;
  /** AI Auth authorization. Checked for expiry; never forwarded as a provider credential. */
  readonly authorization?: {
    readonly valid?: boolean;
    readonly expired?: boolean;
    readonly expiresAt?: number | string;
    readonly exp?: number;
  } | null;
  readonly expiresAt?: number | string;
  readonly request?: unknown;
  readonly origin?: string;
  readonly [key: string]: unknown;
}

export interface InvocationResult {
  readonly protocol: "utcp";
  readonly toolId: string;
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly nativeCode?: string;
  };
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  /** The official SDK has no verified cancellation API. */
  readonly nativeCallMayStillRun?: boolean;
  readonly nativeCancellationSupported: false;
  readonly native: object;
}

export interface UtcpManual {
  readonly id?: string;
  readonly name?: string;
  readonly url?: string;
  readonly manualUrl?: string;
  readonly [key: string]: unknown;
}

/** Minimal shape of an injected/lazily-imported official UTCP client. */
export interface UtcpClientLike {
  registerManual(template: unknown): Promise<unknown> | unknown;
  getTools(): Promise<unknown[]>;
  searchTools?(query: string): Promise<unknown[]>;
  callTool(name: string, args: unknown, options?: unknown): Promise<unknown>;
  callToolStreaming?(
    name: string,
    args: unknown,
    options?: unknown,
  ): Promise<unknown>;
  deregisterManual?(name: string): Promise<unknown> | unknown;
}

export interface UtcpAdapterOptions {
  /** Manuals to register. Each needs a url or manualUrl. */
  readonly manuals?: readonly UtcpManual[];
  /** Injected client (tests / environments without the optional dependency). */
  readonly client?: UtcpClientLike;
  /** Async alternative to `client`: `({ adapter, manuals, sdkConfig }) => client`. */
  readonly clientFactory?: (args: {
    readonly adapter: UtcpAdapter;
    readonly manuals: readonly UtcpManual[];
    readonly sdkConfig: Record<string, unknown>;
  }) => Promise<UtcpClientLike> | UtcpClientLike;
  /** Allowed hosts, origins (with scheme) or `(url, ctx) => boolean`. Deny by default when set. */
  readonly allowlist?:
    readonly string[] | ((url: URL, context: unknown) => boolean);
  /** Resolve a hostname to IP addresses. Defaults to node:dns lookup(all). */
  readonly resolver?: (hostname: string) => Promise<string[]>;
  /** Preflight redirect containment. Defaults to global fetch with redirect: 'manual'. */
  readonly redirectFetch?: (url: string, init: unknown) => Promise<unknown>;
  /** Provider-native credentials keyed by manual namespace. Never AI Auth grants. */
  readonly credentials?: Record<string, unknown>;
  readonly capabilities?: readonly string[];
  readonly maxRedirects?: number;
  readonly deadlineMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxErrorChars?: number;
  readonly sdkModuleName?: string;
  readonly sdkConfig?: Record<string, unknown>;
  /** Optional worker B descriptor helper injection. */
  readonly descriptorBuilder?: (
    descriptor: UnifiedToolDescriptor,
  ) => UnifiedToolDescriptor | Promise<UnifiedToolDescriptor>;
  /** Attempt `buildToolDescriptor` from ./tool-descriptor.js (off by default). */
  readonly useSharedDescriptorBuilder?: boolean;
  readonly resolveManualForTool?: (
    tool: unknown,
    manuals: readonly UtcpManual[],
  ) => UtcpManual | undefined;
}

export interface UtcpAdapter {
  readonly protocol: "utcp";
  readonly nativeCancellationSupported: false;
  discover(): Promise<UnifiedToolDescriptor[]>;
  listTools(query?: string): Promise<UnifiedToolDescriptor[]>;
  getTool(id: string): Promise<UnifiedToolDescriptor | undefined>;
  invoke(
    id: string,
    args: unknown,
    ctx?: InvocationContext,
  ): Promise<InvocationResult>;
  cancel(requestId: string): Promise<void>;
  close(): Promise<void>;
}

export const UTCP_ERROR_CODES: Readonly<Record<string, string>>;

export function createUtcpAdapter(options?: UtcpAdapterOptions): UtcpAdapter;
export default createUtcpAdapter;

export function toolError(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Error & { code: string };
export function buildUtcpToolId(manual: string, tool: string): string;
export function parseUtcpToolId(
  id: string,
): { manual: string; tool: string } | null;
export function classifyUtcpAddress(address: string): string;
export function checkUtcpDestination(
  rawUrl: string,
  options?: {
    allowLoopback?: boolean;
    allowlist?: UtcpAdapterOptions["allowlist"];
    resolver?: (hostname: string) => Promise<string[]>;
    context?: unknown;
  },
): Promise<{ url: URL; addresses: string[]; loopback: boolean }>;
export function checkUtcpAuthorization(ctx?: InvocationContext): void;
export function boundUtcpOutput(value: unknown, maxBytes?: number): unknown;
