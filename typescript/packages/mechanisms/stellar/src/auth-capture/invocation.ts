import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { getAddressCredentials } from "../shared";
import {
  addressScVal,
  consentAddress,
  i128,
  optionalAddress,
  paymentInfoToScVal,
} from "./paymentInfo";
import type { PaymentInfoJson } from "./types";

/** A fully specified call into `AuthCaptureEscrow`. */
export type EscrowCall =
  | { fn: "authorize"; paymentInfo: PaymentInfoJson }
  | {
      fn: "charge";
      paymentInfo: PaymentInfoJson;
      amount: string;
      feeAmount: string;
      feeReceiver: string | null;
    }
  | {
      fn: "capture";
      paymentInfo: PaymentInfoJson;
      amount: string;
      feeAmount: string;
      feeReceiver: string | null;
      voidRemainder: boolean;
    }
  | { fn: "void"; paymentInfo: PaymentInfoJson }
  | { fn: "refund"; paymentInfo: PaymentInfoJson; amount: string; funder: string };

/**
 * Encodes the arguments of an escrow call in signature order.
 *
 * @param call - Escrow call
 * @returns Contract call arguments
 */
export function escrowCallArgs(call: EscrowCall): xdr.ScVal[] {
  const info = paymentInfoToScVal(call.paymentInfo);
  switch (call.fn) {
    case "authorize":
    case "void":
      return [info];
    case "charge":
      return [info, i128(call.amount), i128(call.feeAmount), optionalAddress(call.feeReceiver)];
    case "capture":
      return [
        info,
        i128(call.amount),
        i128(call.feeAmount),
        optionalAddress(call.feeReceiver),
        xdr.ScVal.scvBool(call.voidRemainder),
      ];
    case "refund":
      return [info, i128(call.amount), addressScVal(call.funder)];
  }
}

/**
 * Builds `InvokeContractArgs` for a contract call.
 *
 * @param contract - Contract address
 * @param fn - Function name
 * @param args - Arguments
 * @returns Contract invocation arguments
 */
export function invokeContractArgs(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: new Address(contract).toScAddress(),
    functionName: fn,
    args,
  });
}

/**
 * Builds the host function that invokes an escrow call.
 *
 * @param escrow - Escrow contract address
 * @param call - Escrow call
 * @returns Host function for an `invokeHostFunction` operation
 */
export function escrowHostFunction(escrow: string, call: EscrowCall): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    invokeContractArgs(escrow, call.fn, escrowCallArgs(call)),
  );
}

/**
 * Builds an authorized invocation node.
 *
 * @param contract - Contract address
 * @param fn - Function name
 * @param args - Arguments
 * @param subInvocations - Child nodes
 * @returns Authorized invocation
 */
function invocation(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      invokeContractArgs(contract, fn, args),
    ),
    subInvocations,
  });
}

/**
 * The SEP-41 `transfer(from, to, amount)` node.
 *
 * @param token - Token contract
 * @param from - Sender
 * @param to - Recipient
 * @param amount - Amount
 * @returns Authorized invocation
 */
function transferInvocation(
  token: string,
  from: string,
  to: string,
  amount: string,
): xdr.SorobanAuthorizedInvocation {
  return invocation(token, "transfer", [addressScVal(from), addressScVal(to), i128(amount)]);
}

/**
 * The tree the payer authorizes for `authorize` or `charge`: root `fn(payment_info)` with
 * exactly one sub-invocation `token.transfer(payer, escrow, max_amount)`.
 *
 * @param escrow - Escrow contract address
 * @param fn - `authorize` or `charge`
 * @param info - Payment info
 * @returns Expected invocation tree
 */
export function payerInvocation(
  escrow: string,
  fn: "authorize" | "charge",
  info: PaymentInfoJson,
): xdr.SorobanAuthorizedInvocation {
  return invocation(
    escrow,
    fn,
    [paymentInfoToScVal(info)],
    [transferInvocation(info.token, info.payer, escrow, info.maxAmount)],
  );
}

/**
 * The tree the consent address authorizes: the exact escrow call with all arguments. For a
 * refund funded by the consent address it carries `token.transfer(funder, payer, amount)`.
 *
 * @param escrow - Escrow contract address
 * @param call - Escrow call
 * @returns Expected invocation tree
 */
export function consentInvocation(
  escrow: string,
  call: EscrowCall,
): xdr.SorobanAuthorizedInvocation {
  const subs =
    call.fn === "refund" && call.funder === consentAddress(call.paymentInfo)
      ? [
          transferInvocation(
            call.paymentInfo.token,
            call.funder,
            call.paymentInfo.payer,
            call.amount,
          ),
        ]
      : [];
  return invocation(escrow, call.fn, escrowCallArgs(call), subs);
}

/**
 * The tree a separate refund funder authorizes: the `refund` call with exactly one
 * sub-invocation `token.transfer(funder, payer, amount)`.
 *
 * @param escrow - Escrow contract address
 * @param call - Refund call
 * @returns Expected invocation tree
 */
export function funderInvocation(
  escrow: string,
  call: Extract<EscrowCall, { fn: "refund" }>,
): xdr.SorobanAuthorizedInvocation {
  return invocation(escrow, "refund", escrowCallArgs(call), [
    transferInvocation(call.paymentInfo.token, call.funder, call.paymentInfo.payer, call.amount),
  ]);
}

/**
 * The operator's entry: source-account credentials over the exact escrow call. The
 * transaction source signature satisfies it, so the facilitator signs no entry.
 *
 * @param escrow - Escrow contract address
 * @param call - Escrow call
 * @returns Authorization entry with source-account credentials
 */
export function operatorEntry(escrow: string, call: EscrowCall): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation(escrow, call.fn, escrowCallArgs(call)),
  });
}

/**
 * Decodes a base64 `SorobanAuthorizationEntry`.
 *
 * @param base64 - Entry XDR
 * @returns The entry, or undefined when it does not decode
 */
export function decodeAuthEntry(base64: unknown): xdr.SorobanAuthorizationEntry | undefined {
  if (typeof base64 !== "string" || base64.length === 0) return undefined;
  try {
    return xdr.SorobanAuthorizationEntry.fromXDR(base64, "base64");
  } catch {
    return undefined;
  }
}

/** Shape-check outcome for one authorization entry. */
export type EntryCheck =
  | { ok: true; address: string; expirationLedger: number }
  | { ok: false; problem: "credentials" | "address" | "invocation" };

/**
 * Reads the address of an entry with address credentials (V1 or CAP-71 V2).
 *
 * @param entry - Authorization entry
 * @returns The address, or undefined for any other credential arm
 */
export function entryAddress(entry: xdr.SorobanAuthorizationEntry): string | undefined {
  const credentials = getAddressCredentials(entry.credentials());
  return credentials ? Address.fromScAddress(credentials.address()).toString() : undefined;
}

/**
 * Checks an entry's credentials, address and invocation tree. Only `sorobanCredentialsAddress`
 * and `sorobanCredentialsAddressV2` are accepted; the tree must equal `expected` exactly.
 *
 * @param entry - Authorization entry
 * @param expectedAddress - Required credential address
 * @param expected - Required invocation tree
 * @returns The address and expiration ledger, or the failed check
 */
export function checkEntry(
  entry: xdr.SorobanAuthorizationEntry,
  expectedAddress: string,
  expected: xdr.SorobanAuthorizedInvocation,
): EntryCheck {
  const credentials = getAddressCredentials(entry.credentials());
  if (!credentials) return { ok: false, problem: "credentials" };
  const address = Address.fromScAddress(credentials.address()).toString();
  if (address !== expectedAddress) return { ok: false, problem: "address" };
  if (!entry.rootInvocation().toXDR().equals(expected.toXDR())) {
    return { ok: false, problem: "invocation" };
  }
  return { ok: true, address, expirationLedger: credentials.signatureExpirationLedger() };
}

/**
 * Reads the amount of the payer entry's `transfer` sub-invocation, if the entry has the
 * expected shape. Used to recover `max_amount` when `requirements.amount` carries a
 * settlement override.
 *
 * @param entry - Payer's authorization entry
 * @returns Amount as a decimal string, or undefined
 */
export function entryTransferAmount(entry: xdr.SorobanAuthorizationEntry): string | undefined {
  try {
    const subs = entry.rootInvocation().subInvocations();
    if (subs.length !== 1) return undefined;
    const args = subs[0].function().contractFn().args();
    if (args.length !== 3) return undefined;
    const amount = scValToNative(args[2]) as unknown;
    return typeof amount === "bigint" ? amount.toString() : undefined;
  } catch {
    return undefined;
  }
}
