import type { ConnectionSnapshot } from "@enzovezzaro/ai-auth-wallet";

export interface AgentWallet {
  readonly id: string;
  readonly name: string;
  readonly instanceId: string;
  readonly publicKey: JsonWebKey;
  sign(type: string, payload: unknown): Promise<unknown>;
}

export type KeystoreErrorCode =
  | "KEYSTORE_CORRUPT"
  | "KEYSTORE_EXISTS"
  | "KEYSTORE_MISSING"
  | "KEYSTORE_PASSPHRASE"
  | "KEYSTORE_PERMISSIONS"
  | "KEYSTORE_UNAVAILABLE"
  | "KEYSTORE_UNLOCK_FAILED";

export declare class KeystoreError extends Error {
  readonly code: KeystoreErrorCode;
}

export interface FileKeystoreOptions {
  dir: string;
  /** Passphrase or async supplier; otherwise AI_AUTH_PASSPHRASE, then a TTY prompt. */
  passphrase?: string | (() => string | Promise<string>);
  env?: Record<string, string | undefined>;
  prompt?: (question: string) => Promise<string>;
}

export interface FileKeystore {
  readonly dir: string;
  readonly file: string;
  exists(): Promise<boolean>;
  create(options?: { name?: string }): Promise<AgentWallet>;
  unlock(): Promise<AgentWallet>;
  rotate(options?: { name?: string }): Promise<AgentWallet>;
  backup(target: string): Promise<void>;
  restore(
    source: string,
    options?: { replace?: boolean },
  ): Promise<AgentWallet>;
  delete(): Promise<void>;
}

export declare function createFileKeystore(
  options: FileKeystoreOptions,
): FileKeystore;

export interface AgentRuntimeOptions {
  keystore: FileKeystore;
  origin: string;
  room?: string;
  capabilities: string[];
  descriptor?: { name?: string; [key: string]: unknown };
  relayUrls?: string[];
  participation?: unknown;
  stateFile?: string | null;
  leaseMs?: number;
  rejoinAfterMs?: number;
  backoff?: { baseMs?: number; maxMs?: number; maxAttempts?: number };
  onStatus?: (message: string) => void;
  joinRoom?: (config: unknown, topic: string) => unknown;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface AgentPeer {
  readonly id: string;
  readonly name: string;
  readonly session: string;
  readonly seenAt: number;
  readonly leaseExpiresAt: number;
  readonly stale: boolean;
}

export interface AgentRuntime {
  readonly connectionState: ConnectionSnapshot;
  readonly identity: AgentWallet | null;
  readonly room: string | null;
  /** Room facade accepted by createAIAuthAgentClient(). */
  readonly agentRoom: {
    readonly wallet?: { id: string };
    readonly session?: string;
    send(
      type: string,
      payload?: Record<string, unknown>,
      options?: { to?: string },
    ): Promise<unknown>;
    subscribe(
      listener: (message: { direction: string; envelope?: unknown }) => void,
    ): () => void;
  };
  readonly capabilities: readonly string[];
  readonly origin: string;
  /** Publishes tools this runtime executes itself. Requires tools.invoke. */
  provideTools(options: AgentToolProviderOptions): AgentToolProvider;
  onConnectionState(
    listener: (snapshot: ConnectionSnapshot) => void,
  ): () => void;
  onEvent(
    listener: (message: {
      direction: string;
      envelope?: unknown;
      peer?: unknown;
    }) => void,
  ): () => void;
  onError(listener: (error: Error) => void): () => void;
  onPeerStale(listener: (peer: Omit<AgentPeer, "stale">) => void): () => void;
  join(room?: string): Promise<ConnectionSnapshot>;
  resume(): Promise<boolean>;
  peers(): AgentPeer[];
  send(
    type: string,
    payload?: Record<string, unknown>,
    options?: { to?: string },
  ): Promise<unknown>;
  checkLeases(): Promise<void>;
  leave(): Promise<void>;
  close(): Promise<void>;
}

export declare function createAgentRuntime(
  options: AgentRuntimeOptions,
): AgentRuntime;

export interface AgentToolDefinition {
  /** Lowercase name such as `notes.search`. */
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler(
    input: Record<string, unknown>,
    context: { signal: AbortSignal; requester: string },
  ): unknown | Promise<unknown>;
}

export interface AgentToolProviderOptions {
  tools: AgentToolDefinition[];
  /** Required: return true only for peers the owner has explicitly allowed. */
  authorize(
    requesterId: string,
    name: string,
    input: Record<string, unknown>,
  ): boolean | Promise<boolean>;
  refreshMs?: number;
  timeoutMs?: number;
}

export interface AgentToolProvider {
  readonly tools: string[];
  /** Publishes the catalog again, for example after a reconnect. */
  announce(): void;
  /** Withdraws every tool from the room. */
  close(): void;
}

export declare function createToolProvider(
  options: {
    room: AgentRuntime["agentRoom"];
  } & AgentToolProviderOptions,
): AgentToolProvider;
export declare class NodeRTCPeerConnection {
  constructor(configuration?: unknown);
}
export declare function withNodeRtc<
  T extends (config: any, topic: string) => any,
>(joinRoom: T): T;
