import {
  Account,
  authorizeEntry,
  BASE_FEE,
  Operation,
  rpc,
  scValToNative,
  TimeoutInfinite,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { getEstimatedLedgerCloseTimeSeconds } from "../utils";
import * as Errors from "./errors";
import {
  escrowHostFunction,
  entryAddress,
  invokeContractArgs,
  type EscrowCall,
} from "./invocation";
import { addressScVal } from "./paymentInfo";
import type { ClientStellarSigner } from "../signer";
import type { PaymentState } from "./types";
import type { Network } from "@x402/core/types";

/** Placeholder source for read-only and recording-mode simulations. */
export const SIMULATION_SOURCE_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Builds a single-operation transaction invoking a host function.
 *
 * @param source - Source account (sequence already loaded, or the placeholder)
 * @param networkPassphrase - Network passphrase
 * @param func - Host function
 * @param auth - Authorization entries to attach
 * @returns The unsigned transaction
 */
export function buildInvokeTransaction(
  source: Account,
  networkPassphrase: string,
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[] = [],
): Transaction {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .setTimeout(TimeoutInfinite)
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .build();
}

/**
 * Simulates a read-only contract call and returns its decoded result.
 *
 * @param server - Soroban RPC server
 * @param networkPassphrase - Network passphrase
 * @param contract - Contract address
 * @param fn - Function name
 * @param args - Arguments
 * @returns The return value as an `ScVal`
 * @throws If the simulation fails
 */
async function readContract(
  server: rpc.Server,
  networkPassphrase: string,
  contract: string,
  fn: string,
  args: xdr.ScVal[],
): Promise<xdr.ScVal> {
  const tx = buildInvokeTransaction(
    new Account(SIMULATION_SOURCE_ACCOUNT, "0"),
    networkPassphrase,
    xdr.HostFunction.hostFunctionTypeInvokeContract(invokeContractArgs(contract, fn, args)),
  );
  const sim = await server.simulateTransaction(tx);
  if (!Api.isSimulationSuccess(sim) || !sim.result) {
    const error = Api.isSimulationError(sim) ? sim.error : "no result";
    throw new Error(`${contract}.${fn} simulation failed: ${error}`);
  }
  return sim.result.retval;
}

/**
 * Reads `payment_state(payment_hash)` from the escrow.
 *
 * @param server - Soroban RPC server
 * @param networkPassphrase - Network passphrase
 * @param escrow - Escrow contract address
 * @param paymentHash - Payment hash as hex
 * @returns Collected flag and capturable / refundable balances
 */
export async function readPaymentState(
  server: rpc.Server,
  networkPassphrase: string,
  escrow: string,
  paymentHash: string,
): Promise<PaymentState> {
  const retval = await readContract(server, networkPassphrase, escrow, "payment_state", [
    xdr.ScVal.scvBytes(Buffer.from(paymentHash, "hex")),
  ]);
  const state = scValToNative(retval) as {
    collected: boolean;
    capturable: bigint;
    refundable: bigint;
  };
  return {
    collected: state.collected,
    capturable: BigInt(state.capturable),
    refundable: BigInt(state.refundable),
  };
}

/**
 * Reads a SEP-41 `balance(id)`.
 *
 * @param server - Soroban RPC server
 * @param networkPassphrase - Network passphrase
 * @param token - Token contract address
 * @param address - Holder
 * @returns Balance in base units
 */
export async function readTokenBalance(
  server: rpc.Server,
  networkPassphrase: string,
  token: string,
  address: string,
): Promise<bigint> {
  const retval = await readContract(server, networkPassphrase, token, "balance", [
    addressScVal(address),
  ]);
  return BigInt(scValToNative(retval) as bigint);
}

/**
 * Simulates an escrow call in recording mode and returns the recorded authorization entries.
 * Recorded address entries are unsigned and carry fresh random nonces.
 *
 * @param server - Soroban RPC server
 * @param networkPassphrase - Network passphrase
 * @param escrow - Escrow contract address
 * @param call - Escrow call
 * @returns Recorded authorization entries
 * @throws If the simulation fails
 */
export async function recordEscrowAuth(
  server: rpc.Server,
  networkPassphrase: string,
  escrow: string,
  call: EscrowCall,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const tx = buildInvokeTransaction(
    new Account(SIMULATION_SOURCE_ACCOUNT, "0"),
    networkPassphrase,
    escrowHostFunction(escrow, call),
  );
  const sim = await server.simulateTransaction(tx, undefined, "record");
  if (!Api.isSimulationSuccess(sim) || !sim.result) {
    const error = Api.isSimulationError(sim) ? sim.error : "no result";
    throw new Error(`escrow ${call.fn} simulation failed: ${error}`);
  }
  return sim.result.auth;
}

/**
 * Returns the recorded entry for an address.
 *
 * @param entries - Recorded entries
 * @param address - Address to find
 * @returns The entry
 * @throws If there is not exactly one entry for the address
 */
export function entryFor(
  entries: xdr.SorobanAuthorizationEntry[],
  address: string,
): xdr.SorobanAuthorizationEntry {
  const matches = entries.filter(entry => entryAddress(entry) === address);
  if (matches.length !== 1) {
    throw new Error(`expected one authorization entry for ${address}, found ${matches.length}`);
  }
  return matches[0];
}

/**
 * Signs an authorization entry with a SEP-43 signer.
 *
 * @param entry - Unsigned entry with address credentials
 * @param signer - Signer for the entry's address
 * @param expirationLedger - `signatureExpirationLedger` to commit to
 * @param networkPassphrase - Network passphrase
 * @returns The signed entry
 */
export async function signEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signer: ClientStellarSigner,
  expirationLedger: number,
  networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(
    entry,
    async preimage => {
      const { signedAuthEntry, error } = await signer.signAuthEntry(preimage.toXDR("base64"), {
        address: signer.address,
        networkPassphrase,
      });
      if (error) {
        throw new Error(`signAuthEntry failed: ${error.message}`);
      }
      return Buffer.from(signedAuthEntry, "base64");
    },
    expirationLedger,
    networkPassphrase,
  );
}

/**
 * Computes the latest expiration ledger for an entry: `currentLedger + ceil(timeout / ledgerSeconds)`.
 *
 * @param server - Soroban RPC server
 * @param network - CAIP-2 network
 * @param timeoutSeconds - Validity window in seconds
 * @returns Current ledger and the expiration ledger
 */
export async function expirationLedgerFor(
  server: rpc.Server,
  network: Network,
  timeoutSeconds: number,
): Promise<{ currentLedger: number; expirationLedger: number }> {
  const [latest, ledgerSeconds] = await Promise.all([
    server.getLatestLedger(),
    getEstimatedLedgerCloseTimeSeconds(network),
  ]);
  const currentLedger = latest.sequence;
  return {
    currentLedger,
    expirationLedger: currentLedger + Math.ceil(timeoutSeconds / ledgerSeconds),
  };
}

const CONTRACT_ERROR_REGEX = /Error\(Contract, #(\d+)\)/;

/**
 * Maps a failed simulation to a verification reason. Escrow contract errors map through
 * {@link Errors.ESCROW_ERROR_TO_REASON}; authorization failures map to the signature reason;
 * token balance failures map to insufficient balance.
 *
 * @param error - Simulation error string
 * @param escrow - Escrow contract address
 * @returns Reason code
 */
export function simulationErrorReason(error: string, escrow: string): string {
  if (error.includes("resulting balance is not within the allowed range")) {
    return Errors.ErrInsufficientBalance;
  }
  for (const line of error.split("\n")) {
    if (!line.includes(escrow)) continue;
    const match = CONTRACT_ERROR_REGEX.exec(line);
    if (match) {
      return Errors.ESCROW_ERROR_TO_REASON[Number(match[1])] ?? Errors.ErrSimulationFailed;
    }
  }
  if (/Error\(Auth,/.test(error)) {
    return Errors.ErrSignature;
  }
  return Errors.ErrSimulationFailed;
}
