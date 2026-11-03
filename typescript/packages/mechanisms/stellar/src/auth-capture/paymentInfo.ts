import { Address, hash, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { isAccountAddress, isStellarAddress, isUint, isUintString } from "./extra";
import type { AuthCaptureStellarExtra, PaymentInfoJson } from "./types";
import type { PaymentRequirements } from "@x402/core/types";

const SALT_REGEX = /^[0-9a-f]{64}$/;
const U32_MAX = 0xffff_ffff;

// `PaymentInfo` fields in `#[contracttype]` wire order: an `ScMap` keyed by symbols sorted
// lexicographically. Each entry maps the Rust field name to its JSON name and value encoder.
const PAYMENT_INFO_FIELDS: ReadonlyArray<
  readonly [string, keyof PaymentInfoJson, (info: PaymentInfoJson) => xdr.ScVal]
> = [
  ["authorization_expiry", "authorizationExpiry", i => u64(i.authorizationExpiry)],
  ["fee_receiver", "feeReceiver", i => optionalAddress(i.feeReceiver)],
  ["max_amount", "maxAmount", i => i128(i.maxAmount)],
  ["max_fee_bps", "maxFeeBps", i => xdr.ScVal.scvU32(i.maxFeeBps)],
  ["min_fee_bps", "minFeeBps", i => xdr.ScVal.scvU32(i.minFeeBps)],
  ["operator", "operator", i => addressScVal(i.operator)],
  ["payer", "payer", i => addressScVal(i.payer)],
  ["pre_approval_expiry", "preApprovalExpiry", i => u64(i.preApprovalExpiry)],
  ["receiver", "receiver", i => addressScVal(i.receiver)],
  ["receiver_authorizer", "receiverAuthorizer", i => optionalAddress(i.receiverAuthorizer)],
  ["refund_expiry", "refundExpiry", i => u64(i.refundExpiry)],
  ["salt", "salt", i => xdr.ScVal.scvBytes(Buffer.from(i.salt, "hex"))],
  ["token", "token", i => addressScVal(i.token)],
];

/**
 * Encodes an address strkey as an `ScVal`.
 *
 * @param address - G or C strkey
 * @returns `scvAddress`
 */
export function addressScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

/**
 * Encodes an `Option<Address>`: `scvVoid` for `None`.
 *
 * @param address - Strkey or null
 * @returns `scvAddress` or `scvVoid`
 */
export function optionalAddress(address: string | null): xdr.ScVal {
  return address === null ? xdr.ScVal.scvVoid() : addressScVal(address);
}

/**
 * Encodes an `i128`.
 *
 * @param value - Decimal string or bigint
 * @returns `scvI128`
 */
export function i128(value: string | bigint): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "i128" });
}

/**
 * Encodes a `u64`.
 *
 * @param value - Non-negative integer
 * @returns `scvU64`
 */
function u64(value: number): xdr.ScVal {
  return xdr.ScVal.scvU64(new xdr.Uint64(BigInt(value)));
}

/**
 * Encodes `PaymentInfo` as the escrow expects it.
 *
 * @param info - Payment info in JSON form
 * @returns The struct as an `scvMap`
 */
export function paymentInfoToScVal(info: PaymentInfoJson): xdr.ScVal {
  return xdr.ScVal.scvMap(
    PAYMENT_INFO_FIELDS.map(
      ([key, , encode]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: encode(info) }),
    ),
  );
}

/**
 * Decodes a `PaymentInfo` `scvMap`.
 *
 * @param value - The struct as an `scvMap`
 * @returns Payment info in JSON form
 * @throws If the value is not a well-formed `PaymentInfo`
 */
export function paymentInfoFromScVal(value: xdr.ScVal): PaymentInfoJson {
  const native = scValToNative(value) as Record<string, unknown>;
  const keys = Object.keys(native).sort();
  if (keys.join() !== PAYMENT_INFO_FIELDS.map(([key]) => key).join()) {
    throw new Error("PaymentInfo has unexpected fields");
  }
  const decoded: PaymentInfoJson = {
    operator: native.operator as string,
    payer: native.payer as string,
    receiver: native.receiver as string,
    receiverAuthorizer: (native.receiver_authorizer as string | null) ?? null,
    token: native.token as string,
    maxAmount: (native.max_amount as bigint).toString(),
    preApprovalExpiry: Number(native.pre_approval_expiry as bigint),
    authorizationExpiry: Number(native.authorization_expiry as bigint),
    refundExpiry: Number(native.refund_expiry as bigint),
    minFeeBps: native.min_fee_bps as number,
    maxFeeBps: native.max_fee_bps as number,
    feeReceiver: (native.fee_receiver as string | null) ?? null,
    salt: Buffer.from(native.salt as Uint8Array).toString("hex"),
  };
  const parsed = parsePaymentInfoJson(decoded);
  if (!parsed) {
    throw new Error("PaymentInfo has malformed fields");
  }
  return parsed;
}

/**
 * Validates untrusted JSON as `PaymentInfo`.
 *
 * @param raw - Untrusted value
 * @returns The payment info, or undefined when malformed
 */
export function parsePaymentInfoJson(raw: unknown): PaymentInfoJson | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const optional = (v: unknown) => v === null || isStellarAddress(v);
  const u32 = (v: unknown) => isUint(v) && v <= U32_MAX;
  const valid =
    isAccountAddress(p.operator) &&
    isStellarAddress(p.payer) &&
    isStellarAddress(p.receiver) &&
    optional(p.receiverAuthorizer) &&
    isStellarAddress(p.token) &&
    isUintString(p.maxAmount) &&
    isUint(p.preApprovalExpiry) &&
    isUint(p.authorizationExpiry) &&
    isUint(p.refundExpiry) &&
    u32(p.minFeeBps) &&
    u32(p.maxFeeBps) &&
    optional(p.feeReceiver) &&
    typeof p.salt === "string" &&
    SALT_REGEX.test(p.salt);
  if (!valid) return undefined;
  return {
    operator: p.operator as string,
    payer: p.payer as string,
    receiver: p.receiver as string,
    receiverAuthorizer: p.receiverAuthorizer as string | null,
    token: p.token as string,
    maxAmount: p.maxAmount as string,
    preApprovalExpiry: p.preApprovalExpiry as number,
    authorizationExpiry: p.authorizationExpiry as number,
    refundExpiry: p.refundExpiry as number,
    minFeeBps: p.minFeeBps as number,
    maxFeeBps: p.maxFeeBps as number,
    feeReceiver: p.feeReceiver as string | null,
    salt: p.salt as string,
  };
}

/**
 * Whether a string is a 32-byte lowercase hex salt.
 *
 * @param value - Candidate salt
 * @returns True for 64 lowercase hex characters
 */
export function isSalt(value: unknown): value is string {
  return typeof value === "string" && SALT_REGEX.test(value);
}

/**
 * Builds `PaymentInfo` from requirements and the client's fields, as the appendix sets out.
 *
 * @param params - Inputs
 * @param params.requirements - Payment requirements (`payTo`, `asset`)
 * @param params.extra - Validated extra
 * @param params.payer - Payer address
 * @param params.salt - 32-byte hex salt
 * @param params.preApprovalExpiry - Unix seconds
 * @param params.maxAmount - Maximum amount; defaults to `requirements.amount`
 * @returns Payment info in JSON form
 */
export function buildPaymentInfo(params: {
  requirements: Pick<PaymentRequirements, "payTo" | "asset" | "amount">;
  extra: AuthCaptureStellarExtra;
  payer: string;
  salt: string;
  preApprovalExpiry: number;
  maxAmount?: string;
}): PaymentInfoJson {
  const { requirements, extra } = params;
  return {
    operator: extra.captureAuthorizer,
    payer: params.payer,
    receiver: requirements.payTo,
    receiverAuthorizer: extra.receiverAuthorizer ?? null,
    token: requirements.asset,
    maxAmount: params.maxAmount ?? requirements.amount,
    preApprovalExpiry: params.preApprovalExpiry,
    authorizationExpiry: extra.captureDeadline,
    refundExpiry: extra.refundDeadline,
    minFeeBps: extra.minFeeBps,
    maxFeeBps: extra.maxFeeBps,
    feeReceiver: extra.feeRecipient ?? null,
    salt: params.salt,
  };
}

/**
 * Returns the fields of `info` that disagree with the requirements. `maxAmount` is not
 * compared: at settle time `requirements.amount` may carry a settlement override.
 *
 * @param info - Payment info from a payload
 * @param requirements - Payment requirements
 * @param extra - Validated extra
 * @returns Names of mismatched fields (empty when consistent)
 */
export function paymentInfoMismatches(
  info: PaymentInfoJson,
  requirements: Pick<PaymentRequirements, "payTo" | "asset">,
  extra: AuthCaptureStellarExtra,
): string[] {
  const expected: Partial<PaymentInfoJson> = {
    operator: extra.captureAuthorizer,
    receiver: requirements.payTo,
    receiverAuthorizer: extra.receiverAuthorizer ?? null,
    token: requirements.asset,
    authorizationExpiry: extra.captureDeadline,
    refundExpiry: extra.refundDeadline,
    minFeeBps: extra.minFeeBps,
    maxFeeBps: extra.maxFeeBps,
    feeReceiver: extra.feeRecipient ?? null,
  };
  return (Object.keys(expected) as (keyof PaymentInfoJson)[]).filter(
    key => info[key] !== expected[key],
  );
}

/**
 * The consent address: `receiver_authorizer` when set, otherwise `receiver`.
 *
 * @param info - Payment info
 * @returns Address whose authorization covers charge, capture, void and refund
 */
export function consentAddress(info: PaymentInfoJson): string {
  return info.receiverAuthorizer ?? info.receiver;
}

/**
 * Computes `sha256(network_id || xdr(escrow_address) || xdr(payment_info))`, the key of the
 * escrow's payment state.
 *
 * @param info - Payment info
 * @param escrow - Escrow contract address
 * @param networkPassphrase - Network passphrase
 * @returns 32-byte payment hash as lowercase hex
 */
export function computePaymentHash(
  info: PaymentInfoJson,
  escrow: string,
  networkPassphrase: string,
): string {
  const networkId = hash(Buffer.from(networkPassphrase));
  const preimage = Buffer.concat([
    networkId,
    addressScVal(escrow).toXDR(),
    paymentInfoToScVal(info).toXDR(),
  ]);
  return hash(preimage).toString("hex");
}
