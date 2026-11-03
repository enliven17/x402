import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  contractEvent,
  ESCROW,
  escrowEvent,
  keys,
  MAX_AMOUNT,
  PASSPHRASE,
  paymentInfo,
  signedEntry,
  TOKEN,
  transferEvent,
  unsignedEntry,
} from "./fixtures";
import {
  balanceChangesFromEvents,
  expectedBalanceChanges,
  sameBalanceChanges,
} from "../../../src/auth-capture/balanceChanges";
import { verifyEntrySignatures } from "../../../src/auth-capture/facilitator/checks";
import {
  checkEntry,
  consentInvocation,
  decodeAuthEntry,
  entryAddress,
  entryTransferAmount,
  escrowCallArgs,
  funderInvocation,
  invokeContractArgs,
  operatorEntry,
  payerInvocation,
  type EscrowCall,
} from "../../../src/auth-capture/invocation";
import { addressScVal, i128, paymentInfoToScVal } from "../../../src/auth-capture/paymentInfo";
import { simulationErrorReason } from "../../../src/auth-capture/soroban";

const payer = keys.payer.publicKey();
const info = paymentInfo();

/**
 * Builds an invocation node.
 *
 * @param contract - Contract
 * @param fn - Function
 * @param args - Args
 * @param subs - Sub-invocations
 * @returns Node
 */
function node(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      invokeContractArgs(contract, fn, args),
    ),
    subInvocations: subs,
  });
}

const transfer = (from: string, to: string, amount: string) =>
  node(TOKEN, "transfer", [addressScVal(from), addressScVal(to), i128(amount)]);

describe("payer entry shape", () => {
  const expected = payerInvocation(ESCROW, "authorize", info);

  it("roots at authorize(payment_info) with one transfer into the escrow", () => {
    const root = expected;
    expect(root.function().contractFn().functionName().toString()).toBe("authorize");
    expect(root.function().contractFn().args()).toHaveLength(1);
    expect(root.subInvocations()).toHaveLength(1);
    expect(entryTransferAmount(unsignedEntry(payer, root))).toBe(MAX_AMOUNT);
  });

  it("accepts the exact tree with V1 and V2 address credentials", () => {
    const entry = unsignedEntry(payer, expected);
    expect(checkEntry(entry, payer, expected)).toMatchObject({ ok: true, address: payer });

    const v2 = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        entry.credentials().address(),
      ),
      rootInvocation: expected,
    });
    expect(checkEntry(v2, payer, expected).ok).toBe(true);
    expect(entryAddress(v2)).toBe(payer);
  });

  it("rejects source-account credentials", () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: expected,
    });
    expect(checkEntry(entry, payer, expected)).toEqual({ ok: false, problem: "credentials" });
    expect(entryAddress(entry)).toBeUndefined();
  });

  it("rejects another address", () => {
    const entry = unsignedEntry(keys.receiver.publicKey(), expected);
    expect(checkEntry(entry, payer, expected)).toEqual({ ok: false, problem: "address" });
  });

  it.each([
    [
      "wrong function",
      node(ESCROW, "charge", [paymentInfoToScVal(info)], [transfer(payer, ESCROW, MAX_AMOUNT)]),
    ],
    [
      "wrong contract",
      node(TOKEN, "authorize", [paymentInfoToScVal(info)], [transfer(payer, ESCROW, MAX_AMOUNT)]),
    ],
    [
      "wrong args",
      node(
        ESCROW,
        "authorize",
        [paymentInfoToScVal({ ...info, maxAmount: "1" })],
        [transfer(payer, ESCROW, MAX_AMOUNT)],
      ),
    ],
    [
      "extra args",
      node(
        ESCROW,
        "authorize",
        [paymentInfoToScVal(info), i128("1")],
        [transfer(payer, ESCROW, MAX_AMOUNT)],
      ),
    ],
    ["missing sub-invocation", node(ESCROW, "authorize", [paymentInfoToScVal(info)])],
    [
      "extra sub-invocation",
      node(
        ESCROW,
        "authorize",
        [paymentInfoToScVal(info)],
        [transfer(payer, ESCROW, MAX_AMOUNT), transfer(payer, keys.operator.publicKey(), "1")],
      ),
    ],
    [
      "nested sub-invocation",
      node(
        ESCROW,
        "authorize",
        [paymentInfoToScVal(info)],
        [
          node(
            TOKEN,
            "transfer",
            [addressScVal(payer), addressScVal(ESCROW), i128(MAX_AMOUNT)],
            [transfer(payer, ESCROW, "1")],
          ),
        ],
      ),
    ],
    [
      "transfer to someone else",
      node(
        ESCROW,
        "authorize",
        [paymentInfoToScVal(info)],
        [transfer(payer, keys.operator.publicKey(), MAX_AMOUNT)],
      ),
    ],
  ])("rejects %s", (_, invocation) => {
    expect(checkEntry(unsignedEntry(payer, invocation), payer, expected)).toEqual({
      ok: false,
      problem: "invocation",
    });
  });

  it("decodes base64 entries and rejects garbage", () => {
    const entry = unsignedEntry(payer, expected);
    expect(decodeAuthEntry(entry.toXDR("base64"))?.toXDR("base64")).toBe(entry.toXDR("base64"));
    expect(decodeAuthEntry("not-xdr")).toBeUndefined();
    expect(decodeAuthEntry(undefined)).toBeUndefined();
    expect(entryTransferAmount(unsignedEntry(payer, node(ESCROW, "x", [])))).toBeUndefined();
  });
});

describe("consent, funder and operator entries", () => {
  const capture: EscrowCall = {
    fn: "capture",
    paymentInfo: info,
    amount: "5",
    feeAmount: "0",
    feeReceiver: null,
    voidRemainder: true,
  };

  it("binds every call argument", () => {
    expect(escrowCallArgs(capture).map(arg => arg.switch().name)).toEqual([
      "scvMap",
      "scvI128",
      "scvI128",
      "scvVoid",
      "scvBool",
    ]);
    const consent = consentInvocation(ESCROW, capture);
    expect(consent.subInvocations()).toHaveLength(0);
    const other = consentInvocation(ESCROW, { ...capture, amount: "6" });
    expect(consent.toXDR().equals(other.toXDR())).toBe(false);
  });

  it("puts the refund transfer under the consent entry when the consent address funds it", () => {
    const refund: EscrowCall = {
      fn: "refund",
      paymentInfo: info,
      amount: "5",
      funder: info.receiver,
    };
    const consent = consentInvocation(ESCROW, refund);
    expect(consent.subInvocations()).toHaveLength(1);
    expect(
      consent
        .subInvocations()[0]
        .toXDR()
        .equals(transfer(info.receiver, payer, "5").toXDR()),
    ).toBe(true);

    const separate: EscrowCall = { ...refund, funder: keys.funder.publicKey() };
    expect(consentInvocation(ESCROW, separate).subInvocations()).toHaveLength(0);
    const funder = funderInvocation(ESCROW, separate);
    expect(funder.function().contractFn().functionName().toString()).toBe("refund");
    expect(
      funder
        .subInvocations()[0]
        .toXDR()
        .equals(transfer(keys.funder.publicKey(), payer, "5").toXDR()),
    ).toBe(true);
  });

  it("builds the operator entry with source-account credentials", () => {
    const entry = operatorEntry(ESCROW, { fn: "void", paymentInfo: info });
    expect(entry.credentials().switch().name).toBe("sorobanCredentialsSourceAccount");
    expect(entry.rootInvocation().subInvocations()).toHaveLength(0);
  });
});

describe("local signature verification", () => {
  const invocation = payerInvocation(ESCROW, "authorize", info);

  it("accepts a valid Ed25519 signature", async () => {
    const entry = await signedEntry(keys.payer, invocation);
    expect(verifyEntrySignatures(entry, PASSPHRASE)).toBe(true);
  });

  it("rejects unsigned entries, tampered entries and other networks", async () => {
    expect(verifyEntrySignatures(unsignedEntry(payer, invocation), PASSPHRASE)).toBe(false);
    const entry = await signedEntry(keys.payer, invocation);
    expect(verifyEntrySignatures(entry, "Public Global Stellar Network ; September 2015")).toBe(
      false,
    );
    const tampered = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    tampered.credentials().address().signatureExpirationLedger(99_999);
    expect(verifyEntrySignatures(tampered, PASSPHRASE)).toBe(false);
  });

  it("rejects a signature that does not cover the entry", async () => {
    const entry = await signedEntry(keys.payer, invocation);
    const replayed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    replayed.credentials().address().nonce(xdr.Int64.fromString("2"));
    expect(verifyEntrySignatures(replayed, PASSPHRASE)).toBe(false);
  });

  it("leaves contract accounts to the network", () => {
    expect(verifyEntrySignatures(unsignedEntry(ESCROW, invocation), PASSPHRASE)).toBe(true);
  });
});

describe("balance changes", () => {
  it("nets transfer events and ignores escrow events", () => {
    const result = balanceChangesFromEvents(
      [transferEvent(payer, ESCROW, "10"), escrowEvent(), transferEvent(ESCROW, payer, "4")],
      TOKEN,
      ESCROW,
    );
    expect("changes" in result && [...result.changes]).toEqual([
      [payer, -6n],
      [ESCROW, 6n],
    ]);
  });

  it("rejects other token events and foreign contracts", () => {
    const mint = contractEvent(
      TOKEN,
      [xdr.ScVal.scvSymbol("mint"), addressScVal(payer)],
      i128("1"),
    );
    expect(balanceChangesFromEvents([mint], TOKEN, ESCROW)).toEqual({
      error: "unexpected token event mint",
    });
    const foreign = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
    expect(
      balanceChangesFromEvents([transferEvent(payer, ESCROW, "1", foreign)], TOKEN, ESCROW),
    ).toEqual({
      error: `unexpected event from ${foreign}`,
    });
  });

  it("reads amounts from muxed transfer data maps", () => {
    const data = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: i128("7") }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("to_muxed_id"),
        val: xdr.ScVal.scvU64(new xdr.Uint64(1n)),
      }),
    ]);
    const event = contractEvent(
      TOKEN,
      [xdr.ScVal.scvSymbol("transfer"), addressScVal(payer), addressScVal(ESCROW)],
      data,
    );
    const result = balanceChangesFromEvents([event], TOKEN, ESCROW);
    expect("changes" in result && result.changes.get(ESCROW)).toBe(7n);
  });

  it("matches the spec table per operation", () => {
    const state = { collected: true, capturable: 10n, refundable: 0n };
    const fee = keys.feeRecipient.publicKey();
    const withFee = { ...info, feeReceiver: fee };
    const receiver = info.receiver;

    expect([
      ...expectedBalanceChanges(
        { fn: "authorize", paymentInfo: { ...info, maxAmount: "10" } },
        ESCROW,
        state,
      ),
    ]).toEqual([
      [payer, -10n],
      [ESCROW, 10n],
    ]);
    expect(
      Object.fromEntries(
        expectedBalanceChanges(
          { fn: "charge", paymentInfo: withFee, amount: "8", feeAmount: "1", feeReceiver: fee },
          ESCROW,
          state,
        ),
      ),
    ).toEqual({ [payer]: -8n, [fee]: 1n, [receiver]: 7n });
    expect(
      Object.fromEntries(
        expectedBalanceChanges(
          {
            fn: "capture",
            paymentInfo: info,
            amount: "6",
            feeAmount: "0",
            feeReceiver: null,
            voidRemainder: true,
          },
          ESCROW,
          state,
        ),
      ),
    ).toEqual({ [ESCROW]: -10n, [receiver]: 6n, [payer]: 4n });
    expect(
      Object.fromEntries(
        expectedBalanceChanges(
          {
            fn: "capture",
            paymentInfo: info,
            amount: "6",
            feeAmount: "0",
            feeReceiver: null,
            voidRemainder: false,
          },
          ESCROW,
          state,
        ),
      ),
    ).toEqual({ [ESCROW]: -6n, [receiver]: 6n });
    expect(
      Object.fromEntries(expectedBalanceChanges({ fn: "void", paymentInfo: info }, ESCROW, state)),
    ).toEqual({ [ESCROW]: -10n, [payer]: 10n });
    expect(
      Object.fromEntries(
        expectedBalanceChanges(
          { fn: "refund", paymentInfo: info, amount: "3", funder: receiver },
          ESCROW,
          state,
        ),
      ),
    ).toEqual({ [receiver]: -3n, [payer]: 3n });
  });

  it("compares maps exactly", () => {
    const a = new Map([[payer, 1n]]);
    expect(sameBalanceChanges(a, new Map([[payer, 1n]]))).toBe(true);
    expect(sameBalanceChanges(a, new Map([[payer, 2n]]))).toBe(false);
    expect(
      sameBalanceChanges(
        a,
        new Map([
          [payer, 1n],
          [ESCROW, 1n],
        ]),
      ),
    ).toBe(false);
  });
});

describe("simulation error mapping", () => {
  const escrowError = (code: number) =>
    `HostError: Error(Contract, #${code})\n0: [Diagnostic Event] contract:${ESCROW}, topics:[error, Error(Contract, #${code})]`;

  it.each([
    [10, "invalid_auth_capture_stellar_already_collected"],
    [3, "invalid_auth_capture_stellar_expired"],
    [12, "invalid_auth_capture_stellar_insufficient_balance"],
    [16, "invalid_auth_capture_stellar_insufficient_balance"],
    [7, "invalid_auth_capture_stellar_payload_format"],
    [99, "invalid_auth_capture_stellar_simulation_failed"],
  ])("maps escrow error #%i", (code, reason) => {
    expect(simulationErrorReason(escrowError(code), ESCROW)).toBe(reason);
  });

  it("maps token balance, auth and unknown failures", () => {
    expect(
      simulationErrorReason(
        `contract:${TOKEN}, topics:[error, Error(Contract, #10)], data:["resulting balance is not within the allowed range"]`,
        ESCROW,
      ),
    ).toBe("invalid_auth_capture_stellar_insufficient_balance");
    expect(simulationErrorReason("HostError: Error(Auth, InvalidAction)", ESCROW)).toBe(
      "invalid_auth_capture_stellar_signature",
    );
    expect(simulationErrorReason(`contract:${TOKEN}, Error(Contract, #10)`, ESCROW)).toBe(
      "invalid_auth_capture_stellar_simulation_failed",
    );
  });
});
