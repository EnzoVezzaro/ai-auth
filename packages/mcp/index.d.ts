import type { ZodType } from "zod";

export interface AIAuthMcpWallet {
  id: string;
  publicKey?: JsonWebKey;
  sign(type: string, payload: unknown): Promise<unknown>;
}

export interface AIAuthMcpAction {
  name: string;
  description: string;
  inputSchema: Record<string, ZodType>;
  requiredCapability: string;
  readOnly?: boolean;
  execute(input: Record<string, unknown>): unknown | Promise<unknown>;
}

export interface AIAuthMcpServerOptions {
  wallet: AIAuthMcpWallet;
  actions: AIAuthMcpAction[];
  approveCapabilities: (
    requested: string[],
    identity: { id: string; publicKey?: JsonWebKey },
  ) => string[] | Promise<string[]>;
  publishEvent?: (envelope: unknown) => unknown | Promise<unknown>;
  name?: string;
  version?: string;
}

export interface AIAuthMcpServerResult {
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
  capabilities: readonly string[];
  wallet: { id: string; publicKey?: JsonWebKey };
}

export declare function createAIAuthMcpServer(
  options: AIAuthMcpServerOptions,
): Promise<AIAuthMcpServerResult>;

export declare function connectAIAuthMcpStdio(
  server: AIAuthMcpServerResult["server"],
): Promise<
  import("@modelcontextprotocol/sdk/shared/stdio.js").StdioServerTransport
>;
