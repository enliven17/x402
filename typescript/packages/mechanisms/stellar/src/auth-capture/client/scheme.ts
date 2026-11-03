import { findDefaultAsset } from "../../defaultAssets";
import { getNetworkPassphrase, getRpcClient, isStellarNetwork, type RpcConfig } from "../../utils";
import { defaultFeeAmount } from "../balanceChanges";
import {
  AUTH_CAPTURE_SCHEME,
  canonicalEscrowAddress,
  DEFAULT_MAX_TIMEOUT_SECONDS,
} from "../constants";
import { isStellarAddress, isContractAddress, isUintString, parseAuthCaptureExtra } from "../extra";
import { payerInvocation, checkEntry, type EscrowCall } from "../invocation";
import { buildPaymentInfo } from "../paymentInfo";
import { entryFor, expirationLedgerFor, recordEscrowAuth, signEntry } from "../soroban";
import type { ClientStellarSigner } from "../../signer";
import type { AuthCaptureCollectPayload } from "../types";
import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";

export interface AuthCaptureStellarClientConfig {
  /** Custom RPC URL (required for pubnet). */
  rpcConfig?: RpcConfig;
  /** Escrow addresses per network that override the canonical deployments. */
  escrowAddresses?: Readonly<Record<string, string>>;
}

/**
 * Generates a random 32-byte salt.
 *
 * @returns Lowercase hex salt
 */
function randomSalt(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

/**
 * Stellar client for the `auth-capture` scheme.
 *
 * Builds `PaymentInfo`, simulates the escrow's `authorize` (escrow flow) or `charge`
 * (authorization flow) in recording mode, and signs only the payer's authorization entry.
 */
export class AuthCaptureStellarScheme implements SchemeNetworkClient {
  readonly scheme = AUTH_CAPTURE_SCHEME;
  findDefaultAsset = findDefaultAsset;

  /**
   * Creates the client scheme.
   *
   * @param signer - Payer signer (G account or C contract account)
   * @param config - Optional RPC and escrow overrides
   */
  constructor(
    private readonly signer: ClientStellarSigner,
    private readonly config: AuthCaptureStellarClientConfig = {},
  ) {}

  /**
   * Creates the client payload: the signed entry, the salt and `preApprovalExpiry`.
   *
   * @param x402Version - Protocol version
   * @param requirements - Payment requirements
   * @returns The payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const { network, payTo, asset, amount } = requirements;
    if (requirements.scheme !== AUTH_CAPTURE_SCHEME) {
      throw new Error(`Unsupported scheme: ${requirements.scheme}`);
    }
    if (!isStellarNetwork(network)) {
      throw new Error(`Unsupported Stellar network: ${network}`);
    }
    if (!isUintString(amount) || BigInt(amount) <= 0n) {
      throw new Error(`Invalid amount: ${amount}`);
    }
    if (!isStellarAddress(payTo)) {
      throw new Error(`Invalid payTo address: ${payTo}`);
    }
    if (!isContractAddress(asset)) {
      throw new Error(`Invalid asset contract: ${asset}`);
    }
    const parsed = parseAuthCaptureExtra(requirements.extra);
    if ("error" in parsed) {
      throw new Error(`Invalid auth-capture extra: ${parsed.message}`);
    }
    const extra = parsed.value;
    const canonical = canonicalEscrowAddress(network, this.config.escrowAddresses);
    if (!canonical || extra.authCaptureEscrow !== canonical) {
      throw new Error(
        `authCaptureEscrow ${extra.authCaptureEscrow} is not canonical on ${network}`,
      );
    }

    const timeoutSeconds = requirements.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
    const now = Math.floor(Date.now() / 1000);
    // The escrow requires pre_approval_expiry <= authorization_expiry.
    const preApprovalExpiry = Math.min(now + timeoutSeconds, extra.captureDeadline);
    const paymentInfo = buildPaymentInfo({
      requirements,
      extra,
      payer: this.signer.address,
      salt: randomSalt(),
      preApprovalExpiry,
    });

    // The payer's entry covers only [payment_info]; for `charge` the remaining arguments are
    // placeholders that keep the simulation valid.
    const fn = extra.paymentFlow === "authorization" ? "charge" : "authorize";
    const call: EscrowCall =
      fn === "charge"
        ? {
            fn,
            paymentInfo,
            amount,
            feeAmount: defaultFeeAmount(BigInt(amount), extra.minFeeBps).toString(),
            feeReceiver: paymentInfo.feeReceiver,
          }
        : { fn, paymentInfo };

    const server = getRpcClient(network, this.config.rpcConfig);
    const networkPassphrase = getNetworkPassphrase(network);
    const recorded = await recordEscrowAuth(server, networkPassphrase, canonical, call);
    const entry = entryFor(recorded, this.signer.address);
    const check = checkEntry(
      entry,
      this.signer.address,
      payerInvocation(canonical, fn, paymentInfo),
    );
    if (!check.ok) {
      throw new Error(`Simulation returned an unexpected payer entry (${check.problem})`);
    }

    const { expirationLedger } = await expirationLedgerFor(server, network, timeoutSeconds);
    const signed = await signEntry(entry, this.signer, expirationLedger, networkPassphrase);

    const payload: AuthCaptureCollectPayload = {
      authorizationEntry: signed.toXDR("base64"),
      salt: paymentInfo.salt,
      preApprovalExpiry,
    };
    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }
}
