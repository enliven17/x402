import { isStellarAddress, isUint, isUintString } from "./extra";
import { isSalt, parsePaymentInfoJson } from "./paymentInfo";
import type { AuthCaptureCollectPayload, ChargeCompletionFields, LifecyclePayload } from "./types";

/**
 * Whether a payload names a lifecycle operation through `type`.
 *
 * @param raw - `PaymentPayload.payload`
 * @returns True when `type` is present
 */
export function hasLifecycleType(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && "type" in raw;
}

/**
 * Whether a value is a non-empty string (base64 entry XDR is checked when decoded).
 *
 * @param value - Candidate
 * @returns True for non-empty strings
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parses the client's collect fields.
 *
 * @param raw - `PaymentPayload.payload`
 * @returns The collect payload, or undefined when malformed
 */
export function parseCollectPayload(raw: unknown): AuthCaptureCollectPayload | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  if (!isNonEmptyString(p.authorizationEntry) || !isSalt(p.salt) || !isUint(p.preApprovalExpiry)) {
    return undefined;
  }
  return {
    authorizationEntry: p.authorizationEntry,
    salt: p.salt,
    preApprovalExpiry: p.preApprovalExpiry,
  };
}

/**
 * Parses the fields a server appends to complete a `charge`.
 *
 * @param raw - `PaymentPayload.payload`
 * @returns `"absent"` when no completion field is present, the fields when all are
 *   well-formed, or undefined when they are partial or malformed
 */
export function parseChargeCompletion(raw: unknown): ChargeCompletionFields | "absent" | undefined {
  const p = raw as Record<string, unknown>;
  const keys = ["amount", "feeAmount", "feeReceiver", "consentEntry"];
  if (keys.every(key => p[key] === undefined)) return "absent";
  if (!isUintString(p.amount) || !isUintString(p.feeAmount)) return undefined;
  if (p.feeReceiver !== null && !isStellarAddress(p.feeReceiver)) return undefined;
  if (p.consentEntry !== undefined && !isNonEmptyString(p.consentEntry)) return undefined;
  return {
    amount: p.amount,
    feeAmount: p.feeAmount,
    feeReceiver: p.feeReceiver as string | null,
    ...(p.consentEntry !== undefined && { consentEntry: p.consentEntry as string }),
  };
}

/**
 * Parses a lifecycle payload (`capture`, `void` or `refund`). Collect fields that a sync
 * capture leaves on the payload are ignored.
 *
 * @param raw - `PaymentPayload.payload`
 * @returns The lifecycle payload, or undefined when malformed
 */
export function parseLifecyclePayload(raw: unknown): LifecyclePayload | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const paymentInfo = parsePaymentInfoJson(p.paymentInfo);
  if (!paymentInfo) return undefined;
  if (p.consentEntry !== undefined && !isNonEmptyString(p.consentEntry)) return undefined;
  const consent = p.consentEntry !== undefined ? { consentEntry: p.consentEntry as string } : {};

  switch (p.type) {
    case "capture":
      if (
        !isUintString(p.amount) ||
        !isUintString(p.feeAmount) ||
        (p.feeReceiver !== null && !isStellarAddress(p.feeReceiver)) ||
        typeof p.voidRemainder !== "boolean"
      ) {
        return undefined;
      }
      return {
        type: "capture",
        paymentInfo,
        amount: p.amount,
        feeAmount: p.feeAmount,
        feeReceiver: p.feeReceiver as string | null,
        voidRemainder: p.voidRemainder,
        ...consent,
      };
    case "void":
      return { type: "void", paymentInfo, ...consent };
    case "refund":
      if (!isUintString(p.amount) || !isStellarAddress(p.funder)) return undefined;
      if (p.funderEntry !== undefined && !isNonEmptyString(p.funderEntry)) return undefined;
      return {
        type: "refund",
        paymentInfo,
        amount: p.amount,
        funder: p.funder,
        ...consent,
        ...(p.funderEntry !== undefined && { funderEntry: p.funderEntry as string }),
      };
    default:
      return undefined;
  }
}
