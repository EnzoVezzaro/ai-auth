export interface SignedEnvelope<T = unknown> {
  body: {
    protocol: "ai-auth-wallet";
    version: 1;
    type: string;
    issuer: string;
    createdAt: string;
    payload: T;
  };
  proof: {
    algorithm: "ECDSA-P256-SHA256";
    publicKey: JsonWebKey;
    signature: string;
  };
}

export interface WalletIdentity {
  id: string;
  name: string;
  createdAt: string;
  publicKey: JsonWebKey;
  privateKey: CryptoKey;
  backup: string;
  sign<T>(type: string, payload: T): Promise<SignedEnvelope<T>>;
}

export interface PermissionRequest {
  type: "ai-auth/permission-request";
  version: 1;
  audience: string;
  nonce: string;
  createdAt: number;
  expiresAt: number;
  capabilities: string[];
  room?: string;
}

export function canonicalize(value: unknown): string;
export function randomNonce(): string;
export function identityFor(publicKey: JsonWebKey): Promise<string>;
export function createWallet(options: {
  name: string;
  passphrase: string;
}): Promise<WalletIdentity>;
export function loadWallet(): Promise<WalletIdentity | null>;
export function importWalletBackup(
  text: string,
  passphrase: string,
): Promise<WalletIdentity>;
export function forgetWallet(): Promise<void>;
export function downloadBackup(wallet: WalletIdentity): string;
export function signEnvelope<T>(
  identity: WalletIdentity,
  type: string,
  payload: T,
): Promise<SignedEnvelope<T>>;
export function verifyEnvelope<T>(
  envelope: SignedEnvelope<T>,
  options?: { expectedIssuer?: string; now?: number; maxAgeMs?: number },
): Promise<boolean>;
export function appendActivity<T>(
  wallet: WalletIdentity,
  type: string,
  payload: T,
): Promise<SignedEnvelope<T>>;
export function readActivity(): Promise<Array<SignedEnvelope>>;
export const MAX_EVENT_AGE_MS: number;
export const MAX_SEEN_EVENTS: number;

export class NonceGuard {
  consume(nonce: string, expiresAt: number, now?: number): boolean;
}
export function createPermissionRequest(
  origin: string,
  capabilities: string[],
  options?: { expiresInMs?: number; room?: string },
): Promise<PermissionRequest>;
export function approvePermissionRequest(
  wallet: WalletIdentity,
  request: PermissionRequest,
  approvedCapabilities: string[],
): Promise<
  SignedEnvelope<{
    audience: string;
    requestNonce: string;
    capabilities: string[];
    expiresAt: number;
    room?: string;
  }>
>;
export function verifyPermissionRequest(
  request: PermissionRequest,
  options: { expectedOrigin: string; now?: number; nonceGuard?: NonceGuard },
): Promise<boolean>;
export function verifyPopupPermissionRequest(
  event: MessageEvent,
  expectedSource: MessageEventSource | null,
  options?: { now?: number },
): Promise<boolean>;
export function verifyPermissionConsent(
  consent: SignedEnvelope,
  request: PermissionRequest,
  options: {
    expectedOrigin: string;
    expectedWallet: string;
    now?: number;
    nonceGuard?: NonceGuard;
  },
): Promise<boolean>;

export interface CapabilityGrant {
  body: SignedEnvelope["body"] & {
    type: "capability/grant";
    payload: {
      recipient: string;
      resource: string;
      capabilities: string[];
      grantId: string;
      issuedAt: number;
      expiresAt: number;
    };
  };
  proof: SignedEnvelope["proof"];
}
export function createCapabilityGrant(
  issuerWallet: WalletIdentity,
  input: {
    recipient: string;
    resource: string;
    capabilities: string[];
    expiresAt: number;
  },
): Promise<CapabilityGrant>;
export function verifyCapabilityGrant(
  grant: CapabilityGrant,
  options: {
    expectedIssuer: string;
    expectedRecipient: string;
    resource: string;
    requiredCapability: string;
    now?: number;
  },
): Promise<boolean>;

export class P2PRoom {
  constructor(
    wallet: WalletIdentity,
    room: string,
    options?: {
      privateMode?: boolean;
      origin?: string;
      capabilities?: string[] | null;
    },
  );
  readonly peers: Map<
    string,
    {
      id: string;
      session: string;
      name: string;
      publicKey: JsonWebKey;
      seenAt: number;
    }
  >;
  subscribe(
    listener: (event: {
      direction: string;
      envelope?: SignedEnvelope;
      peer?: unknown;
      message?: string;
    }) => void,
  ): () => void;
  start(): Promise<this>;
  send<T>(type: string, payload?: T): Promise<SignedEnvelope>;
  receive(envelope: SignedEnvelope, source?: object): Promise<boolean>;
  attach(channel: RTCDataChannel, peer?: object): RTCDataChannel;
  close(): Promise<void>;
}

export class ManualWebRTC {
  constructor(room: P2PRoom, options?: { iceServers?: RTCIceServer[] });
  offer(): Promise<string>;
  answer(offerText: string): Promise<string>;
  finish(answerText: string): Promise<void>;
  close(): void;
}

export function createSharedRoomTopic(
  origin: string,
  room: string,
): Promise<string>;

export class NostrWebRTC {
  constructor(
    room: P2PRoom,
    options?: {
      origin?: string;
      room?: string;
      relayUrls?: string[];
      onStatus?: (status: string) => void;
      onDiagnostic?: (event: {
        stage: string;
        type?: string;
        peerId?: string;
      }) => void;
      joinRoom?: (...args: unknown[]) => unknown;
    },
  );
  start(): Promise<this>;
  close(): Promise<void>;
}

export interface AIAuthPageConnection {
  readonly request: PermissionRequest;
  readonly consent: SignedEnvelope<{
    audience: string;
    requestNonce: string;
    capabilities: string[];
    expiresAt: number;
    room?: string;
  }>;
  readonly capabilities: readonly string[];
  onEvent(listener: (event: SignedEnvelope) => void): () => void;
  publishAction(action: {
    name: string;
    state: "started" | "progress" | "completed" | "failed" | "needs-human";
    summary: string;
  }): void;
  publishCursor(cursor: { x: number; y: number; visible?: boolean }): void;
  close(): void;
}

export function connectAIAuthPopup(options: {
  walletUrl: string;
  capabilities: string[];
  room?: string;
  origin?: string;
  timeoutMs?: number;
  windowObject?: Window;
}): Promise<AIAuthPageConnection>;

export function mountAIAuthCollaboration(
  connection: AIAuthPageConnection,
  options?: { target?: HTMLElement },
): () => void;

export interface AIAuthPageAction {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: "object"; properties: object };
  requiredCapability: "tools.invoke";
  readOnly?: boolean;
  execute(
    input: unknown,
    context: { signal?: AbortSignal },
  ): Promise<unknown> | unknown;
}

export function registerAIAuthPageActions(options: {
  actions: AIAuthPageAction[];
  connection: AIAuthPageConnection;
  modelContext?: { registerTool?: Function };
  signal?: AbortSignal;
  publishAction?: (event: {
    name: string;
    capability: string;
    state: string;
    summary: string;
  }) => Promise<void> | void;
}): Promise<{
  webMcpAvailable: boolean;
  tools: readonly string[];
  execute(
    name: string,
    input?: unknown,
    context?: { signal?: AbortSignal },
  ): Promise<unknown>;
  close(): void;
}>;
