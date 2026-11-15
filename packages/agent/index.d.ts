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
  readonly capabilities: readonly string[];
  readonly origin: string;
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
export declare class NodeRTCPeerConnection {
  constructor(configuration?: unknown);
}
export declare function withNodeRtc<
  T extends (config: any, topic: string) => any,
>(joinRoom: T): T;
