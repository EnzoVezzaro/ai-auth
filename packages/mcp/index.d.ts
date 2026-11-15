export interface AIAuthMcpWallet {
  id: string;
  publicKey?: JsonWebKey;
  sign(type: string, payload: unknown): Promise<unknown>;
}

export interface AIAuthMcpSession {
  token: string;
  session: {
    id: string;
    agentId: string;
    capabilities: string[];
    expiresAt: number;
  };
}

export interface AIAuthMcpServiceClient {
  authenticate(
    wallet: AIAuthMcpWallet,
    requestedCapabilities: string[],
    approvedCapabilities: string[],
  ): Promise<AIAuthMcpSession>;
  createTenant?(session: AIAuthMcpSession, name: string): Promise<unknown>;
  createInvitation?(
    session: AIAuthMcpSession,
    wallet: AIAuthMcpWallet,
    input: {
      tenantId: string;
      recipient: string;
      capabilities: string[];
      expiresAt: number;
    },
  ): Promise<unknown>;
  joinTenant?(
    session: AIAuthMcpSession,
    tenantId: string,
    grant: unknown,
  ): Promise<unknown>;
  listMessages?(
    session: AIAuthMcpSession,
    tenantId: string,
    room: string,
  ): Promise<unknown>;
  sendMessage?(
    session: AIAuthMcpSession,
    tenantId: string,
    room: string,
    body: string,
  ): Promise<unknown>;
}

export interface AIAuthMcpServerOptions {
  serviceClient: AIAuthMcpServiceClient;
  wallet: AIAuthMcpWallet;
  requestedCapabilities: string[];
  approveCapabilities: (
    requested: string[],
    identity: { id: string; publicKey?: JsonWebKey },
  ) => string[] | Promise<string[]>;
  name?: string;
  version?: string;
}

export interface AIAuthMcpServerResult {
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
  session: AIAuthMcpSession;
}

export declare function createAIAuthMcpServer(
  options: AIAuthMcpServerOptions,
): Promise<AIAuthMcpServerResult>;

export declare function connectAIAuthMcpStdio(
  server: AIAuthMcpServerResult["server"],
): Promise<
  import("@modelcontextprotocol/sdk/shared/stdio.js").StdioServerTransport
>;
