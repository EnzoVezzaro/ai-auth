/** Protocol-neutral tool descriptor (REFERENCE_ARCHITECTURE.md §6). */
export interface UnifiedToolDescriptor {
  id: string;
  protocol: "mcp" | "webmcp" | "utcp";
  providerId: string;
  source: {
    origin?: string;
    endpoint?: string;
    page?: string;
  };
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  capabilities: string[];
  risk: {
    sideEffect: "read" | "write" | "consequential";
    untrustedContent: boolean;
  };
  audience?: {
    origins?: string[];
    walletIds?: string[];
  };
  requiredAuthorization: {
    kind: "owner" | "site" | "native" | "none";
    detail?: string;
  };
  availability: "online" | "offline" | "expired" | "unknown";
  /** Raw expiry from the signed catalog, when present. */
  expiresAt?: number;
  /** Present when provenance could not be established. */
  provenance?: string;
  /** The original native descriptor, preserved verbatim. */
  native: Record<string, unknown>;
}

export interface ConversionOptions {
  capabilities?: string[];
  capability?: string;
  providerId?: string;
}

export interface WebMCPConversionOptions extends ConversionOptions {
  origin?: string;
}

export interface McpConversionOptions extends ConversionOptions {
  endpoint?: string;
}

export interface AgentToolConversionOptions extends ConversionOptions {
  manual?: string;
}

/** Convert a WebMCP page/agent catalog (array or `{ tools, ... }`) to descriptors. */
export function fromWebMCPCatalog(
  catalog: unknown,
  options?: WebMCPConversionOptions,
): UnifiedToolDescriptor[];

/** Convert an MCP tool array, action list, or `listTools()` result to descriptors. */
export function fromMcpCatalog(
  catalog: unknown,
  options?: McpConversionOptions,
): UnifiedToolDescriptor[];

/** Convert a signed agent tool-provider catalog to descriptors. */
export function fromAgentToolCatalog(
  catalog: unknown,
  options?: AgentToolConversionOptions,
): UnifiedToolDescriptor[];

/** Which descriptor builder is active: a helper export name or `local-fallback`. */
export function descriptorSource(): string;

export interface ToolProviderAdapter {
  readonly protocol: "mcp" | "webmcp" | "utcp";
  discover(): Promise<UnifiedToolDescriptor[]>;
  listTools(): Promise<UnifiedToolDescriptor[]>;
  getTool(id: string): Promise<UnifiedToolDescriptor | undefined>;
  close(): Promise<void>;
  // invoke/cancel/subscribe are intentionally absent: no native transport or
  // lifecycle guarantee is provided by this bridging layer.
}

export interface AdapterOptions
  extends
    WebMCPConversionOptions,
    McpConversionOptions,
    AgentToolConversionOptions {
  /** Re-read the catalog on each discover/listTools call. */
  refresh?: () => unknown;
  onClose?: () => void | Promise<void>;
}

export function createWebMCPAdapter(
  catalog: unknown | (() => unknown),
  options?: AdapterOptions,
): ToolProviderAdapter;

export function createMcpAdapter(
  catalog: unknown | (() => unknown),
  options?: AdapterOptions,
): ToolProviderAdapter;

export function createAgentToolAdapter(
  catalog: unknown | (() => unknown),
  options?: AdapterOptions,
): ToolProviderAdapter;

export function createProviderAdapter(
  config: {
    protocol: "mcp" | "webmcp" | "utcp" | "agent";
    catalog: unknown | (() => unknown);
  } & AdapterOptions,
): ToolProviderAdapter;
