import { StrKey } from "@stellar/stellar-sdk";
import { MAX_FEE_BPS } from "./constants";
import * as Errors from "./errors";
import type { AuthCaptureStellarExtra } from "./types";

export type ParseResult<T> = { value: T } | { error: string; message: string };

/**
 * Whether a value is a Stellar account (`G...`) or contract (`C...`) address.
 * Muxed (`M...`) addresses are rejected: they cannot be a Soroban `Address` here.
 *
 * @param value - Candidate address
 * @returns True for a valid G or C strkey
 */
export function isStellarAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))
  );
}

/**
 * Whether a value is a Stellar account (`G...`) address.
 *
 * @param value - Candidate address
 * @returns True for a valid G strkey
 */
export function isAccountAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidEd25519PublicKey(value);
}

/**
 * Whether a value is a Stellar contract (`C...`) address.
 *
 * @param value - Candidate address
 * @returns True for a valid C strkey
 */
export function isContractAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidContract(value);
}

/**
 * Whether a value is a non-negative safe integer.
 *
 * @param value - Candidate number
 * @returns True for an integer in `[0, Number.MAX_SAFE_INTEGER]`
 */
export function isUint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether a value is a decimal string of a non-negative integer.
 *
 * @param value - Candidate string
 * @returns True for `/^\d+$/` strings without superfluous leading zeros
 */
export function isUintString(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && value.length <= 39;
}

/**
 * Fails with `invalid_auth_capture_stellar_extra`.
 *
 * @param message - Human-readable detail
 * @returns Error result
 */
function extraError(message: string): { error: string; message: string } {
  return { error: Errors.ErrExtra, message };
}

/**
 * Validates `requirements.extra` for the Stellar auth-capture binding.
 *
 * @param raw - Untrusted `requirements.extra`
 * @returns The normalized extra, or an error reason with detail
 */
export function parseAuthCaptureExtra(raw: unknown): ParseResult<AuthCaptureStellarExtra> {
  if (typeof raw !== "object" || raw === null) {
    return extraError("extra is missing");
  }
  const extra = raw as Record<string, unknown>;

  if (extra.areFeesSponsored !== true) {
    return extraError("areFeesSponsored must be true");
  }
  if (!isContractAddress(extra.authCaptureEscrow)) {
    return extraError("authCaptureEscrow must be a contract address");
  }
  if (!isAccountAddress(extra.captureAuthorizer)) {
    return extraError("captureAuthorizer must be an account address");
  }
  if (extra.receiverAuthorizer !== undefined && !isStellarAddress(extra.receiverAuthorizer)) {
    return extraError("receiverAuthorizer must be a Stellar address");
  }

  const paymentFlow = extra.paymentFlow ?? "escrow";
  if (paymentFlow !== "escrow" && paymentFlow !== "authorization") {
    return { error: Errors.ErrUnsupportedPaymentFlow, message: `paymentFlow ${paymentFlow}` };
  }
  if (extra.captureMode !== undefined) {
    if (paymentFlow === "authorization") {
      return extraError('captureMode must not be set with paymentFlow "authorization"');
    }
    if (extra.captureMode !== "sync" && extra.captureMode !== "deferred") {
      return extraError(`captureMode ${String(extra.captureMode)}`);
    }
  }

  const { captureDeadline, refundDeadline, minFeeBps, maxFeeBps } = extra;
  if (!isUint(captureDeadline) || !isUint(refundDeadline)) {
    return extraError("captureDeadline and refundDeadline must be unix seconds");
  }
  if (captureDeadline > refundDeadline) {
    return extraError("captureDeadline must not exceed refundDeadline");
  }
  if (!isUint(minFeeBps) || !isUint(maxFeeBps) || maxFeeBps > MAX_FEE_BPS) {
    return extraError(`minFeeBps and maxFeeBps must be integers in 0..${MAX_FEE_BPS}`);
  }
  if (minFeeBps > maxFeeBps) {
    return extraError("minFeeBps must not exceed maxFeeBps");
  }
  if (extra.feeRecipient !== undefined) {
    if (!isStellarAddress(extra.feeRecipient)) {
      return extraError("feeRecipient must be a Stellar address");
    }
  } else if (minFeeBps !== 0 || maxFeeBps !== 0) {
    return extraError("fee bounds must be zero without feeRecipient");
  }

  return {
    value: {
      areFeesSponsored: true,
      authCaptureEscrow: extra.authCaptureEscrow,
      captureAuthorizer: extra.captureAuthorizer,
      ...(extra.receiverAuthorizer !== undefined && {
        receiverAuthorizer: extra.receiverAuthorizer as string,
      }),
      paymentFlow,
      ...(paymentFlow === "escrow" && {
        captureMode: (extra.captureMode as "sync" | "deferred" | undefined) ?? "sync",
      }),
      captureDeadline,
      refundDeadline,
      minFeeBps,
      maxFeeBps,
      ...(extra.feeRecipient !== undefined && { feeRecipient: extra.feeRecipient as string }),
    },
  };
}

/**
 * Fee bounds the escrow enforces: `amount * bps / 10000` with integer division.
 *
 * @param amount - Charged or captured amount
 * @param minFeeBps - Fee floor in basis points
 * @param maxFeeBps - Fee ceiling in basis points
 * @returns Inclusive minimum and maximum fee amounts
 */
export function feeBounds(
  amount: bigint,
  minFeeBps: number,
  maxFeeBps: number,
): { min: bigint; max: bigint } {
  return {
    min: (amount * BigInt(minFeeBps)) / BigInt(MAX_FEE_BPS),
    max: (amount * BigInt(maxFeeBps)) / BigInt(MAX_FEE_BPS),
  };
}
