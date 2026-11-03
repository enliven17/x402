import { Keypair, Operation, Transaction, xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_LEDGER,
  ESCROW,
  escrowEvent,
  keys,
  MAX_AMOUNT,
  mockServer,
  now,
  paymentInfo,
  paymentPayload,
  requirements,
  SALT,
  signedEntry,
  simSuccess,
  stateScVal,
  transferEvent,
  unsignedEntry,
  type SimHandler,
} from "./fixtures";
import { AuthCaptureStellarScheme } from "../../../src/auth-capture/facilitator";
import {
  consentInvocation,
  funderInvocation,
  payerInvocation,
  type EscrowCall,
} from "../../../src/auth-capture/invocation";
import { i128 } from "../../../src/auth-capture/paymentInfo";
import { createEd25519Signer } from "../../../src/signer";
import * as stellarUtils from "../../../src/utils";
import type { PaymentInfoJson, PaymentState } from "../../../src/auth-capture/types";
import type { PaymentRequirements } from "@x402/core/types";

vi.mock("../../../src/utils", async () => {
  const actual = await vi.importActual<typeof stellarUtils>("../../../src/utils");
  return {
    ...actual,
    getRpcClient: vi.fn(),
    getEstimatedLedgerCloseTimeSeconds: vi.fn(async () => 5),
  };
});

const payer = keys.payer.publicKey();
const receiver = keys.receiver.publicKey();
const operator = keys.operator.publicKey();

let state: PaymentState;
let payerBalance: bigint;
let escrowSim: SimHandler;
let server: ReturnType<typeof mockServer>;

/**
 * Events the escrow call would emit for an honest simulation.
 *
 * @param call - Escrow call
 * @returns Transfer events
 */
function honestEvents(call: EscrowCall): xdr.DiagnosticEvent[] {
  const info = call.paymentInfo;
  switch (call.fn) {
    case "authorize":
      return [escrowEvent(), transferEvent(info.payer, ESCROW, info.maxAmount)];
    case "charge": {
      const unused = BigInt(info.maxAmount) - BigInt(call.amount);
      return [
        transferEvent(info.payer, ESCROW, info.maxAmount),
        transferEvent(ESCROW, info.receiver, call.amount),
        ...(unused > 0n ? [transferEvent(ESCROW, info.payer, unused)] : []),
      ];
    }
    case "capture": {
      const rest = state.capturable - BigInt(call.amount);
      return [
        transferEvent(ESCROW, info.receiver, call.amount),
        ...(call.voidRemainder && rest > 0n ? [transferEvent(ESCROW, info.payer, rest)] : []),
      ];
    }
    case "void":
      return [transferEvent(ESCROW, info.payer, state.capturable)];
    case "refund":
      return [transferEvent(call.funder, info.payer, call.amount)];
  }
}

let lastCall: EscrowCall | undefined;

beforeEach(() => {
  state = { collected: false, capturable: 0n, refundable: 0n };
  payerBalance = 100n * BigInt(MAX_AMOUNT);
  lastCall = undefined;
  escrowSim = () => simSuccess({ events: lastCall ? honestEvents(lastCall) : [] });
  server = mockServer((fn, tx, mode) => {
    if (fn === "payment_state") return simSuccess({ retval: stateScVal(state) });
    if (fn === "balance") return simSuccess({ retval: i128(payerBalance) });
    expect(mode).toBe("enforce");
    return escrowSim(fn, tx, mode);
  });
  vi.mocked(stellarUtils.getRpcClient).mockReturnValue(server as never);
});

const facilitator = (config: ConstructorParameters<typeof AuthCaptureStellarScheme>[1] = {}) =>
  new AuthCaptureStellarScheme([createEd25519Signer(keys.operator.secret())], config);

/**
 * Builds a client payload signed by `signer`.
 *
 * @param req - Requirements
 * @param opts - Overrides
 * @param opts.signer - Entry signer (default payer)
 * @param opts.fn - Root function
 * @param opts.expiration - Expiration ledger
 * @param opts.preApprovalExpiry - Unix seconds
 * @returns Payload and payment info
 */
async function collect(
  req: PaymentRequirements,
  opts: {
    signer?: Keypair;
    fn?: "authorize" | "charge";
    expiration?: number;
    preApprovalExpiry?: number;
  } = {},
): Promise<{ payload: Record<string, unknown>; info: PaymentInfoJson }> {
  const signer = opts.signer ?? keys.payer;
  const preApprovalExpiry = opts.preApprovalExpiry ?? now() + 30;
  const info = paymentInfo(req, { payer: signer.publicKey(), preApprovalExpiry });
  const fn =
    opts.fn ?? ((req.extra.paymentFlow as string) === "authorization" ? "charge" : "authorize");
  const entry = await signedEntry(signer, payerInvocation(ESCROW, fn, info), opts.expiration);
  lastCall =
    fn === "charge"
      ? { fn, paymentInfo: info, amount: info.maxAmount, feeAmount: "0", feeReceiver: null }
      : { fn, paymentInfo: info };
  return {
    payload: { authorizationEntry: entry.toXDR("base64"), salt: SALT, preApprovalExpiry },
    info,
  };
}

/**
 * Signs the consent entry for a call.
 *
 * @param call - Escrow call
 * @param signer - Consent signer
 * @returns Base64 entry
 */
async function consent(call: EscrowCall, signer = keys.receiver): Promise<string> {
  return (await signedEntry(signer, consentInvocation(ESCROW, call))).toXDR("base64");
}

describe("AuthCaptureStellarScheme (facilitator) configuration", () => {
  it("advertises sponsorship, escrow, operator and fee terms", () => {
    const scheme = facilitator({
      feeTerms: { minFeeBps: 10, maxFeeBps: 50, feeRecipient: keys.feeRecipient.publicKey() },
    });
    expect(scheme.getExtra("stellar:testnet")).toEqual({
      areFeesSponsored: true,
      authCaptureEscrow: ESCROW,
      captureAuthorizer: operator,
      minFeeBps: 10,
      maxFeeBps: 50,
      feeRecipient: keys.feeRecipient.publicKey(),
    });
    expect(scheme.getExtra("stellar:pubnet")).not.toHaveProperty("authCaptureEscrow");
    expect(scheme.getSigners("stellar:testnet")).toEqual([operator]);
    expect(scheme.scheme).toBe("auth-capture");
  });

  it("rejects invalid configuration", () => {
    expect(() => new AuthCaptureStellarScheme([])).toThrow("At least one signer");
    expect(() => facilitator({ feeTerms: { minFeeBps: 0, maxFeeBps: 10 } })).toThrow("fee terms");
    expect(() =>
      facilitator({ feeTerms: { minFeeBps: 0, maxFeeBps: 10, feeRecipient: operator } }),
    ).toThrow("feeRecipient");
  });
});

describe("common verification", () => {
  it.each([
    ["version", { x402Version: 1 }, {}, "invalid_x402_version"],
    ["scheme", {}, { scheme: "exact" }, "unsupported_scheme"],
    ["network mismatch", {}, { network: "stellar:pubnet" }, "network_mismatch"],
  ])("rejects %s", async (_, payloadOverride, reqOverride, reason) => {
    const req = requirements();
    const { payload } = await collect(req);
    const result = await facilitator().verify(
      { ...paymentPayload(req, payload), ...payloadOverride },
      { ...req, ...reqOverride } as PaymentRequirements,
    );
    expect(result.invalidReason).toBe(reason);
  });

  it("rejects unknown networks", async () => {
    const req = requirements({}, { network: "stellar:futurenet" });
    expect((await facilitator().verify(paymentPayload(req, {}), req)).invalidReason).toBe(
      "invalid_network",
    );
  });

  it.each([
    [{ maxFeeBps: 5 }, "invalid_auth_capture_stellar_extra"],
    [{ captureDeadline: now() + 9000 }, "invalid_auth_capture_stellar_extra"],
    [{ paymentFlow: "upfront" }, "invalid_auth_capture_stellar_unsupported_payment_flow"],
    [
      { authCaptureEscrow: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" },
      "invalid_auth_capture_stellar_escrow_mismatch",
    ],
    [{ captureAuthorizer: receiver }, "invalid_auth_capture_stellar_operator_not_admitted"],
  ])("rejects extra %o", async (overrides, reason) => {
    const req = requirements(overrides);
    expect((await facilitator().verify(paymentPayload(req, {}), req)).invalidReason).toBe(reason);
  });
});

describe("authorize (escrow flow)", () => {
  it("verifies, simulates in enforcing mode with the operator's source-account entry", async () => {
    const req = requirements();
    const { payload } = await collect(req);
    const result = await facilitator().verify(paymentPayload(req, payload), req);
    expect(result).toEqual({ isValid: true, payer });

    const escrowCalls = server.simulateTransaction.mock.calls.filter(
      ([, , mode]) => mode === "enforce",
    );
    expect(escrowCalls).toHaveLength(1);
    const tx = escrowCalls[0][0] as Transaction;
    expect(tx.source).toBe(operator);
    const auth = (tx.operations[0] as Operation.InvokeHostFunction).auth!;
    expect(auth.map(entry => entry.credentials().switch().name)).toEqual([
      "sorobanCredentialsSourceAccount",
      "sorobanCredentialsAddress",
    ]);
  });

  it("settles and reports the collected amount", async () => {
    const req = requirements();
    const { payload } = await collect(req);
    const result = await facilitator().settle(paymentPayload(req, payload), req);
    expect(result).toEqual({
      success: true,
      transaction: "deadbeef",
      network: "stellar:testnet",
      payer,
      amount: MAX_AMOUNT,
    });
    const sent = server.sendTransaction.mock.calls[0][0] as unknown as Transaction;
    expect(sent.source).toBe(operator);
    expect(sent.signatures).toHaveLength(1);
    expect(Number(sent.fee)).toBe(1000 + 100);
  });

  it("reports submission and execution failures", async () => {
    const req = requirements();
    const { payload } = await collect(req);
    server.sendTransaction.mockResolvedValueOnce({ status: "ERROR", hash: "x", latestLedger: 1 });
    expect((await facilitator().settle(paymentPayload(req, payload), req)).errorReason).toBe(
      "invalid_auth_capture_stellar_transaction_submission_failed",
    );
    server.sendTransaction.mockResolvedValueOnce({
      status: "TRY_AGAIN_LATER",
      hash: "x",
      latestLedger: 1,
    });
    expect((await facilitator().settle(paymentPayload(req, payload), req)).errorReason).toBe(
      "invalid_auth_capture_stellar_transaction_submission_retryable",
    );
    server.getTransaction.mockResolvedValueOnce({ status: "FAILED" });
    const failed = await facilitator().settle(paymentPayload(req, payload), req);
    expect(failed).toMatchObject({
      success: false,
      transaction: "deadbeef",
      errorReason: "invalid_auth_capture_stellar_transaction_failed",
    });
  });

  it("rejects malformed payloads", async () => {
    const req = requirements();
    const { payload } = await collect(req);
    const verify = (p: object) => facilitator().verify(paymentPayload(req, p), req);
    expect((await verify({ ...payload, salt: "x" })).invalidReason).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );
    expect((await verify({ ...payload, authorizationEntry: "garbage" })).invalidReason).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );
    expect(
      (await verify({ ...payload, amount: "1", feeAmount: "0", feeReceiver: null })).invalidReason,
    ).toBe("invalid_auth_capture_stellar_unsupported_payment_flow");
  });

  it("rejects source-account credentials and wrong invocations", async () => {
    const req = requirements();
    const info = paymentInfo(req);
    const sourceEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: payerInvocation(ESCROW, "authorize", info),
    });
    const payload = {
      authorizationEntry: sourceEntry.toXDR("base64"),
      salt: SALT,
      preApprovalExpiry: info.preApprovalExpiry,
    };
    expect((await facilitator().verify(paymentPayload(req, payload), req)).invalidReason).toBe(
      "invalid_auth_capture_stellar_authorization_entry",
    );

    const { payload: chargePayload } = await collect(req, { fn: "charge" });
    expect(
      (await facilitator().verify(paymentPayload(req, chargePayload), req)).invalidReason,
    ).toBe("invalid_auth_capture_stellar_authorization_entry");

    const { payload: other } = await collect(req);
    const tampered = { ...other, salt: "22".repeat(32) };
    expect((await facilitator().verify(paymentPayload(req, tampered), req)).invalidReason).toBe(
      "invalid_auth_capture_stellar_authorization_entry",
    );
  });

  it("enforces facilitator safety", async () => {
    const req = requirements();
    const { payload } = await collect(req, { signer: keys.operator });
    expect((await facilitator().verify(paymentPayload(req, payload), req)).invalidReason).toBe(
      "invalid_auth_capture_stellar_facilitator_safety",
    );

    const toOperator = requirements({}, { payTo: operator });
    const { payload: p2 } = await collect(toOperator);
    expect(
      (await facilitator().verify(paymentPayload(toOperator, p2), toOperator)).invalidReason,
    ).toBe("invalid_auth_capture_stellar_facilitator_safety");

    const feeToOperator = requirements({ feeRecipient: operator, maxFeeBps: 10 });
    const { payload: p3 } = await collect(feeToOperator);
    expect(
      (await facilitator().verify(paymentPayload(feeToOperator, p3), feeToOperator)).invalidReason,
    ).toBe("invalid_auth_capture_stellar_facilitator_safety");
  });

  it("enforces preApprovalExpiry and entry expiration", async () => {
    const req = requirements();
    const verify = async (opts: Parameters<typeof collect>[1]) =>
      (await facilitator().verify(paymentPayload(req, (await collect(req, opts)).payload), req))
        .invalidReason;
    expect(await verify({ preApprovalExpiry: now() - 1 })).toBe(
      "invalid_auth_capture_stellar_expired",
    );
    expect(await verify({ preApprovalExpiry: now() + 600 })).toBe(
      "invalid_auth_capture_stellar_expired",
    );
    expect(await verify({ expiration: CURRENT_LEDGER })).toBe(
      "invalid_auth_capture_stellar_expired",
    );
    expect(await verify({ expiration: CURRENT_LEDGER + 100 })).toBe(
      "invalid_auth_capture_stellar_authorization_entry",
    );
  });

  it("rejects an invalid signature", async () => {
    const req = requirements();
    const info = paymentInfo(req);
    const entry = unsignedEntry(payer, payerInvocation(ESCROW, "authorize", info));
    entry
      .credentials()
      .address()
      .signatureExpirationLedger(CURRENT_LEDGER + 5);
    const payload = {
      authorizationEntry: entry.toXDR("base64"),
      salt: SALT,
      preApprovalExpiry: info.preApprovalExpiry,
    };
    expect((await facilitator().verify(paymentPayload(req, payload), req)).invalidReason).toBe(
      "invalid_auth_capture_stellar_signature",
    );
  });

  it("rejects an already collected payment", async () => {
    state = { collected: true, capturable: 1n, refundable: 0n };
    const req = requirements();
    const { payload } = await collect(req);
    expect((await facilitator().verify(paymentPayload(req, payload), req)).invalidReason).toBe(
      "invalid_auth_capture_stellar_already_collected",
    );
  });

  it("maps simulation failures, fee ceiling and unexpected balance changes", async () => {
    const req = requirements();
    const { payload } = await collect(req);
    const verify = () => facilitator().verify(paymentPayload(req, payload), req);

    escrowSim = () => ({
      error: `HostError: Error(Contract, #3)\n0: contract:${ESCROW}, topics:[error, Error(Contract, #3)]`,
      events: [],
      latestLedger: 1,
      _parsed: true,
    });
    expect((await verify()).invalidReason).toBe("invalid_auth_capture_stellar_expired");

    escrowSim = () => simSuccess({ events: honestEvents(lastCall!), minResourceFee: "2000000" });
    expect((await verify()).invalidReason).toBe("invalid_auth_capture_stellar_fee_exceeds_maximum");

    escrowSim = () =>
      simSuccess({ events: [...honestEvents(lastCall!), transferEvent(payer, operator, "1")] });
    expect((await verify()).invalidReason).toBe("invalid_auth_capture_stellar_simulation_failed");

    escrowSim = () => simSuccess({ events: [] });
    expect((await verify()).invalidReason).toBe("invalid_auth_capture_stellar_simulation_failed");
  });

  it("returns unexpected_verify_error when RPC throws", async () => {
    const req = requirements();
    const { payload } = await collect(req);
    server.getLatestLedger.mockRejectedValueOnce(new Error("rpc down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await facilitator().verify(paymentPayload(req, payload), req)).invalidReason).toBe(
      "unexpected_verify_error",
    );
    spy.mockRestore();
  });
});

describe("charge (authorization flow)", () => {
  const authReq = () => requirements({ paymentFlow: "authorization", captureMode: undefined });

  it("verifies the client payload before the resource runs without simulating", async () => {
    const req = authReq();
    const { payload } = await collect(req);
    expect(await facilitator().verify(paymentPayload(req, payload), req)).toEqual({
      isValid: true,
      payer,
    });
    payerBalance = 1n;
    expect((await facilitator().verify(paymentPayload(req, payload), req)).invalidReason).toBe(
      "invalid_auth_capture_stellar_insufficient_balance",
    );
    payerBalance = 100n * BigInt(MAX_AMOUNT);
    expect((await facilitator().settle(paymentPayload(req, payload), req)).errorReason).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );
  });

  it("settles a completed charge, including with a settlement-override amount", async () => {
    const req = authReq();
    const { payload, info } = await collect(req);
    const call: EscrowCall = {
      fn: "charge",
      paymentInfo: info,
      amount: "7500000",
      feeAmount: "0",
      feeReceiver: null,
    };
    lastCall = call;
    const completed = {
      ...payload,
      amount: "7500000",
      feeAmount: "0",
      feeReceiver: null,
      consentEntry: await consent(call),
    };

    const settled = await facilitator().settle(paymentPayload(req, completed), req);
    expect(settled).toMatchObject({ success: true, amount: "7500000" });

    const overridden = { ...req, amount: "7500000" };
    expect(await facilitator().verify(paymentPayload(overridden, completed), overridden)).toEqual({
      isValid: true,
      payer,
    });
  });

  it("rejects bad completions", async () => {
    const req = authReq();
    const { payload, info } = await collect(req);
    const call: EscrowCall = {
      fn: "charge",
      paymentInfo: info,
      amount: "7500000",
      feeAmount: "0",
      feeReceiver: null,
    };
    const good = {
      ...payload,
      amount: "7500000",
      feeAmount: "0",
      feeReceiver: null,
      consentEntry: await consent(call),
    };
    const verify = async (p: object) =>
      (await facilitator().verify(paymentPayload(req, p), req)).invalidReason;

    expect(await verify({ ...good, consentEntry: undefined })).toBe(
      "invalid_auth_capture_stellar_consent_entry",
    );
    expect(await verify({ ...good, consentEntry: await consent({ ...call, amount: "1" }) })).toBe(
      "invalid_auth_capture_stellar_consent_entry",
    );
    expect(await verify({ ...good, consentEntry: await consent(call, keys.authorizer) })).toBe(
      "invalid_auth_capture_stellar_consent_entry",
    );
    expect(await verify({ ...good, amount: "20000000" })).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );
    expect(await verify({ ...good, amount: "0" })).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );
    expect(await verify({ ...good, feeAmount: "1" })).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );
    expect(await verify({ ...good, feeReceiver: receiver })).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );
    expect(await verify({ ...good, amount: "7500000", feeAmount: "x" })).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );
  });
});

describe("lifecycle", () => {
  const authorized = () => {
    state = { collected: true, capturable: BigInt(MAX_AMOUNT), refundable: 0n };
  };

  /**
   * Builds a lifecycle payload with a consent entry for its call.
   *
   * @param req - Requirements
   * @param call - Escrow call
   * @param extraFields - Additional payload fields
   * @returns Lifecycle payload
   */
  async function lifecycle(req: PaymentRequirements, call: EscrowCall, extraFields: object = {}) {
    lastCall = call;
    const base: Record<string, unknown> = { type: call.fn, paymentInfo: call.paymentInfo };
    if (call.fn === "capture") {
      Object.assign(base, {
        amount: call.amount,
        feeAmount: call.feeAmount,
        feeReceiver: call.feeReceiver,
        voidRemainder: call.voidRemainder,
      });
    }
    if (call.fn === "refund") Object.assign(base, { amount: call.amount, funder: call.funder });
    return { ...base, consentEntry: await consent(call), ...extraFields };
  }

  it("settles a capture with voidRemainder and reports the captured amount", async () => {
    authorized();
    const req = requirements();
    const call: EscrowCall = {
      fn: "capture",
      paymentInfo: paymentInfo(req),
      amount: "6000000",
      feeAmount: "0",
      feeReceiver: null,
      voidRemainder: true,
    };
    const payload = await lifecycle(req, call, { authorizationEntry: "ignored", salt: SALT });
    const settled = await facilitator().settle(paymentPayload(req, payload), {
      ...req,
      amount: "6000000",
    });
    expect(settled).toMatchObject({ success: true, amount: "6000000", payer });
  });

  it("checks capture balances, deadlines and payment info", async () => {
    authorized();
    const req = requirements();
    const info = paymentInfo(req);
    const call: EscrowCall = {
      fn: "capture",
      paymentInfo: info,
      amount: "6000000",
      feeAmount: "0",
      feeReceiver: null,
      voidRemainder: false,
    };
    const verify = async (r: PaymentRequirements, p: object) =>
      (await facilitator().verify(paymentPayload(r, p), r)).invalidReason;

    state.capturable = 1n;
    expect(await verify(req, await lifecycle(req, call))).toBe(
      "invalid_auth_capture_stellar_insufficient_balance",
    );
    authorized();

    const late = requirements({ captureDeadline: now() - 10 });
    const lateCall = { ...call, paymentInfo: paymentInfo(late) };
    expect(await verify(late, await lifecycle(late, lateCall))).toBe(
      "invalid_auth_capture_stellar_expired",
    );

    const mismatch = { ...call, paymentInfo: { ...info, token: ESCROW } };
    expect(await verify(req, await lifecycle(req, mismatch))).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );

    const authFlow = requirements({ paymentFlow: "authorization", captureMode: undefined });
    expect(
      await verify(
        authFlow,
        await lifecycle(authFlow, { ...call, paymentInfo: paymentInfo(authFlow) }),
      ),
    ).toBe("invalid_auth_capture_stellar_unsupported_payment_flow");
    expect(await verify(req, { type: "capture", paymentInfo: info })).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );
    expect(await verify(req, await lifecycle(req, { ...call, amount: "0" }))).toBe(
      "invalid_auth_capture_stellar_payload_format",
    );
  });

  it("voids the remaining hold and rejects a void without one", async () => {
    authorized();
    const req = requirements();
    const call: EscrowCall = { fn: "void", paymentInfo: paymentInfo(req) };
    const settled = await facilitator().settle(
      paymentPayload(req, await lifecycle(req, call)),
      req,
    );
    expect(settled).toMatchObject({ success: true, amount: MAX_AMOUNT });

    state.capturable = 0n;
    expect(
      (await facilitator().verify(paymentPayload(req, await lifecycle(req, call)), req))
        .invalidReason,
    ).toBe("invalid_auth_capture_stellar_insufficient_balance");
  });

  it("refunds from the consent address with the transfer under the consent entry", async () => {
    state = { collected: true, capturable: 0n, refundable: 6_000_000n };
    const req = requirements();
    const call: EscrowCall = {
      fn: "refund",
      paymentInfo: paymentInfo(req),
      amount: "2000000",
      funder: receiver,
    };
    const payload = await lifecycle(req, call);
    expect(await facilitator().verify(paymentPayload(req, payload), req)).toEqual({
      isValid: true,
      payer,
    });

    const withFunderEntry = { ...payload, funderEntry: payload.consentEntry };
    expect(
      (await facilitator().verify(paymentPayload(req, withFunderEntry), req)).invalidReason,
    ).toBe("invalid_auth_capture_stellar_consent_entry");
    const tooMuch = await lifecycle(req, { ...call, amount: "7000000" });
    expect((await facilitator().verify(paymentPayload(req, tooMuch), req)).invalidReason).toBe(
      "invalid_auth_capture_stellar_insufficient_balance",
    );
  });

  it("refunds from a separate funder that signs its own entry", async () => {
    state = { collected: true, capturable: 0n, refundable: 6_000_000n };
    const req = requirements();
    const funder = keys.funder.publicKey();
    const call: EscrowCall = {
      fn: "refund",
      paymentInfo: paymentInfo(req),
      amount: "2000000",
      funder,
    };
    const funderEntry = (await signedEntry(keys.funder, funderInvocation(ESCROW, call))).toXDR(
      "base64",
    );
    const payload = await lifecycle(req, call, { funderEntry });
    expect(await facilitator().verify(paymentPayload(req, payload), req)).toEqual({
      isValid: true,
      payer,
    });

    const missing = await lifecycle(req, call);
    expect((await facilitator().verify(paymentPayload(req, missing), req)).invalidReason).toBe(
      "invalid_auth_capture_stellar_consent_entry",
    );
    const operatorFunds = await lifecycle(req, { ...call, funder: operator });
    expect(
      (await facilitator().verify(paymentPayload(req, operatorFunds), req)).invalidReason,
    ).toBe("invalid_auth_capture_stellar_facilitator_safety");
    const late = requirements({ captureDeadline: now() - 20, refundDeadline: now() - 10 });
    const lateCall = { ...call, paymentInfo: paymentInfo(late) };
    expect(
      (
        await facilitator().verify(
          paymentPayload(late, await lifecycle(late, lateCall, { funderEntry })),
          late,
        )
      ).invalidReason,
    ).toBe("invalid_auth_capture_stellar_expired");
  });

  it("rejects expired and unsigned consent entries", async () => {
    authorized();
    const req = requirements();
    const call: EscrowCall = { fn: "void", paymentInfo: paymentInfo(req) };
    const expired = (
      await signedEntry(keys.receiver, consentInvocation(ESCROW, call), CURRENT_LEDGER)
    ).toXDR("base64");
    const verify = async (consentEntry: string) =>
      (
        await facilitator().verify(
          paymentPayload(req, { type: "void", paymentInfo: call.paymentInfo, consentEntry }),
          req,
        )
      ).invalidReason;
    expect(await verify(expired)).toBe("invalid_auth_capture_stellar_expired");
    const unsigned = unsignedEntry(receiver, consentInvocation(ESCROW, call));
    unsigned
      .credentials()
      .address()
      .signatureExpirationLedger(CURRENT_LEDGER + 5);
    expect(await verify(unsigned.toXDR("base64"))).toBe("invalid_auth_capture_stellar_signature");
    const byOperator = (await signedEntry(keys.operator, consentInvocation(ESCROW, call))).toXDR(
      "base64",
    );
    expect(await verify(byOperator)).toBe("invalid_auth_capture_stellar_facilitator_safety");
  });

  it("handles the operator as consent address only when allowed", async () => {
    authorized();
    const req = requirements({ receiverAuthorizer: operator });
    const info = paymentInfo(req);
    lastCall = { fn: "void", paymentInfo: info };
    const payload = { type: "void", paymentInfo: info };
    expect((await facilitator().verify(paymentPayload(req, payload), req)).invalidReason).toBe(
      "invalid_auth_capture_stellar_facilitator_safety",
    );
    const own = facilitator({ allowOperatorConsent: true });
    expect(await own.verify(paymentPayload(req, payload), req)).toEqual({ isValid: true, payer });
    expect(
      (
        await own.verify(
          paymentPayload(req, { ...payload, consentEntry: await consent(lastCall) }),
          req,
        )
      ).invalidReason,
    ).toBe("invalid_auth_capture_stellar_consent_entry");
  });
});
