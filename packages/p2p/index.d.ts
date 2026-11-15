import type { ConnectionSnapshot } from "./connection-state.js";
import type {
  MembershipProof,
  ParticipationPolicy,
  RoomMode,
} from "./membership.js";

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
  options?: {
    sessionTtlMs?: number;
    idleTimeoutMs?: number;
    previousConsent?: SignedEnvelope;
    /** Attach a signed agent descriptor (v2 requests only). Claims, not attestations. */
    agent?: {
      instanceId: string;
      agentType: string;
      runtime: { name: string; version?: string | null };
      provider?: string | null;
      model?: string | null;
    };
    now?: number;
  },
): Promise<
  SignedEnvelope<{
    audience: string;
    requestNonce: string;
    capabilities: string[];
    expiresAt: number;
    room?: string;
    agentDescriptor?: import("./agent-identity.js").AgentDescriptor;
  }>
>;
export interface VerifiedParticipant {
  /** Verified: the key that signed the consent. */
  readonly identity: { readonly id: string };
  readonly instanceId: string;
  readonly sessionId: string;
  /** Self-declared by the agent. Not attested; never use for authorization. */
  readonly claims: Readonly<{
    agentType: string;
    runtime: Readonly<{ name: string; version: string | null }>;
    provider: string | null;
    model: string | null;
  }>;
  readonly claimsAttested: false;
}
export function verifyConsentAgent(
  consent: SignedEnvelope,
  request: PermissionRequest,
  options: { expectedOrigin: string; expectedWallet: string; now?: number },
): Promise<
  | { ok: true; participant: VerifiedParticipant | null }
  | { ok: false; reason: string }
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
      participation?: {
        policy: ParticipationPolicy;
        membership?: MembershipProof | null;
      };
    },
  );
  readonly participationMode: RoomMode;
  readonly disclosure: string | null;
  readonly wallet: WalletIdentity;
  readonly session: string;
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
  send<T>(
    type: string,
    payload?: T,
    options?: { to?: string | null },
  ): Promise<SignedEnvelope>;
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
  close(options?: { expired?: boolean }): Promise<void>;
  readonly connectionState: ConnectionSnapshot;
  onConnectionState(
    listener: (snapshot: ConnectionSnapshot) => void,
  ): () => void;
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
  readonly transfers: {
    sendText(text: string): Promise<void>;
    sendElement(metadata: Record<string, unknown>): Promise<void>;
    sendAttachment(
      blob: Blob,
      options: { kind: "screenshot" | "recording"; name: string },
    ): Promise<void>;
    subscribe(
      listener: (event: {
        type: "text" | "element" | "attachment";
        envelope: SignedEnvelope;
        text?: string;
        metadata?: Record<string, unknown>;
        blob?: Blob;
        kind?: string;
        name?: string;
        mime?: string;
        size?: number;
      }) => void,
    ): () => void;
    close(): void;
  };
  onEvent(listener: (event: SignedEnvelope) => void): () => void;
  readonly walletSession: string | null;
  onRoomReady(listener: (session: string) => void): () => void;
  publishAgentEvent(
    event:
      | {
          kind: "tool-catalog";
          tools: Array<{
            name: string;
            description: string;
            inputSchema: Record<string, unknown>;
          }>;
        }
      | {
          kind: "tool-response";
          requestId: string;
          toWallet: string;
          toSession: string;
          result?: unknown;
          error?: string;
        },
  ): void;
  publishAction(action: {
    name: string;
    state:
      | "started"
      | "progress"
      | "completed"
      | "failed"
      | "cancelled"
      | "needs-human";
    summary: string;
  }): void;
  publishCursor(cursor: {
    x: number;
    y: number;
    visible?: boolean;
    scroll?: number;
  }): void;
  readonly identity: { readonly id: string; readonly name: string | null };
  /** Verified identity plus the agent's self-declared claims, or null. */
  readonly participant: VerifiedParticipant | null;
  onLifecycle(listener: (event: AIAuthLifecycleEvent) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  close(reason?: "closed" | "expired"): void;
}

export interface AIAuthWalletIdentity {
  readonly id: string;
  readonly name: string | null;
}

export type AIAuthLifecycleEvent =
  | {
      type: "connected";
      label: string;
      identity: AIAuthWalletIdentity;
      participant?: VerifiedParticipant | null;
      diagnostics?: readonly import("./agent-identity.js").CloneDiagnostic[];
      capabilities: readonly string[];
      expiresAt: number;
    }
  | { type: "disconnected"; reason: "closed" | "expired" };

export function connectAIAuthModal(options: {
  walletUrl: string;
  capabilities: string[];
  room?: string;
  origin?: string;
  timeoutMs?: number;
  windowObject?: Window;
}): Promise<AIAuthPageConnection>;

/** @deprecated Use connectAIAuthModal. */
export const connectAIAuthPopup: typeof connectAIAuthModal;

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
    context: {
      signal?: AbortSignal;
      requester?: { id: string };
      requestId?: string;
    },
  ): Promise<unknown> | unknown;
}

export interface AIAuthPageActionContext {
  signal?: AbortSignal;
  requester?: { id: string };
  requestId?: string;
  sharedPublicly?: boolean;
}

export interface AIAuthWebMCPRegisteredTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  origin?: string;
  annotations?: Record<string, unknown>;
  window?: Window;
}

export function registerAIAuthPageActions(options: {
  actions?: AIAuthPageAction[];
  connection: AIAuthPageConnection;
  modelContext?: {
    registerTool?: Function;
    getTools?: (options?: {
      fromOrigins?: string[];
    }) => AIAuthWebMCPRegisteredTool[] | Promise<AIAuthWebMCPRegisteredTool[]>;
    executeTool?: (
      tool: AIAuthWebMCPRegisteredTool,
      input?: unknown,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };
  signal?: AbortSignal;
  authorize?: (
    action: AIAuthPageAction,
    input: unknown,
    context: AIAuthPageActionContext,
  ) => Promise<boolean | void> | boolean | void;
  publishAction?: (event: {
    name: string;
    capability: string;
    state: string;
    summary: string;
  }) => Promise<void> | void;
}): Promise<{
  webMcpAvailable: boolean;
  tools: readonly string[];
  actionsByName: ReadonlyMap<string, AIAuthPageAction>;
  execute(
    name: string,
    input?: unknown,
    context?: AIAuthPageActionContext,
  ): Promise<unknown>;
  close(): void;
}>;

export function mountAIAuthInPageAgent(options: {
  actions?: AIAuthPageAction[];
  connection: AIAuthPageConnection;
  modelContext?: {
    registerTool?: Function;
    getTools?: (options?: {
      fromOrigins?: string[];
    }) => AIAuthWebMCPRegisteredTool[] | Promise<AIAuthWebMCPRegisteredTool[]>;
    executeTool?: (
      tool: AIAuthWebMCPRegisteredTool,
      input?: unknown,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };
  signal?: AbortSignal;
  authorize: (
    action: AIAuthPageAction,
    input: unknown,
    context: AIAuthPageActionContext,
  ) => Promise<boolean | void> | boolean | void;
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
  stop(): void;
  close(): void;
}>;

export interface AIAuthAgentToolCatalog {
  readonly wallet: string;
  readonly session: string;
  readonly requestNonce: string;
  readonly expiresAt: number;
  readonly tools: ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }>;
}

export function createAIAuthAgentClient(
  room: Pick<P2PRoom, "send" | "subscribe" | "wallet" | "session">,
  options?: { timeoutMs?: number },
): {
  readonly catalogs: readonly AIAuthAgentToolCatalog[];
  onCatalog(listener: (catalog: AIAuthAgentToolCatalog) => void): () => void;
  publishCursor(cursor: {
    x: number;
    y: number;
    visible?: boolean;
    scroll?: number;
  }): Promise<SignedEnvelope>;
  publishAction(action: {
    name: string;
    state:
      | "started"
      | "progress"
      | "completed"
      | "failed"
      | "cancelled"
      | "needs-human";
    summary: string;
  }): Promise<SignedEnvelope>;
  callTool(
    catalog: AIAuthAgentToolCatalog,
    name: string,
    input?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  close(): void;
};

export interface AIAuthConnectInstruction {
  readonly protocol: "ai-auth-wallet";
  readonly version: 1;
  readonly siteName: string | null;
  readonly origin: string;
  readonly room: string;
  readonly walletUrl: string;
  readonly capabilities: readonly string[];
  /** Copyable connect text for any agent's browser page. */
  readonly instruction: string;
  /** Machine-readable descriptor of the same public connection details. */
  readonly json: string;
}

export function createAIAuthConnectInstruction(options: {
  siteOrigin: string;
  walletUrl: string;
  capabilities: readonly string[];
  room?: string;
  siteName?: string;
  sdkSource?: string;
}): AIAuthConnectInstruction;

export type AIAuthConnectPanelState =
  | { status: "idle"; error: string | null }
  | { status: "connecting" }
  | {
      status: "connected";
      connection: AIAuthPageConnection;
      label: string;
      identity: AIAuthWalletIdentity;
      capabilities: readonly string[];
      expiresAt: number;
    }
  | {
      status: "disconnected";
      reason: "closed" | "expired" | "idle" | "revoked";
    };

export interface AIAuthConnectController {
  getState(): AIAuthConnectPanelState;
  subscribe(listener: (state: AIAuthConnectPanelState) => void): () => void;
  connect(): Promise<void>;
  disconnect(): void;
  setConnection(connection: AIAuthPageConnection): void;
  close(): void;
}

export function createAIAuthConnectController(options?: {
  connect?: () => Promise<AIAuthPageConnection>;
  instruction?: AIAuthConnectInstruction | string;
}): AIAuthConnectController;

/**
 * Renders the copyable connect instruction and a live status area for the
 * wallet handshake. The host element mirrors the state as `data-status`:
 * `idle`, `connecting`, `connected`, or `disconnected`.
 */
export function mountAIAuthConnectPanel(options: {
  instruction: AIAuthConnectInstruction | string;
  connect?: () => Promise<AIAuthPageConnection>;
  target?: HTMLElement;
  label?: string;
  onStateChange?: (state: AIAuthConnectPanelState) => void;
}): () => void;

export {
  createConnectionState,
  canTransition,
  CONNECTION_STATUSES,
  CONNECTION_TRANSITIONS,
} from "./connection-state.js";
export type {
  ConnectionStatus,
  ConnectionPeer,
  ConnectionSnapshot,
  ConnectionState,
  ConnectionStateOptions,
} from "./connection-state.js";

export * from "./links.js";
export * from "./membership.js";
export * from "./revocation.js";
export * from "./agent-identity.js";
export {
  RECEIPT_TYPE,
  RECEIPT_VERSION,
  MESSAGE_STATES,
  buildReceiptPayload,
  verifyReceipt,
  createDeliveryLedger,
  isAddressedTo,
} from "./receipts.js";
export type {
  MessageState,
  DeliveryEntry,
  DeliveryLedger,
  ReceiptPayload,
  VerifiedReceipt,
} from "./receipts.js";
export {
  SENSITIVE_SELECTOR,
  isSensitiveElement,
  extractSafeText,
} from "./wheel-redaction.js";
