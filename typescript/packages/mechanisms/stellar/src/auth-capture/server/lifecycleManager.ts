import { AUTH_CAPTURE_SCHEME, DEFAULT_MAX_TIMEOUT_SECONDS } from "../constants";
import * as Errors from "../errors";
import {
  buildCapturePayload,
  buildRefundPayload,
  buildVoidPayload,
  type LifecycleContext,
} from "../lifecyclePayload";
import {
  applyCapture,
  applyRefund,
  applyVoid,
  type AuthorizedPayment,
  type AuthorizedPaymentStorage,
} from "./storage";
import type { AuthCaptureStellarScheme } from "./scheme";
import type { LifecyclePayload } from "../types";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";

export interface AuthCaptureLifecycleManagerConfig {
  scheme: AuthCaptureStellarScheme;
  facilitator: FacilitatorClient;
}

/** Options for a deferred capture. */
export interface CaptureOptions {
  /** Defaults to the whole capturable balance. */
  amount?: string;
  /** Defaults to the minimum fee for `amount`. */
  feeAmount?: string;
  /** Release the rest of the hold in the same call. */
  voidRemainder?: boolean;
}

/** Options for a refund. */
export interface RefundOptions {
  amount: string;
  /** Defaults to the scheme's funder signer, else the consent address. */
  funder?: string;
}

/**
 * Builds `PaymentRequirements` for a lifecycle settle from a stored payment.
 *
 * @param record - Stored payment
 * @returns Requirements matching the original collect
 */
export function requirementsFromRecord(record: AuthorizedPayment): PaymentRequirements {
  const info = record.paymentInfo;
  return {
    scheme: AUTH_CAPTURE_SCHEME,
    network: record.network,
    asset: info.token,
    amount: info.maxAmount,
    payTo: info.receiver,
    maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: {
      areFeesSponsored: true,
      authCaptureEscrow: record.escrow,
      captureAuthorizer: info.operator,
      ...(info.receiverAuthorizer && { receiverAuthorizer: info.receiverAuthorizer }),
      paymentFlow: record.paymentFlow,
      ...(record.paymentFlow === "escrow" && { captureMode: "deferred" }),
      captureDeadline: info.authorizationExpiry,
      refundDeadline: info.refundExpiry,
      minFeeBps: info.minFeeBps,
      maxFeeBps: info.maxFeeBps,
      ...(info.feeReceiver && { feeRecipient: info.feeReceiver }),
    },
  };
}

/**
 * Out-of-band `capture`, `void` and `refund` for stored payments (deferred capture, and
 * refunds on any route). Each call builds the lifecycle payload, signs the consent (and
 * funder) entries, settles it through the facilitator, and updates stored balances.
 */
export class AuthCaptureLifecycleManager {
  /**
   * Creates the manager.
   *
   * @param config - Server scheme (storage, signers) and facilitator client
   */
  constructor(private readonly config: AuthCaptureLifecycleManagerConfig) {}

  /**
   * Captures a stored escrow payment.
   *
   * @param paymentHash - Escrow payment hash
   * @param opts - Amount, fee and void-remainder options
   * @returns Facilitator settle response
   */
  async capture(paymentHash: string, opts: CaptureOptions = {}): Promise<SettleResponse> {
    const record = await this.load(paymentHash, "capture");
    const amount = opts.amount ?? record.capturableAmount;
    const payload = await buildCapturePayload(this.context(record), record.paymentInfo, {
      amount,
      feeAmount: opts.feeAmount,
      voidRemainder: opts.voidRemainder,
    });
    const response = await this.settle(record, payload);
    if (response.success) {
      await applyCapture(this.storage(), paymentHash, amount, Boolean(opts.voidRemainder));
    }
    return response;
  }

  /**
   * Releases the remaining hold of a stored escrow payment.
   *
   * @param paymentHash - Escrow payment hash
   * @returns Facilitator settle response
   */
  async voidPayment(paymentHash: string): Promise<SettleResponse> {
    const record = await this.load(paymentHash, "void");
    const payload = await buildVoidPayload(this.context(record), record.paymentInfo);
    const response = await this.settle(record, payload);
    if (response.success) await applyVoid(this.storage(), paymentHash);
    return response;
  }

  /**
   * Refunds captured or charged funds of a stored payment from the funder.
   *
   * @param paymentHash - Escrow payment hash
   * @param opts - Refund amount and funder
   * @returns Facilitator settle response
   */
  async refund(paymentHash: string, opts: RefundOptions): Promise<SettleResponse> {
    const record = await this.load(paymentHash, "refund");
    const funderSigner = this.config.scheme.getFunderSigner();
    const payload = await buildRefundPayload(this.context(record), record.paymentInfo, {
      amount: opts.amount,
      funder: opts.funder ?? funderSigner?.address,
      funderSigner,
    });
    const response = await this.settle(record, payload);
    if (response.success) await applyRefund(this.storage(), paymentHash, opts.amount);
    return response;
  }

  /**
   * Reads a stored payment.
   *
   * @param paymentHash - Escrow payment hash
   * @returns The record, or undefined
   */
  getAuthorizedPayment(paymentHash: string): Promise<AuthorizedPayment | undefined> {
    return this.storage().get(paymentHash);
  }

  /**
   * Lists stored payments.
   *
   * @returns All records
   */
  listAuthorizedPayments(): Promise<AuthorizedPayment[]> {
    return this.storage().list();
  }

  /**
   * The scheme's storage.
   *
   * @returns Storage backend
   */
  private storage(): AuthorizedPaymentStorage {
    return this.config.scheme.getStorage();
  }

  /**
   * Loads a record and rejects operations its payment flow does not allow.
   *
   * @param paymentHash - Escrow payment hash
   * @param operation - Lifecycle operation
   * @returns The record
   */
  private async load(
    paymentHash: string,
    operation: LifecyclePayload["type"],
  ): Promise<AuthorizedPayment> {
    const record = await this.storage().get(paymentHash);
    if (!record) {
      throw new Error(`${Errors.ErrServerLifecycleUnavailable}: no payment ${paymentHash}`);
    }
    if (record.paymentFlow === "authorization" && operation !== "refund") {
      throw new Error(
        `${Errors.ErrServerLifecycleUnavailable}: an authorization-flow payment is already charged; only refund applies`,
      );
    }
    return record;
  }

  /**
   * Network context for signing the payment's entries.
   *
   * @param record - Stored payment
   * @returns Lifecycle context
   */
  private context(record: AuthorizedPayment): LifecycleContext {
    return {
      network: record.network,
      escrow: record.escrow,
      rpcConfig: this.config.scheme.getRpcConfig(),
      consentSigner: this.config.scheme.getConsentSigner(),
    };
  }

  /**
   * Posts a lifecycle payload to the facilitator's `/settle`.
   *
   * @param record - Stored payment
   * @param payload - Lifecycle payload
   * @returns Facilitator settle response
   */
  private settle(record: AuthorizedPayment, payload: LifecyclePayload): Promise<SettleResponse> {
    const requirements = requirementsFromRecord(record);
    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: payload as unknown as Record<string, unknown>,
    };
    return this.config.facilitator.settle(paymentPayload, requirements);
  }
}
