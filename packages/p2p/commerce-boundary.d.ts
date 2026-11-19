// Type surface for the UCP/AP2 payment boundary. The runtime module is inert:
// it never mints a mandate, performs a payment or reads network/credentials.

export declare const PAYMENT_DENY_REASONS: Readonly<{
  OK: "ok";
  NO_MANDATE: "payment-mandate-missing";
  GENERIC_GRANT_NOT_AUTHORITY: "generic-grant-is-not-payment-authority";
  NO_VERIFIER: "mandate-verifier-missing";
  NOT_TRANSACTION_BOUND: "mandate-not-transaction-bound";
  FIELD_MISSING: "mandate-field-missing";
  FIELD_UNKNOWN: "mandate-field-unknown";
  AUDIENCE_MISMATCH: "audience-mismatch";
  MERCHANT_MISMATCH: "merchant-mismatch";
  AMOUNT_MISMATCH: "amount-mismatch";
  CURRENCY_MISMATCH: "currency-mismatch";
  LINE_ITEMS_MISMATCH: "line-items-mismatch";
  EXPIRED: "mandate-expired";
  REVOKED: "mandate-revoked";
  HUMAN_CONFIRMATION_REQUIRED: "human-confirmation-required";
  VERIFIER_REJECTED: "verifier-rejected";
  VERIFIER_ERROR: "verifier-error";
}>;

export declare const PAYMENT_DECISIONS: readonly ["allow", "deny"];

/** Every field required for a closed, transaction-bound payment mandate. */
export declare const REQUIRED_MANDATE_FIELDS: readonly [
  "transactionId",
  "amount",
  "currency",
  "merchant",
  "lineItems",
  "expiresAt",
  "audience",
  "humanConfirmation",
  "revoked",
];

/** UCP owns commerce workflow; AP2 owns the payment credential/authority. */
export declare const PAYMENT_LAYER_RESPONSIBILITIES: Readonly<{
  UCP: string;
  AP2: string;
  AI_AUTH: string;
}>;

/** The three unrelated meanings of "ACP"; commerce ACP is called out. */
export declare const ACP_LABELS: Readonly<
  Record<
    | "agent-communication-protocol"
    | "agent-client-protocol"
    | "agentic-commerce-protocol",
    string
  >
>;

/** Looks-like-authority signals. Used for denial messaging only, never grants. */
export declare const GENERIC_GRANT_MARKERS: readonly string[];

export interface LineItem {
  readonly id?: string;
  readonly sku?: string;
  readonly productId?: string;
  readonly itemId?: string;
  readonly quantity: number;
  readonly unitAmount?: number | string;
  readonly price?: number | string;
  readonly amount?: number | string;
  readonly [key: string]: unknown;
}

export interface HumanConfirmation {
  readonly confirmed: true;
  readonly [key: string]: unknown;
}

export interface PaymentMandate {
  readonly kind?: "payment" | "payment-mandate" | string;
  readonly mandateId?: string;
  readonly transactionId: string;
  readonly amount: number | string;
  readonly currency: string;
  readonly merchant: string;
  readonly lineItems: readonly LineItem[];
  readonly expiresAt: string | number;
  readonly audience: string | readonly string[] | Record<string, unknown>;
  readonly humanConfirmation: true | HumanConfirmation;
  readonly revoked: boolean;
  readonly [key: string]: unknown;
}

export interface ExpectedTransaction {
  readonly transactionId: string;
  readonly amount: number | string;
  readonly currency: string;
  readonly merchant: string;
  readonly lineItems: readonly LineItem[];
  readonly audience: string | readonly string[] | Record<string, unknown>;
  /** Injectable clock for deterministic expiry checks. */
  readonly now?: number;
  readonly [key: string]: unknown;
}

export interface NativeVerifierResult {
  readonly ok?: boolean;
  readonly valid?: boolean;
  readonly accepted?: boolean;
  readonly code?: string;
  readonly errorCode?: string;
  readonly error?: string;
  readonly message?: string;
  readonly nativeCode?: string;
  readonly [key: string]: unknown;
}

export type MandateVerifier = (
  mandate: PaymentMandate,
  context?: unknown,
) => boolean | NativeVerifierResult | Promise<boolean | NativeVerifierResult>;

export interface BindingChecks {
  readonly transactionBound: boolean;
  readonly audience: boolean;
  readonly merchant: boolean;
  readonly amount: boolean;
  readonly currency: boolean;
  readonly lineItems: boolean;
  readonly expiry: boolean;
  readonly revocation: boolean;
  readonly humanConfirmation: boolean;
}

export interface VerifierSummary {
  readonly ok: boolean;
  readonly code: string;
  readonly error?: string;
  readonly message?: string;
  readonly nativeCode?: string;
}

export interface BindingResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly checks: BindingChecks;
  readonly verifier: VerifierSummary | null;
}

export interface PaymentAudit {
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly mandateIdHash: string;
  readonly merchantHash: string;
  readonly currency: string;
  readonly transactionBound: boolean;
  readonly hasLineItems: boolean;
  readonly lineItemCount: number;
  readonly expiryState: "unknown" | "present";
  readonly revoked: boolean | "unknown";
  readonly humanConfirmed: boolean;
  readonly verifierCode: string;
  readonly timestamp?: number;
}

export interface PaymentDecision {
  readonly allowed: boolean;
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly verifier: VerifierSummary | null;
  readonly binding: BindingResult | null;
  readonly audit: PaymentAudit;
}

export declare function verifyMandateBinding(input?: {
  mandate?: unknown;
  expected?: unknown;
  verifierResult?: boolean | NativeVerifierResult;
}): BindingResult;

/** Copies only allowlisted metadata; never includes payloads or credentials. */
export declare function toPaymentAudit(
  mandate: unknown,
  decision?: unknown,
): PaymentAudit;

export declare function createPaymentBoundary(options?: {
  mandateVerifier?: MandateVerifier;
}): {
  authorizePayment(input?: {
    mandate?: unknown;
    toolGrant?: unknown;
    context?:
      | ExpectedTransaction
      | { expected?: ExpectedTransaction; [key: string]: unknown };
  }): Promise<PaymentDecision>;
};
