import { Address, hash, Networks, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  TOKEN,
  ESCROW,
  extra,
  keys,
  PASSPHRASE,
  paymentInfo,
  requirements,
  SALT,
} from "./fixtures";
import { feeBounds, parseAuthCaptureExtra } from "../../../src/auth-capture/extra";
import {
  hasLifecycleType,
  parseChargeCompletion,
  parseCollectPayload,
  parseLifecyclePayload,
} from "../../../src/auth-capture/payload";
import {
  buildPaymentInfo,
  computePaymentHash,
  consentAddress,
  paymentInfoFromScVal,
  paymentInfoMismatches,
  paymentInfoToScVal,
  parsePaymentInfoJson,
} from "../../../src/auth-capture/paymentInfo";
import type { AuthCaptureStellarExtra } from "../../../src/auth-capture/types";

/**
 * Parses extra that must be valid.
 *
 * @param overrides - Extra overrides
 * @returns Parsed extra
 */
function validExtra(overrides: Record<string, unknown> = {}): AuthCaptureStellarExtra {
  const parsed = parseAuthCaptureExtra(extra(overrides));
  if ("error" in parsed) throw new Error(parsed.message);
  return parsed.value;
}

describe("PaymentInfo encoding", () => {
  it("encodes an ScMap with symbol keys in contracttype order", () => {
    const scVal = paymentInfoToScVal(paymentInfo());
    const keysInOrder = scVal.map()!.map(entry => entry.key().sym().toString());
    expect(keysInOrder).toEqual([
      "authorization_expiry",
      "fee_receiver",
      "max_amount",
      "max_fee_bps",
      "min_fee_bps",
      "operator",
      "payer",
      "pre_approval_expiry",
      "receiver",
      "receiver_authorizer",
      "refund_expiry",
      "salt",
      "token",
    ]);
    expect([...keysInOrder].sort()).toEqual(keysInOrder);
  });

  it("uses the contract's value types, with scvVoid for None", () => {
    const types = new Map(
      paymentInfoToScVal(paymentInfo())
        .map()!
        .map(entry => [entry.key().sym().toString(), entry.val().switch().name]),
    );
    expect(types.get("max_amount")).toBe("scvI128");
    expect(types.get("pre_approval_expiry")).toBe("scvU64");
    expect(types.get("authorization_expiry")).toBe("scvU64");
    expect(types.get("min_fee_bps")).toBe("scvU32");
    expect(types.get("salt")).toBe("scvBytes");
    expect(types.get("receiver_authorizer")).toBe("scvVoid");
    expect(types.get("fee_receiver")).toBe("scvVoid");
    expect(types.get("operator")).toBe("scvAddress");
  });

  it("round-trips through XDR, including Some(address) options", () => {
    const info = paymentInfo(requirements(), {
      receiverAuthorizer: keys.authorizer.publicKey(),
      feeReceiver: keys.feeRecipient.publicKey(),
      minFeeBps: 10,
      maxFeeBps: 250,
    });
    const decoded = paymentInfoFromScVal(
      xdr.ScVal.fromXDR(paymentInfoToScVal(info).toXDR("base64"), "base64"),
    );
    expect(decoded).toEqual(info);
  });

  it("rejects maps with missing fields", () => {
    const scVal = xdr.ScVal.scvMap(paymentInfoToScVal(paymentInfo()).map()!.slice(1));
    expect(() => paymentInfoFromScVal(scVal)).toThrow("unexpected fields");
  });

  it("computes sha256(network_id || xdr(escrow) || xdr(payment_info))", () => {
    const info = paymentInfo();
    const expected = hash(
      Buffer.concat([
        hash(Buffer.from(PASSPHRASE)),
        new Address(ESCROW).toScVal().toXDR(),
        paymentInfoToScVal(info).toXDR(),
      ]),
    ).toString("hex");
    expect(computePaymentHash(info, ESCROW, PASSPHRASE)).toBe(expected);
    expect(computePaymentHash(info, ESCROW, Networks.PUBLIC)).not.toBe(expected);
    expect(computePaymentHash(info, TOKEN, PASSPHRASE)).not.toBe(expected);
    expect(computePaymentHash({ ...info, salt: "22".repeat(32) }, ESCROW, PASSPHRASE)).not.toBe(
      expected,
    );
  });

  it("validates JSON payment info", () => {
    const info = paymentInfo();
    expect(parsePaymentInfoJson(info)).toEqual(info);
    expect(parsePaymentInfoJson(null)).toBeUndefined();
    expect(parsePaymentInfoJson({ ...info, salt: "abc" })).toBeUndefined();
    expect(parsePaymentInfoJson({ ...info, maxAmount: "01" })).toBeUndefined();
    expect(parsePaymentInfoJson({ ...info, maxAmount: 5 })).toBeUndefined();
    expect(parsePaymentInfoJson({ ...info, operator: ESCROW })).toBeUndefined();
    expect(parsePaymentInfoJson({ ...info, minFeeBps: 2 ** 32 })).toBeUndefined();
    expect(parsePaymentInfoJson({ ...info, feeReceiver: "nope" })).toBeUndefined();
  });

  it("builds payment info from requirements and reports mismatches", () => {
    const req = requirements({ receiverAuthorizer: keys.authorizer.publicKey() });
    const e = validExtra({ receiverAuthorizer: keys.authorizer.publicKey() });
    const info = buildPaymentInfo({
      requirements: req,
      extra: e,
      payer: keys.payer.publicKey(),
      salt: SALT,
      preApprovalExpiry: 123,
    });
    expect(info.operator).toBe(keys.operator.publicKey());
    expect(info.maxAmount).toBe(req.amount);
    expect(consentAddress(info)).toBe(keys.authorizer.publicKey());
    expect(consentAddress({ ...info, receiverAuthorizer: null })).toBe(req.payTo);
    expect(paymentInfoMismatches(info, req, e)).toEqual([]);
    expect(
      paymentInfoMismatches({ ...info, token: ESCROW, refundExpiry: 1 }, req, e).sort(),
    ).toEqual(["refundExpiry", "token"]);
    // maxAmount is not compared: requirements.amount may carry a settlement override.
    expect(paymentInfoMismatches({ ...info, maxAmount: "1" }, req, e)).toEqual([]);
  });
});

describe("extra validation", () => {
  it("accepts the spec example and applies defaults", () => {
    const parsed = validExtra({ paymentFlow: undefined, captureMode: undefined });
    expect(parsed.paymentFlow).toBe("escrow");
    expect(parsed.captureMode).toBe("sync");
    expect(validExtra({ paymentFlow: "authorization", captureMode: undefined })).not.toHaveProperty(
      "captureMode",
    );
  });

  it.each([
    [{ areFeesSponsored: false }, "invalid_auth_capture_stellar_extra"],
    [{ authCaptureEscrow: keys.payer.publicKey() }, "invalid_auth_capture_stellar_extra"],
    [{ captureAuthorizer: ESCROW }, "invalid_auth_capture_stellar_extra"],
    [{ receiverAuthorizer: "bad" }, "invalid_auth_capture_stellar_extra"],
    [{ paymentFlow: "upfront" }, "invalid_auth_capture_stellar_unsupported_payment_flow"],
    [{ paymentFlow: "authorization" }, "invalid_auth_capture_stellar_extra"],
    [{ captureMode: "later" }, "invalid_auth_capture_stellar_extra"],
    [{ captureDeadline: 10, refundDeadline: 5 }, "invalid_auth_capture_stellar_extra"],
    [{ captureDeadline: -1 }, "invalid_auth_capture_stellar_extra"],
    [{ refundDeadline: "soon" }, "invalid_auth_capture_stellar_extra"],
    [
      { minFeeBps: 10, maxFeeBps: 5, feeRecipient: keys.feeRecipient.publicKey() },
      "invalid_auth_capture_stellar_extra",
    ],
    [
      { maxFeeBps: 10_001, feeRecipient: keys.feeRecipient.publicKey() },
      "invalid_auth_capture_stellar_extra",
    ],
    [{ minFeeBps: 1.5 }, "invalid_auth_capture_stellar_extra"],
    [{ maxFeeBps: 100 }, "invalid_auth_capture_stellar_extra"],
    [{ feeRecipient: "GBAD" }, "invalid_auth_capture_stellar_extra"],
  ])("rejects %o", (overrides, reason) => {
    const parsed = parseAuthCaptureExtra(extra(overrides));
    expect("error" in parsed && parsed.error).toBe(reason);
  });

  it("rejects missing extra", () => {
    expect(parseAuthCaptureExtra(undefined)).toMatchObject({
      error: "invalid_auth_capture_stellar_extra",
    });
  });

  it("accepts fee bounds with a fee recipient", () => {
    const parsed = validExtra({
      minFeeBps: 50,
      maxFeeBps: 100,
      feeRecipient: keys.feeRecipient.publicKey(),
    });
    expect(parsed.feeRecipient).toBe(keys.feeRecipient.publicKey());
  });

  it("computes fee bounds with integer division", () => {
    expect(feeBounds(999n, 100, 250)).toEqual({ min: 9n, max: 24n });
    expect(feeBounds(10_000_000n, 0, 0)).toEqual({ min: 0n, max: 0n });
  });
});

describe("payload parsing", () => {
  const collect = { authorizationEntry: "AAAA", salt: SALT, preApprovalExpiry: 1 };

  it("parses the client payload", () => {
    expect(parseCollectPayload(collect)).toEqual(collect);
    expect(parseCollectPayload({ ...collect, salt: "zz" })).toBeUndefined();
    expect(parseCollectPayload({ ...collect, authorizationEntry: "" })).toBeUndefined();
    expect(parseCollectPayload({ ...collect, preApprovalExpiry: "1" })).toBeUndefined();
    expect(parseCollectPayload(null)).toBeUndefined();
  });

  it("parses charge completion fields", () => {
    expect(parseChargeCompletion(collect)).toBe("absent");
    const completion = { amount: "5", feeAmount: "0", feeReceiver: null, consentEntry: "AAAA" };
    expect(parseChargeCompletion({ ...collect, ...completion })).toEqual(completion);
    expect(parseChargeCompletion({ ...collect, amount: "5" })).toBeUndefined();
    expect(parseChargeCompletion({ ...collect, ...completion, feeReceiver: "x" })).toBeUndefined();
    expect(parseChargeCompletion({ ...collect, ...completion, consentEntry: 1 })).toBeUndefined();
  });

  it("parses lifecycle payloads", () => {
    const info = paymentInfo();
    expect(hasLifecycleType({ type: "void" })).toBe(true);
    expect(hasLifecycleType(collect)).toBe(false);
    expect(parseLifecyclePayload({ type: "void", paymentInfo: info, consentEntry: "AA" })).toEqual({
      type: "void",
      paymentInfo: info,
      consentEntry: "AA",
    });
    const capture = {
      type: "capture",
      paymentInfo: info,
      amount: "5",
      feeAmount: "0",
      feeReceiver: null,
      voidRemainder: true,
    };
    expect(parseLifecyclePayload({ ...collect, ...capture })).toEqual(capture);
    expect(parseLifecyclePayload({ ...capture, voidRemainder: "yes" })).toBeUndefined();
    expect(parseLifecyclePayload({ ...capture, amount: "-1" })).toBeUndefined();
    const refund = {
      type: "refund",
      paymentInfo: info,
      amount: "5",
      funder: keys.funder.publicKey(),
      consentEntry: "AA",
      funderEntry: "BB",
    };
    expect(parseLifecyclePayload(refund)).toEqual(refund);
    expect(parseLifecyclePayload({ ...refund, funder: "x" })).toBeUndefined();
    expect(parseLifecyclePayload({ ...refund, funderEntry: "" })).toBeUndefined();
    expect(parseLifecyclePayload({ ...refund, consentEntry: 5 })).toBeUndefined();
    expect(parseLifecyclePayload({ type: "reclaim", paymentInfo: info })).toBeUndefined();
    expect(parseLifecyclePayload({ type: "void", paymentInfo: {} })).toBeUndefined();
    expect(parseLifecyclePayload(undefined)).toBeUndefined();
  });
});
