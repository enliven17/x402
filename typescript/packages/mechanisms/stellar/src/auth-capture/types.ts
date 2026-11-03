/**
 * Wire types for the Stellar auth-capture binding.
 */

export type AuthCapturePaymentFlow = "escrow" | "authorization";
export type AuthCaptureCaptureMode = "sync" | "deferred";
export type AuthCaptureLifecycleType = "capture" | "void" | "refund";

/** Escrow operation a settle performs. */
export type AuthCaptureOperation = "authorize" | "charge" | AuthCaptureLifecycleType;

/**
 * `PaymentInfo` in JSON form: camelCase field names, strkey addresses, `maxAmount`
 * as a decimal string, `salt` as 64 hex characters.
 */
export interface PaymentInfoJson {
  operator: string;
  payer: string;
  receiver: string;
  receiverAuthorizer: string | null;
  token: string;
  maxAmount: string;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: string | null;
  salt: string;
}

/** Validated `requirements.extra`. */
export interface AuthCaptureStellarExtra {
  areFeesSponsored: true;
  authCaptureEscrow: string;
  captureAuthorizer: string;
  receiverAuthorizer?: string;
  paymentFlow: AuthCapturePaymentFlow;
  /** Escrow flow only; defaults to `"sync"`. */
  captureMode?: AuthCaptureCaptureMode;
  captureDeadline: number;
  refundDeadline: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeRecipient?: string;
}

/** Client payload for `authorize` (escrow flow) or `charge` (authorization flow). */
export interface AuthCaptureCollectPayload {
  authorizationEntry: string;
  salt: string;
  preApprovalExpiry: number;
}

/** Fields the server appends to a client payload before settling a `charge`. */
export interface ChargeCompletionFields {
  amount: string;
  feeAmount: string;
  feeReceiver: string | null;
  /** Omitted only when the consent address is the operator. */
  consentEntry?: string;
}

export type CompletedChargePayload = AuthCaptureCollectPayload & ChargeCompletionFields;

export interface CapturePayload {
  type: "capture";
  paymentInfo: PaymentInfoJson;
  amount: string;
  feeAmount: string;
  feeReceiver: string | null;
  voidRemainder: boolean;
  consentEntry?: string;
}

export interface VoidPayload {
  type: "void";
  paymentInfo: PaymentInfoJson;
  consentEntry?: string;
}

export interface RefundPayload {
  type: "refund";
  paymentInfo: PaymentInfoJson;
  amount: string;
  funder: string;
  consentEntry?: string;
  /** Omitted when the funder is the consent address. */
  funderEntry?: string;
}

export type LifecyclePayload = CapturePayload | VoidPayload | RefundPayload;

/** Onchain `PaymentState`. */
export interface PaymentState {
  collected: boolean;
  capturable: bigint;
  refundable: bigint;
}
