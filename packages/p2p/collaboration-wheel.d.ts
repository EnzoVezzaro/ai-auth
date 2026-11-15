export interface CollaborationWheelTransfers {
  sendText(text: string, options?: WheelSendOptions): Promise<unknown>;
  sendElement(
    metadata: Record<string, unknown>,
    options?: WheelSendOptions,
  ): Promise<unknown>;
  sendAttachment(
    blob: Blob,
    options: {
      kind: "screenshot" | "recording";
      name: string;
    } & WheelSendOptions,
  ): Promise<unknown>;
  subscribe(
    listener: (event: {
      type: string;
      text?: string;
      metadata?: Record<string, unknown>;
      blob?: Blob;
      name?: string;
      issuer?: string;
      receipt?: {
        messageId: string;
        receiver: string;
        receivedAt: number;
        nonce: string;
      };
      envelope?: unknown;
    }) => void,
  ): () => void;
  /** Set by `CollaborationTransfers`; the wheel only offers targeting when true. */
  readonly supportsTargets?: boolean;
  /** Set by `CollaborationTransfers`; without it delivery never advances past "sent-to-transport". */
  readonly supportsReceipts?: boolean;
}

export interface WheelSendOptions {
  messageId?: string;
  /** Wallet id of the single recipient. Addressing, not encryption. */
  target?: string;
}

export interface CollaborationWheelOptions {
  target?: HTMLElement;
  capabilities?: readonly string[] | null;
  /** A P2PRoom-like object: `peers` map of verified hellos, `subscribe`, `wallet.id`. */
  room?: {
    peers?: Map<string, { id: string; publicKey: JsonWebKey; seenAt: number }>;
    subscribe?: (listener: (event: unknown) => void) => () => void;
    wallet?: { id: string };
  };
  /** Source of connection state, such as a `NostrWebRTC`. */
  network?: {
    readonly connectionState?: {
      status: string;
      directPeerCount: number;
      peers: readonly { peerId: string; walletId?: string }[];
    };
    onConnectionState?: (listener: (snapshot: unknown) => void) => () => void;
  };
  /** Epoch ms after which the session is treated as expired. */
  expiresAt?: number;
}

/** Mount the wheel for an approved connection. Returns a function that removes it and stops all capture. */
export function mountCollaborationWheel(
  transfers: CollaborationWheelTransfers,
  options?: CollaborationWheelOptions,
): () => void;
