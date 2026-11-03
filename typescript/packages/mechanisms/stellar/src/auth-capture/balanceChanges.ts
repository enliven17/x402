import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { feeBounds } from "./extra";
import type { EscrowCall } from "./invocation";
import type { PaymentState } from "./types";

/** Net token balance change per address. Zero entries are omitted. */
export type BalanceChanges = Map<string, bigint>;

/**
 * Adds a delta to an address, dropping it when the net becomes zero.
 *
 * @param changes - Accumulator
 * @param address - Holder
 * @param delta - Signed change
 */
function addChange(changes: BalanceChanges, address: string, delta: bigint): void {
  const next = (changes.get(address) ?? 0n) + delta;
  if (next === 0n) {
    changes.delete(address);
  } else {
    changes.set(address, next);
  }
}

/**
 * Reads the amount from a transfer event body: an `i128`, or a map with an `amount` key
 * (CAP-67 transfers to muxed destinations).
 *
 * @param data - Event data
 * @returns Amount
 */
function transferAmount(data: xdr.ScVal): bigint {
  const native = scValToNative(data) as unknown;
  if (typeof native === "bigint") return native;
  if (typeof native === "object" && native !== null && "amount" in native) {
    return BigInt((native as { amount: bigint }).amount);
  }
  throw new Error("transfer event has no amount");
}

/**
 * Derives net token balance changes from simulation events. Only `transfer` events of the
 * token count. Any other event of the token, or any contract event from a contract other than
 * the token and the escrow, is rejected.
 *
 * @param events - Simulation diagnostic events
 * @param token - Token contract address
 * @param escrow - Escrow contract address
 * @returns Net balance changes, or an error message
 */
export function balanceChangesFromEvents(
  events: xdr.DiagnosticEvent[],
  token: string,
  escrow: string,
): { changes: BalanceChanges } | { error: string } {
  const changes: BalanceChanges = new Map();
  for (const diagnostic of events) {
    if (!diagnostic.inSuccessfulContractCall()) continue;
    const event = diagnostic.event();
    if (event.type().name !== "contract") continue;

    const contractId = event.contractId();
    if (!contractId) return { error: "contract event without contract id" };
    const contract = Address.fromScAddress(
      xdr.ScAddress.scAddressTypeContract(contractId),
    ).toString();
    if (contract === escrow) continue;
    if (contract !== token) return { error: `unexpected event from ${contract}` };

    const body = event.body().v0();
    const topics = body.topics();
    const name = topics[0]?.switch().name === "scvSymbol" ? topics[0].sym().toString() : "";
    if (name !== "transfer" || topics.length < 3) {
      return { error: `unexpected token event ${name || "(unnamed)"}` };
    }
    const from = scValToNative(topics[1]) as string;
    const to = scValToNative(topics[2]) as string;
    const amount = transferAmount(body.data());
    addChange(changes, from, -amount);
    addChange(changes, to, amount);
  }
  return { changes };
}

/**
 * Balance changes the spec allows for an escrow call.
 *
 * @param call - Escrow call
 * @param escrow - Escrow contract address
 * @param state - Payment state before the call (capturable balance for capture and void)
 * @returns Expected net balance changes
 */
export function expectedBalanceChanges(
  call: EscrowCall,
  escrow: string,
  state: PaymentState,
): BalanceChanges {
  const changes: BalanceChanges = new Map();
  const info = call.paymentInfo;
  const pay = (amount: bigint, fee: bigint, feeReceiver: string | null) => {
    if (fee > 0n && feeReceiver) addChange(changes, feeReceiver, fee);
    addChange(changes, info.receiver, amount - fee);
  };

  switch (call.fn) {
    case "authorize": {
      const max = BigInt(info.maxAmount);
      addChange(changes, info.payer, -max);
      addChange(changes, escrow, max);
      break;
    }
    case "charge": {
      const amount = BigInt(call.amount);
      addChange(changes, info.payer, -amount);
      pay(amount, BigInt(call.feeAmount), call.feeReceiver);
      break;
    }
    case "capture": {
      const amount = BigInt(call.amount);
      const released = call.voidRemainder ? state.capturable : amount;
      addChange(changes, escrow, -released);
      pay(amount, BigInt(call.feeAmount), call.feeReceiver);
      if (call.voidRemainder) addChange(changes, info.payer, state.capturable - amount);
      break;
    }
    case "void":
      addChange(changes, escrow, -state.capturable);
      addChange(changes, info.payer, state.capturable);
      break;
    case "refund": {
      const amount = BigInt(call.amount);
      addChange(changes, call.funder, -amount);
      addChange(changes, info.payer, amount);
      break;
    }
  }
  return changes;
}

/**
 * Whether two balance-change maps are identical.
 *
 * @param actual - Observed changes
 * @param expected - Allowed changes
 * @returns True when both contain the same addresses with the same deltas
 */
export function sameBalanceChanges(actual: BalanceChanges, expected: BalanceChanges): boolean {
  if (actual.size !== expected.size) return false;
  for (const [address, delta] of expected) {
    if (actual.get(address) !== delta) return false;
  }
  return true;
}

/**
 * Default fee for a server-chosen amount: the escrow's minimum.
 *
 * @param amount - Charged or captured amount
 * @param minFeeBps - Fee floor
 * @returns Minimum fee amount
 */
export function defaultFeeAmount(amount: bigint, minFeeBps: number): bigint {
  return feeBounds(amount, minFeeBps, minFeeBps).min;
}
