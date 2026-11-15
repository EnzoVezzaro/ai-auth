export interface AIAuthEvent {
  version: number;
  type: string;
  eventId?: string;
  timestamp?: string;
  siteId?: string;
  roomId?: string;
  agentId?: string;
  [key: string]: unknown;
}

export interface AIAuthClient {
  init(options?: {
    baseUrl?: string;
    site?: string;
    token?: string;
    room?: string;
    autoConnect?: boolean;
  }): AIAuthClient;
  destroy(): void;
  agent: {
    joinRoom(room: string): Promise<{ room: string }>;
    setStatus(status: "online" | "working" | "idle" | "away"): Promise<unknown>;
    setActivity(activity: string): Promise<unknown>;
    whoami(): Promise<unknown>;
  };
  presence: {
    subscribe(callback: (event: AIAuthEvent) => void): () => boolean;
    list(room?: string): Promise<unknown>;
  };
  collaboration: {
    sendMessage(message: string, room?: string): Promise<unknown>;
    requestHandoff(
      description: string,
      assigneeId?: string,
      room?: string,
    ): Promise<unknown>;
    acquireLock(
      resource: string,
      leaseSeconds?: number,
      room?: string,
    ): Promise<unknown>;
    releaseLock(resource: string, room?: string): Promise<unknown>;
  };
  analytics: {
    track(name: string, properties?: Record<string, unknown>): Promise<unknown>;
  };
  webmcp: {
    registerTool(
      tool: {
        name: string;
        title?: string;
        description: string;
        inputSchema?: unknown;
        execute(
          input: unknown,
          context: { signal: AbortSignal },
        ): unknown | Promise<unknown>;
      },
      options?: Record<string, unknown>,
    ): Promise<{ native: boolean; name: string; dispose(): void }>;
    listTools(): Promise<unknown[]>;
    executeTool(name: string, input?: unknown): Promise<unknown>;
    readonly nativeAvailable: boolean;
  };
}

export const AIAuth: AIAuthClient;
export default AIAuth;
