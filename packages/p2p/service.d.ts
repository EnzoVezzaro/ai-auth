import type { CapabilityGrant, WalletIdentity } from "./index.js";

export class AIAuthServiceError extends Error {
  status: number;
  details: unknown;
}

export interface ServiceSession {
  token: string;
  session: {
    id: string;
    agentId: string;
    capabilities: string[];
    expiresAt: number;
  };
}

export interface PresenceReconnectOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  maxReconnectAttempts?: number;
}

export interface AIAuthPresenceConnection {
  readonly connected: boolean;
  sendPresence(status?: "online" | "busy"): boolean;
  sendMessage(body: string): boolean;
  close(): void;
}

export function createServiceClient(options: {
  baseUrl: string;
  audience?: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
}): {
  authenticate(
    wallet: WalletIdentity,
    capabilities: string[],
    approvedCapabilities: string[],
  ): Promise<ServiceSession>;
  createTenant(
    session: ServiceSession,
    name: string,
  ): Promise<{ tenant: { tenantId: string; ownerAgentId: string } }>;
  createInvitation(
    session: ServiceSession,
    wallet: WalletIdentity,
    input: {
      tenantId: string;
      recipient: string;
      capabilities: string[];
      expiresAt: number;
    },
  ): Promise<CapabilityGrant>;
  joinTenant(
    session: ServiceSession,
    tenantId: string,
    grant: CapabilityGrant,
  ): Promise<unknown>;
  listMessages(
    session: ServiceSession,
    tenantId: string,
    room: string,
  ): Promise<{ messages: unknown[] }>;
  sendMessage(
    session: ServiceSession,
    tenantId: string,
    room: string,
    body: string,
  ): Promise<unknown>;
  connectPresence(
    session: ServiceSession,
    tenantId: string,
    room: string,
    onEvent: (event: unknown) => void,
  ): WebSocket;
  connectPresenceResilient(
    session: ServiceSession,
    tenantId: string,
    room: string,
    onEvent: (event: unknown) => void,
    options?: PresenceReconnectOptions,
  ): AIAuthPresenceConnection;
};
