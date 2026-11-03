import { rpc, xdr } from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { getAddressCredentials } from "../../shared";
import { getNetworkPassphrase, getRpcClient, isStellarNetwork, type RpcConfig } from "../../utils";
import {
  balanceChangesFromEvents,
  expectedBalanceChanges,
  sameBalanceChanges,
} from "../balanceChanges";
import {
  AUTH_CAPTURE_SCHEME,
  canonicalEscrowAddress,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  SIGNATURE_EXPIRATION_LEDGER_TOLERANCE,
} from "../constants";
import * as Errors from "../errors";
import { parseAuthCaptureExtra } from "../extra";
import {
  checkEntry,
  consentInvocation,
  decodeAuthEntry,
  entryAddress,
  entryTransferAmount,
  escrowHostFunction,
  funderInvocation,
  operatorEntry,
  payerInvocation,
  type EscrowCall,
} from "../invocation";
import {
  hasLifecycleType,
  parseChargeCompletion,
  parseCollectPayload,
  parseLifecyclePayload,
} from "../payload";
import {
  buildPaymentInfo,
  computePaymentHash,
  consentAddress,
  paymentInfoMismatches,
} from "../paymentInfo";
import {
  buildInvokeTransaction,
  expirationLedgerFor,
  readPaymentState,
  readTokenBalance,
  simulationErrorReason,
} from "../soroban";
import { facilitatorRole, feeProblem, invalid, verifyEntrySignatures } from "./checks";
import type { AuthCaptureStellarExtra, PaymentInfoJson, PaymentState } from "../types";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
} from "@x402/core/types";

const SUPPORTED_X402_VERSION = 2;

/** Facilitator settings the verification needs. */
export interface VerifySettings {
  rpcConfig?: RpcConfig;
  escrowAddresses?: Readonly<Record<string, string>>;
  maxTransactionFeeStroops: number;
  inclusionFeeStroops: number;
  /** Every address the facilitator controls. */
  facilitatorAddresses: ReadonlySet<string>;
}

/** Everything settle needs after a successful verification. */
export interface SettlementPlan {
  operator: string;
  call: EscrowCall;
  entries: xdr.SorobanAuthorizationEntry[];
  simulation: Api.SimulateTransactionSuccessResponse;
  payer: string;
  /** Amount collected, charged, captured, voided or refunded. */
  amount: string;
}

export interface PrepareResult {
  response: VerifyResponse;
  plan?: SettlementPlan;
}

/** Per-request context shared by the collect and lifecycle checks. */
interface Context {
  settings: VerifySettings;
  requirements: PaymentRequirements;
  extra: AuthCaptureStellarExtra;
  network: Network;
  escrow: string;
  server: rpc.Server;
  networkPassphrase: string;
  timeoutSeconds: number;
}

type Step<T> = T | { fail: VerifyResponse };

/**
 * Whether a step failed.
 *
 * @param step - Step result
 * @returns True when the step carries a failure
 */
function failed<T>(step: Step<T>): step is { fail: VerifyResponse } {
  return typeof step === "object" && step !== null && "fail" in step;
}

/**
 * Runs every verification check and, when they pass and an escrow call can be built,
 * simulates it. `settle` re-runs this before submitting.
 *
 * @param settings - Facilitator settings
 * @param payload - Payment payload
 * @param requirements - Payment requirements
 * @returns The verify response and, for settleable payloads, the settlement plan
 */
export async function prepare(
  settings: VerifySettings,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<PrepareResult> {
  if (payload.x402Version !== SUPPORTED_X402_VERSION) {
    return { response: invalid(Errors.ErrInvalidVersion) };
  }
  if (
    payload.accepted?.scheme !== AUTH_CAPTURE_SCHEME ||
    requirements.scheme !== AUTH_CAPTURE_SCHEME
  ) {
    return { response: invalid(Errors.ErrUnsupportedScheme) };
  }
  if (payload.accepted.network !== requirements.network) {
    return { response: invalid(Errors.ErrNetworkMismatch) };
  }
  const network = requirements.network;
  if (!isStellarNetwork(network)) {
    return { response: invalid(Errors.ErrInvalidNetwork) };
  }

  const parsed = parseAuthCaptureExtra(requirements.extra);
  if ("error" in parsed) {
    return { response: invalid(parsed.error, undefined, parsed.message) };
  }
  const extra = parsed.value;
  const escrow = canonicalEscrowAddress(network, settings.escrowAddresses);
  if (!escrow || extra.authCaptureEscrow !== escrow) {
    return { response: invalid(Errors.ErrEscrowMismatch) };
  }
  if (!settings.facilitatorAddresses.has(extra.captureAuthorizer)) {
    return { response: invalid(Errors.ErrOperatorNotAdmitted) };
  }

  const ctx: Context = {
    settings,
    requirements,
    extra,
    network,
    escrow,
    server: getRpcClient(network, settings.rpcConfig),
    networkPassphrase: getNetworkPassphrase(network),
    timeoutSeconds: requirements.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
  };
  return hasLifecycleType(payload.payload)
    ? prepareLifecycle(ctx, payload.payload)
    : prepareCollect(ctx, payload.payload);
}

/**
 * Verifies a client collect payload (optionally completed for `charge`).
 *
 * @param ctx - Request context
 * @param raw - `PaymentPayload.payload`
 * @returns Verify response and settlement plan
 */
async function prepareCollect(ctx: Context, raw: unknown): Promise<PrepareResult> {
  const { extra, requirements, escrow } = ctx;
  const collect = parseCollectPayload(raw);
  const entry = collect && decodeAuthEntry(collect.authorizationEntry);
  if (!collect || !entry) {
    return { response: invalid(Errors.ErrPayloadFormat) };
  }
  const completion = parseChargeCompletion(raw);
  if (completion === undefined) {
    return { response: invalid(Errors.ErrPayloadFormat) };
  }
  if (extra.paymentFlow === "escrow" && completion !== "absent") {
    return { response: invalid(Errors.ErrUnsupportedPaymentFlow) };
  }

  const payer = entryAddress(entry);
  if (!payer) {
    return { response: invalid(Errors.ErrAuthorizationEntry, undefined, "credentials") };
  }

  // A settlement override replaces requirements.amount with the charged amount; max_amount is
  // then recovered from the signed transfer and the entry check below binds it.
  let maxAmount = requirements.amount;
  if (completion !== "absent" && requirements.amount === completion.amount) {
    maxAmount = entryTransferAmount(entry) ?? requirements.amount;
  }

  const fn = extra.paymentFlow === "authorization" ? "charge" : "authorize";
  const paymentInfo = buildPaymentInfo({
    requirements,
    extra,
    payer,
    salt: collect.salt,
    preApprovalExpiry: collect.preApprovalExpiry,
    maxAmount,
  });
  const check = checkEntry(entry, payer, payerInvocation(escrow, fn, paymentInfo));
  if (!check.ok) {
    return { response: invalid(Errors.ErrAuthorizationEntry, payer, check.problem) };
  }

  const safety = paymentInfoSafety(ctx, paymentInfo);
  if (safety) return { response: invalid(Errors.ErrFacilitatorSafety, payer, safety) };

  const now = Math.floor(Date.now() / 1000);
  if (collect.preApprovalExpiry <= now) {
    return { response: invalid(Errors.ErrExpired, payer, "preApprovalExpiry has passed") };
  }
  if (collect.preApprovalExpiry > now + ctx.timeoutSeconds) {
    return { response: invalid(Errors.ErrExpired, payer, "preApprovalExpiry too far") };
  }

  const ledgers = await expirationLedgerFor(ctx.server, ctx.network, ctx.timeoutSeconds);
  if (check.expirationLedger <= ledgers.currentLedger) {
    return { response: invalid(Errors.ErrExpired, payer, "authorization entry expired") };
  }
  if (check.expirationLedger > ledgers.expirationLedger + SIGNATURE_EXPIRATION_LEDGER_TOLERANCE) {
    return { response: invalid(Errors.ErrAuthorizationEntry, payer, "expiration too far") };
  }
  if (!verifyEntrySignatures(entry, ctx.networkPassphrase)) {
    return { response: invalid(Errors.ErrSignature, payer) };
  }

  const state = await loadState(ctx, paymentInfo);
  if (state.collected) {
    return { response: invalid(Errors.ErrAlreadyCollected, payer) };
  }

  if (fn === "authorize") {
    return simulate(ctx, { fn, paymentInfo }, [entry], state, paymentInfo.maxAmount);
  }

  if (completion === "absent") {
    // The server completes the charge after the resource runs. Until then nothing
    // can be simulated, so confirm the payer can cover the maximum.
    const balance = await readTokenBalance(
      ctx.server,
      ctx.networkPassphrase,
      paymentInfo.token,
      payer,
    );
    if (balance < BigInt(paymentInfo.maxAmount)) {
      return { response: invalid(Errors.ErrInsufficientBalance, payer) };
    }
    return { response: { isValid: true, payer } };
  }

  const amount = BigInt(completion.amount);
  if (amount <= 0n || amount > BigInt(paymentInfo.maxAmount)) {
    return { response: invalid(Errors.ErrPayloadFormat, payer, "amount out of range") };
  }
  const fee = feeProblem(paymentInfo, amount, BigInt(completion.feeAmount), completion.feeReceiver);
  if (fee) return { response: invalid(Errors.ErrPayloadFormat, payer, fee) };

  const call: EscrowCall = {
    fn,
    paymentInfo,
    amount: completion.amount,
    feeAmount: completion.feeAmount,
    feeReceiver: completion.feeReceiver,
  };
  const consent = await consentEntries(
    ctx,
    call,
    completion.consentEntry,
    undefined,
    ledgers.currentLedger,
  );
  if (failed(consent)) return { response: { ...consent.fail, payer } };
  return simulate(ctx, call, [entry, ...consent], state, completion.amount);
}

/**
 * Verifies a lifecycle payload (`capture`, `void`, `refund`).
 *
 * @param ctx - Request context
 * @param raw - `PaymentPayload.payload`
 * @returns Verify response and settlement plan
 */
async function prepareLifecycle(ctx: Context, raw: unknown): Promise<PrepareResult> {
  const lifecycle = parseLifecyclePayload(raw);
  if (!lifecycle) {
    return { response: invalid(Errors.ErrPayloadFormat) };
  }
  const paymentInfo = lifecycle.paymentInfo;
  const payer = paymentInfo.payer;
  const mismatches = paymentInfoMismatches(paymentInfo, ctx.requirements, ctx.extra);
  if (mismatches.length > 0) {
    return {
      response: invalid(Errors.ErrPayloadFormat, payer, `paymentInfo ${mismatches.join(", ")}`),
    };
  }
  if (ctx.extra.paymentFlow === "authorization" && lifecycle.type !== "refund") {
    return { response: invalid(Errors.ErrUnsupportedPaymentFlow, payer) };
  }

  const funder = lifecycle.type === "refund" ? lifecycle.funder : undefined;
  const safety = paymentInfoSafety(ctx, paymentInfo, funder);
  if (safety) return { response: invalid(Errors.ErrFacilitatorSafety, payer, safety) };

  const now = Math.floor(Date.now() / 1000);
  let call: EscrowCall;
  switch (lifecycle.type) {
    case "capture": {
      const amount = BigInt(lifecycle.amount);
      if (amount <= 0n) return { response: invalid(Errors.ErrPayloadFormat, payer, "amount") };
      const fee = feeProblem(
        paymentInfo,
        amount,
        BigInt(lifecycle.feeAmount),
        lifecycle.feeReceiver,
      );
      if (fee) return { response: invalid(Errors.ErrPayloadFormat, payer, fee) };
      if (now >= paymentInfo.authorizationExpiry) {
        return { response: invalid(Errors.ErrExpired, payer, "captureDeadline has passed") };
      }
      call = {
        fn: "capture",
        paymentInfo,
        amount: lifecycle.amount,
        feeAmount: lifecycle.feeAmount,
        feeReceiver: lifecycle.feeReceiver,
        voidRemainder: lifecycle.voidRemainder,
      };
      break;
    }
    case "void":
      call = { fn: "void", paymentInfo };
      break;
    case "refund":
      if (BigInt(lifecycle.amount) <= 0n) {
        return { response: invalid(Errors.ErrPayloadFormat, payer, "amount") };
      }
      if (now >= paymentInfo.refundExpiry) {
        return { response: invalid(Errors.ErrExpired, payer, "refundDeadline has passed") };
      }
      call = { fn: "refund", paymentInfo, amount: lifecycle.amount, funder: lifecycle.funder };
      break;
  }

  const { currentLedger } = await expirationLedgerFor(ctx.server, ctx.network, ctx.timeoutSeconds);
  const funderEntry = lifecycle.type === "refund" ? lifecycle.funderEntry : undefined;
  const entries = await consentEntries(
    ctx,
    call,
    lifecycle.consentEntry,
    funderEntry,
    currentLedger,
  );
  if (failed(entries)) return { response: { ...entries.fail, payer } };

  const state = await loadState(ctx, paymentInfo);
  let amount: bigint;
  if (call.fn === "capture") {
    amount = BigInt(call.amount);
    if (amount > state.capturable)
      return { response: invalid(Errors.ErrInsufficientBalance, payer) };
  } else if (call.fn === "void") {
    amount = state.capturable;
    if (amount === 0n) return { response: invalid(Errors.ErrInsufficientBalance, payer) };
  } else {
    amount = BigInt((call as Extract<EscrowCall, { fn: "refund" }>).amount);
    if (amount > state.refundable)
      return { response: invalid(Errors.ErrInsufficientBalance, payer) };
  }
  return simulate(ctx, call, entries, state, amount.toString());
}

/**
 * Rejects payment info that names a facilitator address in any value-bearing role.
 *
 * @param ctx - Request context
 * @param info - Payment info
 * @param funder - Refund funder, if any
 * @returns The offending role, or undefined
 */
function paymentInfoSafety(
  ctx: Context,
  info: PaymentInfoJson,
  funder?: string,
): string | undefined {
  const facilitator = ctx.settings.facilitatorAddresses;
  return facilitatorRole(facilitator, {
    payer: info.payer,
    receiver: info.receiver,
    receiver_authorizer: info.receiverAuthorizer,
    fee_receiver: info.feeReceiver,
    funder,
  });
}

/**
 * Validates the consent entry and, for refunds, the funder entry.
 *
 * @param ctx - Request context
 * @param call - Escrow call
 * @param consentXdr - Consent entry XDR from the payload
 * @param funderXdr - Funder entry XDR from the payload
 * @param currentLedger - Latest ledger sequence
 * @returns Entries to attach, or a failure
 */
async function consentEntries(
  ctx: Context,
  call: EscrowCall,
  consentXdr: string | undefined,
  funderXdr: string | undefined,
  currentLedger: number,
): Promise<Step<xdr.SorobanAuthorizationEntry[]>> {
  const info = call.paymentInfo;
  const consent = consentAddress(info);
  const entries: xdr.SorobanAuthorizationEntry[] = [];
  const consentFail = (message: string) => ({
    fail: invalid(Errors.ErrConsentEntry, undefined, message),
  });

  if (consent === info.operator) {
    // The escrow rejects payments whose consent address is the operator.
    return {
      fail: invalid(Errors.ErrFacilitatorSafety, undefined, "operator is the consent address"),
    };
  } else {
    const entry = decodeAuthEntry(consentXdr);
    if (!entry) return consentFail("consentEntry missing or malformed");
    if (ctx.settings.facilitatorAddresses.has(entryAddress(entry) ?? "")) {
      return {
        fail: invalid(Errors.ErrFacilitatorSafety, undefined, "facilitator in consent entry"),
      };
    }
    const check = checkEntry(entry, consent, consentInvocation(ctx.escrow, call));
    if (!check.ok) return consentFail(`consentEntry ${check.problem}`);
    entries.push(entry);
  }

  if (call.fn === "refund" && call.funder !== consent) {
    const entry = decodeAuthEntry(funderXdr);
    if (!entry) return consentFail("funderEntry missing or malformed");
    const check = checkEntry(entry, call.funder, funderInvocation(ctx.escrow, call));
    if (!check.ok) return consentFail(`funderEntry ${check.problem}`);
    entries.push(entry);
  } else if (funderXdr !== undefined) {
    return consentFail("funderEntry must be omitted when the funder is the consent address");
  }

  for (const entry of entries) {
    const expiration = getAddressCredentials(entry.credentials())?.signatureExpirationLedger() ?? 0;
    if (expiration <= currentLedger)
      return { fail: invalid(Errors.ErrExpired, undefined, "entry expired") };
    if (!verifyEntrySignatures(entry, ctx.networkPassphrase)) {
      return { fail: invalid(Errors.ErrSignature) };
    }
  }
  return entries;
}

/**
 * Reads the onchain payment state.
 *
 * @param ctx - Request context
 * @param info - Payment info
 * @returns Payment state
 */
function loadState(ctx: Context, info: PaymentInfoJson): Promise<PaymentState> {
  const paymentHash = computePaymentHash(info, ctx.escrow, ctx.networkPassphrase);
  return readPaymentState(ctx.server, ctx.networkPassphrase, ctx.escrow, paymentHash);
}

/**
 * Simulates the escrow call from the operator account in enforcing mode, which verifies every
 * attached entry, then checks the fee ceiling and the balance changes.
 *
 * @param ctx - Request context
 * @param call - Escrow call
 * @param payloadEntries - Payer, consent and funder entries
 * @param state - Payment state before the call
 * @param amount - Amount the settle reports
 * @returns Verify response and settlement plan
 */
async function simulate(
  ctx: Context,
  call: EscrowCall,
  payloadEntries: xdr.SorobanAuthorizationEntry[],
  state: PaymentState,
  amount: string,
): Promise<PrepareResult> {
  const payer = call.paymentInfo.payer;
  const operator = ctx.extra.captureAuthorizer;
  const entries = [operatorEntry(ctx.escrow, call), ...payloadEntries];
  const account = await ctx.server.getAccount(operator);
  const tx = buildInvokeTransaction(
    account,
    ctx.networkPassphrase,
    escrowHostFunction(ctx.escrow, call),
    entries,
  );
  const simulation = await ctx.server.simulateTransaction(tx, undefined, "enforce");
  if (!Api.isSimulationSuccess(simulation)) {
    const error = Api.isSimulationError(simulation) ? simulation.error : "restore required";
    return {
      response: invalid(simulationErrorReason(error, ctx.escrow), payer, error.split("\n")[0]),
    };
  }

  const fee = Number(simulation.minResourceFee) + ctx.settings.inclusionFeeStroops;
  if (fee > ctx.settings.maxTransactionFeeStroops) {
    return {
      response: invalid(
        Errors.ErrFeeExceedsMaximum,
        payer,
        `fee ${fee} stroops exceeds ceiling ${ctx.settings.maxTransactionFeeStroops}`,
      ),
    };
  }

  const observed = balanceChangesFromEvents(simulation.events, call.paymentInfo.token, ctx.escrow);
  if ("error" in observed) {
    return { response: invalid(Errors.ErrSimulationFailed, payer, observed.error) };
  }
  if (!sameBalanceChanges(observed.changes, expectedBalanceChanges(call, ctx.escrow, state))) {
    return { response: invalid(Errors.ErrSimulationFailed, payer, "unexpected balance changes") };
  }

  return {
    response: { isValid: true, payer },
    plan: { operator, call, entries, simulation, payer, amount },
  };
}
