export const DISCOVERY_TYPE: "ai-auth-discovery";
export const DISCOVERY_VERSION: 1;
export const DISCOVERY_PATH: "/.well-known/ai-auth.json";
export const MAX_DISCOVERY_BYTES: number;
export const DISCOVERY_TIMEOUT_MS: number;
export const DISCOVERY_CAPABILITIES: readonly string[];

export interface DiscoveryDocument {
  type: "ai-auth-discovery";
  v: 1;
  /** Must equal the origin the document was fetched from. */
  origin: string;
  name?: string;
  walletUrl?: string;
  docsUrl?: string;
  capabilities?: string[];
  rooms?: { name: string; mode: "open" | "restricted" }[];
  /** Wallet ids the site says it trusts as membership issuers (a claim). */
  issuers?: string[];
  webmcp?: boolean;
}

export type DiscoveryResult =
  | { ok: true; discovery: Readonly<DiscoveryDocument> }
  | { ok: false; reason: string };

export function normalizeOrigin(value: unknown): string;
export function validateDiscovery(
  doc: unknown,
  options: { origin: string },
): DiscoveryResult;
export function fetchDiscovery(
  origin: string,
  options?: {
    fetch?: typeof fetch;
    maxBytes?: number;
    timeoutMs?: number;
  },
): Promise<DiscoveryResult>;
