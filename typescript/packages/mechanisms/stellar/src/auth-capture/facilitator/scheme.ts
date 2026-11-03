import { BASE_FEE, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { STELLAR_WILDCARD_CAIP2 } from "../../constants";
import { pollForTransaction } from "../../shared";
import { getNetworkPassphrase, getRpcClient, type RpcConfig } from "../../utils";
import {
  AUTH_CAPTURE_SCHEME,
  canonicalEscrowAddress,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  MAX_FEE_BPS,
} from "../constants";
import * as Errors from "../errors";
import { isStellarAddress, isUint } from "../extra";
import { escrowHostFunction } from "../invocation";
import { prepare, type SettlementPlan, type VerifySettings } from "./verify";
import type { FacilitatorStellarSigner } from "../../signer";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

// Escrow calls write persistent payment state and extend its TTL to the refund deadline, so
// their resource fee is well above a plain token transfer.
const DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 1_000_000;

/** Fee terms a facilitator advertises on `/supported`. */
export interface AuthCaptureFeeTerms {
  minFeeBps: number;
  maxFeeBps: number;
  feeRecipient?: string;
}

export interface AuthCaptureStellarFacilitatorConfig {
  /** Custom RPC URL (required for pubnet). */
  rpcConfig?: RpcConfig;
  /** Escrow addresses per network that override the canonical deployments. */
  escrowAddresses?: Readonly<Record<string, string>>;
  /** Ceiling on the simulation-derived fee in stroops (default 1_000_000). */
  maxTransactionFeeStroops?: number;
  /** Inclusion fee bid in stroops added to the resource fee (default 100). */
  inclusionFeeStroops?: number;
  /** Fee terms advertised on `/supported` (default: zero fees). */
  feeTerms?: AuthCaptureFeeTerms;
  /**
   * Accept payments whose `receiverAuthorizer` is the operator, for a server that runs its
   * own facilitator. The escrow then skips the consent check and `consentEntry` is omitted.
   * Default `false`: the facilitator never acts as the consent address.
   */
  allowOperatorConsent?: boolean;
  /** Chooses the advertised `captureAuthorizer` (default: round-robin over the signers). */
  selectCaptureAuthorizer?: (addresses: readonly string[]) => string;
}

/**
 * Round-robin selector.
 *
 * @returns Selector that returns the next address on each call
 */
function roundRobin(): (addresses: readonly string[]) => string {
  let index = 0;
  return addresses => addresses[index++ % addresses.length];
}

/**
 * Stellar facilitator for the `auth-capture` scheme.
 *
 * The facilitator is the escrow operator: it submits every escrow call from the account named
 * by `extra.captureAuthorizer`, authorizes as transaction source only, and never signs an
 * authorization entry. Settle dispatch:
 *  - no `payload.type`, `paymentFlow: "escrow"` → `authorize`
 *  - no `payload.type`, `paymentFlow: "authorization"` → `charge` (completed payload)
 *  - `payload.type` `capture` / `void` / `refund` → that escrow call
 */
export class AuthCaptureStellarScheme implements SchemeNetworkFacilitator {
  readonly scheme = AUTH_CAPTURE_SCHEME;
  readonly caipFamily = STELLAR_WILDCARD_CAIP2;

  private readonly signers: ReadonlyMap<string, FacilitatorStellarSigner>;
  private readonly settings: VerifySettings;
  private readonly feeTerms: AuthCaptureFeeTerms;
  private readonly selectCaptureAuthorizer: (addresses: readonly string[]) => string;

  /**
   * Creates the facilitator scheme.
   *
   * @param signers - Operator accounts the facilitator submits from
   * @param config - Optional configuration
   */
  constructor(
    signers: FacilitatorStellarSigner[],
    config: AuthCaptureStellarFacilitatorConfig = {},
  ) {
    if (!signers || signers.length === 0) {
      throw new Error("At least one signer is required");
    }
    const feeTerms = config.feeTerms ?? { minFeeBps: 0, maxFeeBps: 0 };
    if (
      !isUint(feeTerms.minFeeBps) ||
      !isUint(feeTerms.maxFeeBps) ||
      feeTerms.minFeeBps > feeTerms.maxFeeBps ||
      feeTerms.maxFeeBps > MAX_FEE_BPS ||
      (feeTerms.feeRecipient !== undefined && !isStellarAddress(feeTerms.feeRecipient)) ||
      (feeTerms.feeRecipient === undefined && feeTerms.maxFeeBps > 0)
    ) {
      throw new Error("Invalid auth-capture fee terms");
    }
    this.signers = new Map(signers.map(signer => [signer.address, signer]));
    if (feeTerms.feeRecipient && this.signers.has(feeTerms.feeRecipient)) {
      throw new Error("feeRecipient must not be a facilitator signer");
    }
    this.feeTerms = feeTerms;
    this.selectCaptureAuthorizer = config.selectCaptureAuthorizer ?? roundRobin();
    this.settings = {
      rpcConfig: config.rpcConfig,
      escrowAddresses: config.escrowAddresses,
      maxTransactionFeeStroops:
        config.maxTransactionFeeStroops ?? DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
      inclusionFeeStroops: config.inclusionFeeStroops ?? Number(BASE_FEE),
      allowOperatorConsent: config.allowOperatorConsent ?? false,
      facilitatorAddresses: new Set(this.signers.keys()),
    };
  }

  /**
   * Extra advertised on `/supported`: sponsorship, the escrow, an operator account and the
   * facilitator's fee terms.
   *
   * @param network - CAIP-2 network
   * @returns Extra fields
   */
  getExtra(network: Network): Record<string, unknown> | undefined {
    const escrow = canonicalEscrowAddress(network, this.settings.escrowAddresses);
    return {
      areFeesSponsored: true,
      ...(escrow && { authCaptureEscrow: escrow }),
      captureAuthorizer: this.selectCaptureAuthorizer([...this.signers.keys()]),
      minFeeBps: this.feeTerms.minFeeBps,
      maxFeeBps: this.feeTerms.maxFeeBps,
      ...(this.feeTerms.feeRecipient && { feeRecipient: this.feeTerms.feeRecipient }),
    };
  }

  /**
   * Operator accounts this facilitator submits from.
   *
   * @param _ - Network (unused)
   * @returns Signer addresses
   */
  getSigners(_: string): string[] {
    return [...this.signers.keys()];
  }

  /**
   * Verifies a collect, completed charge, or lifecycle payload.
   *
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @returns Verify response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    try {
      return (await prepare(this.settings, payload, requirements)).response;
    } catch (error) {
      console.error("auth-capture verify failed:", error);
      return { isValid: false, invalidReason: Errors.ErrUnexpectedVerify };
    }
  }

  /**
   * Re-verifies the payload, then submits the escrow call from the operator account.
   *
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @returns Settle response; `amount` is the amount this settle moved
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    const fail = (errorReason: string, extra: Partial<SettleResponse> = {}): SettleResponse => ({
      success: false,
      network,
      transaction: "",
      errorReason,
      ...extra,
    });

    let payer: string | undefined;
    let transaction = "";
    try {
      const { response, plan } = await prepare(this.settings, payload, requirements);
      payer = response.payer;
      if (!response.isValid) {
        return fail(response.invalidReason ?? Errors.ErrUnexpectedSettle, {
          errorMessage: response.invalidMessage,
          payer,
        });
      }
      if (!plan) {
        return fail(Errors.ErrPayloadFormat, {
          errorMessage: "charge requires amount, feeAmount, feeReceiver and consentEntry",
          payer,
        });
      }

      const signed = await this.buildSignedTransaction(plan, requirements);
      if ("error" in signed) {
        return fail(Errors.ErrTransactionSigningFailed, { payer });
      }

      const server = getRpcClient(network, this.settings.rpcConfig);
      const sent = await server.sendTransaction(signed.tx);
      if (sent.status !== "PENDING") {
        const retryable = sent.status === "TRY_AGAIN_LATER";
        return fail(retryable ? Errors.ErrSubmissionRetryable : Errors.ErrSubmissionFailed, {
          errorMessage: `sendTransaction returned ${sent.status}`,
          payer,
          extra: { rpcStatus: sent.status, retryable },
        });
      }

      transaction = sent.hash;
      const timeout = requirements.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
      const confirmed = await pollForTransaction(server, transaction, timeout);
      if (!confirmed.success) {
        return fail(Errors.ErrTransactionFailed, { transaction, payer });
      }
      return { success: true, transaction, network, payer, amount: plan.amount };
    } catch (error) {
      console.error("auth-capture settle failed:", error);
      return fail(Errors.ErrUnexpectedSettle, { transaction, payer });
    }
  }

  /**
   * Builds the settlement transaction from the operator account with the simulated resources
   * and fee, and signs it as source.
   *
   * @param plan - Verified settlement plan
   * @param requirements - Payment requirements
   * @returns Signed transaction, or an error
   */
  private async buildSignedTransaction(
    plan: SettlementPlan,
    requirements: PaymentRequirements,
  ): Promise<{ tx: Transaction } | { error: string }> {
    const signer = this.signers.get(plan.operator);
    if (!signer) return { error: "no signer for operator" };

    const network = requirements.network;
    const networkPassphrase = getNetworkPassphrase(network);
    const server = getRpcClient(network, this.settings.rpcConfig);
    const account = await server.getAccount(plan.operator);
    const escrow = requirements.extra.authCaptureEscrow as string;

    // SDK v16: `fee` is the inclusion bid; build() adds the simulated resource fee.
    const tx = new TransactionBuilder(account, {
      fee: String(this.settings.inclusionFeeStroops),
      networkPassphrase,
      sorobanData: plan.simulation.transactionData.build(),
    })
      .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS)
      .addOperation(
        Operation.invokeHostFunction({
          func: escrowHostFunction(escrow, plan.call),
          auth: plan.entries,
        }),
      )
      .build();

    const { signedTxXdr, error } = await signer.signTransaction(tx.toXDR(), { networkPassphrase });
    if (error) return { error: error.message };
    return { tx: TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase) as Transaction };
  }
}
