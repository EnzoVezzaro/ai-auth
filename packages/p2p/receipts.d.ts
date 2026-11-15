export type MessageState =
  | "composing"
  | "queued"
  | "sent-to-transport"
  | "received-by-peer"
  | "failed"
  | "expired";

export const RECEIPT_TYPE: "ai-auth-receipt";
export const RECEIPT_VERSION: 1;
export const MESSAGE_STATES: readonly MessageState[];

export interface ReceiptPayload {
  v: 1;
  messageId: string;
  sender: string;
  receiver: string;
  receivedAt: number;
}

export interface VerifiedReceipt {
  readonly messageId: string;
  readonly receiver: string;
  readonly receivedAt: number;
  readonly nonce: string;
}

export interface DeliveryEntry {
  readonly messageId: string;
  readonly kind: string;
  /** Wallet id of the single addressed recipient; undefined = public room. */
  readonly target?: string;
  readonly summary: string;
  readonly state: MessageState;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Wallets whose signed receipts were accepted. */
  readonly receivers: readonly string[];
}

export interface DeliveryLedger {
  begin(input: {
    messageId: string;
    kind: string;
    target?: string;
    summary?: string;
  }): DeliveryEntry;
  queue(messageId: string): void;
  markSent(messageId: string): void;
  fail(messageId: string, error: unknown): void;
  discard(messageId: string): void;
  applyReceipt(
    receipt: VerifiedReceipt,
  ): { ok: true } | { ok: false; reason: string };
  sweep(): void;
  get(messageId: string): DeliveryEntry | undefined;
  list(): DeliveryEntry[];
  subscribe(listener: (entry: DeliveryEntry) => void): () => void;
}

export function buildReceiptPayload(input: {
  messageId: string;
  sender: string;
  receiver: string;
  receivedAt?: number;
}): ReceiptPayload;

/** Verifies signature and binding. A receipt is not proof a human read the message. */
export function verifyReceipt(
  envelope: unknown,
  expected: { sender: string; room: string; origin: string; now?: number },
): Promise<
  { ok: true; receipt: VerifiedReceipt } | { ok: false; reason: string }
>;

export function createDeliveryLedger(options?: {
  now?: () => number;
  limit?: number;
  ttlMs?: number;
}): DeliveryLedger;

export function isAddressedTo(
  payload: { target?: unknown } | null | undefined,
  selfId: string | undefined,
): boolean;
