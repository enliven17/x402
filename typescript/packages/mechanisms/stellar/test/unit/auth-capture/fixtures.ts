import {
  Account,
  Address,
  authorizeEntry,
  Keypair,
  Networks,
  scValToNative,
  SorobanDataBuilder,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { vi } from "vitest";
import { AUTH_CAPTURE_ESCROW_ADDRESSES } from "../../../src/auth-capture/constants";
import {
  consentInvocation,
  funderInvocation,
  operatorEntry,
  payerInvocation,
  type EscrowCall,
} from "../../../src/auth-capture/invocation";
import {
  addressScVal,
  consentAddress,
  i128,
  paymentInfoFromScVal,
} from "../../../src/auth-capture/paymentInfo";
import { STELLAR_TESTNET_CAIP2, USDC_TESTNET_ADDRESS } from "../../../src/constants";
import type { PaymentInfoJson } from "../../../src/auth-capture/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

export const NETWORK = STELLAR_TESTNET_CAIP2;
export const PASSPHRASE = Networks.TESTNET;
export const ESCROW = AUTH_CAPTURE_ESCROW_ADDRESSES[NETWORK];
export const TOKEN = USDC_TESTNET_ADDRESS;
export const MAX_AMOUNT = "10000000";
export const CURRENT_LEDGER = 1000;
export const SALT = "11".repeat(32);

export const keys = {
  payer: Keypair.random(),
  receiver: Keypair.random(),
  operator: Keypair.random(),
  authorizer: Keypair.random(),
  feeRecipient: Keypair.random(),
  funder: Keypair.random(),
};

export const now = () => Math.floor(Date.now() / 1000);

/**
 * Valid `extra` with optional overrides.
 *
 * @param overrides - Fields to replace
 * @returns Extra
 */
export function extra(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    areFeesSponsored: true,
    authCaptureEscrow: ESCROW,
    captureAuthorizer: keys.operator.publicKey(),
    paymentFlow: "escrow",
    captureMode: "sync",
    captureDeadline: now() + 3600,
    refundDeadline: now() + 7200,
    minFeeBps: 0,
    maxFeeBps: 0,
    ...overrides,
  };
}

/**
 * Valid requirements with optional extra overrides.
 *
 * @param extraOverrides - Extra fields to replace
 * @param overrides - Requirement fields to replace
 * @returns Requirements
 */
export function requirements(
  extraOverrides: Record<string, unknown> = {},
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return {
    scheme: "auth-capture",
    network: NETWORK,
    amount: MAX_AMOUNT,
    asset: TOKEN,
    payTo: keys.receiver.publicKey(),
    maxTimeoutSeconds: 60,
    extra: extra(extraOverrides),
    ...overrides,
  };
}

/**
 * Payment info matching {@link requirements}.
 *
 * @param req - Requirements
 * @param overrides - Fields to replace
 * @returns Payment info
 */
export function paymentInfo(
  req: PaymentRequirements = requirements(),
  overrides: Partial<PaymentInfoJson> = {},
): PaymentInfoJson {
  const e = req.extra as Record<string, unknown>;
  return {
    operator: e.captureAuthorizer as string,
    payer: keys.payer.publicKey(),
    receiver: req.payTo,
    receiverAuthorizer: (e.receiverAuthorizer as string | undefined) ?? null,
    token: req.asset,
    maxAmount: req.amount,
    preApprovalExpiry: now() + 30,
    authorizationExpiry: e.captureDeadline as number,
    refundExpiry: e.refundDeadline as number,
    minFeeBps: e.minFeeBps as number,
    maxFeeBps: e.maxFeeBps as number,
    feeReceiver: (e.feeRecipient as string | undefined) ?? null,
    salt: SALT,
    ...overrides,
  };
}

/**
 * Unsigned entry with V1 address credentials.
 *
 * @param address - Credential address
 * @param invocation - Root invocation
 * @param nonce - Nonce
 * @returns Entry
 */
export function unsignedEntry(
  address: string,
  invocation: xdr.SorobanAuthorizedInvocation,
  nonce = 1n,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation,
  });
}

/**
 * Entry signed by a keypair.
 *
 * @param keypair - Signer
 * @param invocation - Root invocation
 * @param expirationLedger - Expiration ledger
 * @returns Signed entry
 */
export function signedEntry(
  keypair: Keypair,
  invocation: xdr.SorobanAuthorizedInvocation,
  expirationLedger = CURRENT_LEDGER + 10,
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(
    unsignedEntry(keypair.publicKey(), invocation),
    keypair,
    expirationLedger,
    PASSPHRASE,
  );
}

/**
 * Contract event from a contract.
 *
 * @param contract - Emitting contract
 * @param topics - Topics
 * @param data - Data
 * @returns Diagnostic event
 */
export function contractEvent(
  contract: string,
  topics: xdr.ScVal[],
  data: xdr.ScVal,
): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: new Address(contract).toScAddress().contractId(),
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
    }),
  });
}

/**
 * SEP-41 transfer event.
 *
 * @param from - Sender
 * @param to - Recipient
 * @param amount - Amount
 * @param token - Token contract
 * @returns Diagnostic event
 */
export function transferEvent(
  from: string,
  to: string,
  amount: string | bigint,
  token = TOKEN,
): xdr.DiagnosticEvent {
  return contractEvent(
    token,
    [xdr.ScVal.scvSymbol("transfer"), addressScVal(from), addressScVal(to)],
    i128(amount),
  );
}

/**
 * An escrow event (ignored by the balance check).
 *
 * @returns Diagnostic event
 */
export function escrowEvent(): xdr.DiagnosticEvent {
  return contractEvent(ESCROW, [xdr.ScVal.scvSymbol("payment_authorized")], xdr.ScVal.scvVoid());
}

/**
 * `PaymentState` return value.
 *
 * @param state - State fields
 * @param state.collected - Collected flag
 * @param state.capturable - Capturable balance
 * @param state.refundable - Refundable balance
 * @returns ScVal map
 */
export function stateScVal(state: {
  collected: boolean;
  capturable: bigint;
  refundable: bigint;
}): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("capturable"), val: i128(state.capturable) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("collected"),
      val: xdr.ScVal.scvBool(state.collected),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("refundable"), val: i128(state.refundable) }),
  ]);
}

/**
 * Successful simulation response.
 *
 * @param params - Response fields
 * @param params.events - Events
 * @param params.auth - Recorded auth entries
 * @param params.retval - Return value
 * @param params.minResourceFee - Resource fee
 * @returns Simulation response
 */
export function simSuccess(
  params: {
    events?: xdr.DiagnosticEvent[];
    auth?: xdr.SorobanAuthorizationEntry[];
    retval?: xdr.ScVal;
    minResourceFee?: string;
  } = {},
) {
  const fee = params.minResourceFee ?? "1000";
  return {
    id: "1",
    latestLedger: CURRENT_LEDGER,
    events: params.events ?? [],
    _parsed: true,
    transactionData: new SorobanDataBuilder().setResourceFee(fee),
    minResourceFee: fee,
    cost: { cpuInsns: "0", memBytes: "0" },
    result: { auth: params.auth ?? [], retval: params.retval ?? xdr.ScVal.scvVoid() },
  };
}

/**
 * Function name of the single contract call in a transaction.
 *
 * @param tx - Transaction
 * @returns Function name
 */
export function calledFunction(tx: Transaction): string {
  const op = tx.operations[0] as unknown as { func: xdr.HostFunction };
  return op.func.invokeContract().functionName().toString();
}

export type SimHandler = (
  fn: string,
  tx: Transaction,
  mode?: string,
) =>
  | ReturnType<typeof simSuccess>
  | { error: string; events: []; latestLedger: number; _parsed: true };

/**
 * A mock RPC server.
 *
 * @param handler - Simulation router
 * @returns Server mock
 */
export function mockServer(handler: SimHandler) {
  return {
    simulateTransaction: vi.fn(async (tx: Transaction, _resources?: unknown, mode?: string) =>
      handler(calledFunction(tx), tx, mode),
    ),
    getLatestLedger: vi.fn(async () => ({
      sequence: CURRENT_LEDGER,
      id: "x",
      protocolVersion: 23,
    })),
    getAccount: vi.fn(async (address: string) => new Account(address, "100")),
    sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "deadbeef", latestLedger: 1 })),
    getTransaction: vi.fn(async () => ({ status: "SUCCESS" })),
  };
}

/**
 * Wraps requirements and a payload in a `PaymentPayload`.
 *
 * @param req - Requirements
 * @param payload - Scheme payload
 * @returns Payment payload
 */
export function paymentPayload(req: PaymentRequirements, payload: object): PaymentPayload {
  return { x402Version: 2, accepted: req, payload: payload as Record<string, unknown> };
}

/**
 * Decodes the escrow call a transaction invokes.
 *
 * @param tx - Transaction
 * @returns Escrow call
 */
export function decodeEscrowCall(tx: Transaction): EscrowCall {
  const op = tx.operations[0] as unknown as { func: xdr.HostFunction };
  const invoke = op.func.invokeContract();
  const fn = invoke.functionName().toString() as EscrowCall["fn"];
  const args = invoke.args();
  const info = paymentInfoFromScVal(args[0]);
  const str = (value: xdr.ScVal) => String(scValToNative(value));
  const optional = (value: xdr.ScVal) =>
    value.switch().name === "scvVoid" ? null : (scValToNative(value) as string);
  switch (fn) {
    case "authorize":
    case "void":
      return { fn, paymentInfo: info };
    case "charge":
      return {
        fn,
        paymentInfo: info,
        amount: str(args[1]),
        feeAmount: str(args[2]),
        feeReceiver: optional(args[3]),
      };
    case "capture":
      return {
        fn,
        paymentInfo: info,
        amount: str(args[1]),
        feeAmount: str(args[2]),
        feeReceiver: optional(args[3]),
        voidRemainder: args[4].b(),
      };
    case "refund":
      return { fn, paymentInfo: info, amount: str(args[1]), funder: str(args[2]) };
  }
}

/**
 * Entries a recording-mode simulation returns for an escrow call: the operator's, the
 * payer's (collect calls), the consent address's (server operations) and a separate funder's.
 *
 * @param call - Escrow call
 * @returns Unsigned recorded entries
 */
export function recordedEntries(call: EscrowCall): xdr.SorobanAuthorizationEntry[] {
  const info = call.paymentInfo;
  const entries = [unsignedEntry(info.operator, operatorEntry(ESCROW, call).rootInvocation(), 7n)];
  if (call.fn === "authorize" || call.fn === "charge") {
    entries.push(unsignedEntry(info.payer, payerInvocation(ESCROW, call.fn, info), 8n));
  }
  if (call.fn !== "authorize") {
    entries.push(unsignedEntry(consentAddress(info), consentInvocation(ESCROW, call), 9n));
  }
  if (call.fn === "refund" && call.funder !== consentAddress(info)) {
    entries.push(unsignedEntry(call.funder, funderInvocation(ESCROW, call), 10n));
  }
  return entries;
}
