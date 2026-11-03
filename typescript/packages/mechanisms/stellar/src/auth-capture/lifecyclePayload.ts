import { getNetworkPassphrase, getRpcClient, type RpcConfig } from "../utils";
import { defaultFeeAmount } from "./balanceChanges";
import { DEFAULT_MAX_TIMEOUT_SECONDS } from "./constants";
import {
  checkEntry,
  consentInvocation,
  decodeAuthEntry,
  entryAddress,
  entryTransferAmount,
  funderInvocation,
  type EscrowCall,
} from "./invocation";
import { buildPaymentInfo, consentAddress } from "./paymentInfo";
import { entryFor, expirationLedgerFor, recordEscrowAuth, signEntry } from "./soroban";
import type { ClientStellarSigner } from "../signer";
import type {
  AuthCaptureCollectPayload,
  AuthCaptureStellarExtra,
  CapturePayload,
  ChargeCompletionFields,
  PaymentInfoJson,
  RefundPayload,
  VoidPayload,
} from "./types";
import type { Network, PaymentRequirements } from "@x402/core/types";

/** Network context for building server-signed entries. */
export interface LifecycleContext {
  network: Network;
  /** Escrow contract address (`extra.authCaptureEscrow`). */
  escrow: string;
  rpcConfig?: RpcConfig;
  /** Validity window of the signed entries (default 60 seconds). */
  timeoutSeconds?: number;
  /**
   * Signer for the consent address (`receiverAuthorizer ?? payTo`). Not needed when the
   * consent address is the operator.
   */
  consentSigner?: ClientStellarSigner;
}

/**
 * Simulates an escrow call in recording mode and signs the entry of one address. The recorded
 * tree is checked against the tree that address must authorize before signing.
 *
 * @param ctx - Network context
 * @param call - Escrow call
 * @param signer - Signer whose entry is signed
 * @param role - `consent` or `funder`
 * @returns The signed entry as base64 XDR
 */
export async function signEscrowEntry(
  ctx: LifecycleContext,
  call: EscrowCall,
  signer: ClientStellarSigner,
  role: "consent" | "funder",
): Promise<string> {
  const server = getRpcClient(ctx.network, ctx.rpcConfig);
  const networkPassphrase = getNetworkPassphrase(ctx.network);
  const recorded = await recordEscrowAuth(server, networkPassphrase, ctx.escrow, call);
  const entry = entryFor(recorded, signer.address);
  const expected =
    role === "funder" && call.fn === "refund"
      ? funderInvocation(ctx.escrow, call)
      : consentInvocation(ctx.escrow, call);
  const check = checkEntry(entry, signer.address, expected);
  if (!check.ok) {
    throw new Error(`Simulation returned an unexpected ${role} entry (${check.problem})`);
  }
  const { expirationLedger } = await expirationLedgerFor(
    server,
    ctx.network,
    ctx.timeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
  );
  const signed = await signEntry(entry, signer, expirationLedger, networkPassphrase);
  return signed.toXDR("base64");
}

/**
 * Produces the consent entry for an escrow call, or nothing when the consent address is the
 * operator.
 *
 * @param ctx - Network context
 * @param call - Escrow call
 * @returns `{ consentEntry }` or `{}`
 */
async function consentFields(
  ctx: LifecycleContext,
  call: EscrowCall,
): Promise<{ consentEntry?: string }> {
  const consent = consentAddress(call.paymentInfo);
  if (consent === call.paymentInfo.operator) return {};
  if (ctx.consentSigner?.address !== consent) {
    throw new Error(`A signer for the consent address ${consent} is required`);
  }
  return { consentEntry: await signEscrowEntry(ctx, call, ctx.consentSigner, "consent") };
}

/**
 * Rebuilds `PaymentInfo` from a client collect payload and the published requirements.
 *
 * @param collect - Client collect payload
 * @param requirements - Payment requirements as published (`amount` is the maximum)
 * @param extra - Validated extra
 * @returns Payment info
 * @throws If the authorization entry does not decode or has no address credentials
 */
export function paymentInfoFromCollect(
  collect: AuthCaptureCollectPayload,
  requirements: Pick<PaymentRequirements, "payTo" | "asset" | "amount">,
  extra: AuthCaptureStellarExtra,
): PaymentInfoJson {
  const entry = decodeAuthEntry(collect.authorizationEntry);
  const payer = entry && entryAddress(entry);
  if (!entry || !payer) {
    throw new Error("authorizationEntry has no address credentials");
  }
  return buildPaymentInfo({
    requirements,
    extra,
    payer,
    salt: collect.salt,
    preApprovalExpiry: collect.preApprovalExpiry,
    maxAmount: entryTransferAmount(entry) ?? requirements.amount,
  });
}

/** Server-chosen amount and fee for `charge` or `capture`. */
export interface AmountOptions {
  amount: string;
  /** Defaults to the minimum fee for `amount`. */
  feeAmount?: string;
  /** Defaults to `paymentInfo.feeReceiver`. */
  feeReceiver?: string | null;
}

/**
 * Resolves fee defaults.
 *
 * @param info - Payment info
 * @param opts - Amount and optional fee
 * @returns Amount, fee amount and fee receiver
 */
function resolveFee(
  info: PaymentInfoJson,
  opts: AmountOptions,
): { amount: string; feeAmount: string; feeReceiver: string | null } {
  return {
    amount: opts.amount,
    feeAmount: opts.feeAmount ?? defaultFeeAmount(BigInt(opts.amount), info.minFeeBps).toString(),
    feeReceiver: opts.feeReceiver === undefined ? info.feeReceiver : opts.feeReceiver,
  };
}

/**
 * Builds the fields that complete a client payload for `charge` (authorization flow).
 *
 * @param ctx - Network context
 * @param paymentInfo - Payment info rebuilt from the client payload
 * @param opts - Charged amount and optional fee
 * @returns Fields to append to the client payload
 */
export async function buildChargeCompletion(
  ctx: LifecycleContext,
  paymentInfo: PaymentInfoJson,
  opts: AmountOptions,
): Promise<ChargeCompletionFields> {
  const fee = resolveFee(paymentInfo, opts);
  const call: EscrowCall = { fn: "charge", paymentInfo, ...fee };
  return { ...fee, ...(await consentFields(ctx, call)) };
}

/**
 * Builds a `capture` lifecycle payload.
 *
 * @param ctx - Network context
 * @param paymentInfo - Payment info of the authorized payment
 * @param opts - Captured amount, optional fee, and whether to release the remaining hold
 * @returns Capture payload
 */
export async function buildCapturePayload(
  ctx: LifecycleContext,
  paymentInfo: PaymentInfoJson,
  opts: AmountOptions & { voidRemainder?: boolean },
): Promise<CapturePayload> {
  const fee = resolveFee(paymentInfo, opts);
  const voidRemainder = opts.voidRemainder ?? false;
  const call: EscrowCall = { fn: "capture", paymentInfo, ...fee, voidRemainder };
  return {
    type: "capture",
    paymentInfo,
    ...fee,
    voidRemainder,
    ...(await consentFields(ctx, call)),
  };
}

/**
 * Builds a `void` lifecycle payload.
 *
 * @param ctx - Network context
 * @param paymentInfo - Payment info of the authorized payment
 * @returns Void payload
 */
export async function buildVoidPayload(
  ctx: LifecycleContext,
  paymentInfo: PaymentInfoJson,
): Promise<VoidPayload> {
  return { type: "void", paymentInfo, ...(await consentFields(ctx, { fn: "void", paymentInfo })) };
}

/**
 * Builds a `refund` lifecycle payload. The funder defaults to the consent signer; a separate
 * funder signs its own entry rooted at the same `refund` call.
 *
 * @param ctx - Network context
 * @param paymentInfo - Payment info of the payment
 * @param opts - Refund amount, funder address and, for a separate funder, its signer
 * @param opts.amount - Amount to return to the payer
 * @param opts.funder - Address the refund is paid from (default: the consent address)
 * @param opts.funderSigner - Signer for `funder` when it is not the consent address
 * @returns Refund payload
 */
export async function buildRefundPayload(
  ctx: LifecycleContext,
  paymentInfo: PaymentInfoJson,
  opts: { amount: string; funder?: string; funderSigner?: ClientStellarSigner },
): Promise<RefundPayload> {
  const consent = consentAddress(paymentInfo);
  const funder = opts.funder ?? opts.funderSigner?.address ?? consent;
  const call: EscrowCall = { fn: "refund", paymentInfo, amount: opts.amount, funder };
  const fields = await consentFields(ctx, call);
  let funderEntry: string | undefined;
  if (funder !== consent) {
    if (opts.funderSigner?.address !== funder) {
      throw new Error(`A signer for the refund funder ${funder} is required`);
    }
    funderEntry = await signEscrowEntry(ctx, call, opts.funderSigner, "funder");
  }
  return {
    type: "refund",
    paymentInfo,
    amount: opts.amount,
    funder,
    ...fields,
    ...(funderEntry && { funderEntry }),
  };
}
