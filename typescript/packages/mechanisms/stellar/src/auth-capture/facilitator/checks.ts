import {
  buildAuthorizationEntryPreimage,
  hash,
  inspectAuthEntry,
  Keypair,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import { feeBounds } from "../extra";
import type { PaymentInfoJson } from "../types";
import type { VerifyResponse } from "@x402/core/types";

/**
 * Builds an invalid verify response.
 *
 * @param reason - Error reason
 * @param payer - Payer, when known
 * @param message - Human-readable detail
 * @returns Invalid response
 */
export function invalid(reason: string, payer?: string, message?: string): VerifyResponse {
  return {
    isValid: false,
    invalidReason: reason,
    ...(payer && { payer }),
    ...(message && { invalidMessage: message }),
  };
}

/**
 * Verifies the Ed25519 signatures of an entry with account (`G...`) credentials locally.
 * Every signature in the standard `{public_key, signature}` vector must verify over the
 * entry's signature payload, and at least one must be present. Thresholds of multisig
 * accounts, and contract (`C...`) accounts, are left to the network, which simulation and
 * submission enforce.
 *
 * @param entry - Authorization entry with address credentials
 * @param networkPassphrase - Network passphrase
 * @returns True when all present signatures verify
 */
export function verifyEntrySignatures(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): boolean {
  const info = inspectAuthEntry(entry);
  if (info.address === null || info.signatureExpirationLedger === null) return false;
  if (!StrKey.isValidEd25519PublicKey(info.address)) return true;

  const signatures = info.signers[0]?.signatures;
  if (!signatures || signatures.length === 0) return false;
  const preimage = buildAuthorizationEntryPreimage(
    entry,
    info.signatureExpirationLedger,
    networkPassphrase,
  );
  const payload = hash(preimage.toXDR());
  return signatures.every(({ publicKey, signature }) => {
    try {
      return Keypair.fromPublicKey(publicKey).verify(payload, signature);
    } catch {
      return false;
    }
  });
}

/**
 * Validates a server-chosen fee for `charge` or `capture`.
 *
 * @param info - Payment info
 * @param amount - Charged or captured amount
 * @param feeAmount - Fee amount
 * @param feeReceiver - Fee receiver argument
 * @returns Problem description, or undefined when valid
 */
export function feeProblem(
  info: PaymentInfoJson,
  amount: bigint,
  feeAmount: bigint,
  feeReceiver: string | null,
): string | undefined {
  const bounds = feeBounds(amount, info.minFeeBps, info.maxFeeBps);
  if (feeAmount < bounds.min || feeAmount > bounds.max) {
    return `feeAmount ${feeAmount} outside [${bounds.min}, ${bounds.max}]`;
  }
  if (feeReceiver !== info.feeReceiver) {
    return "feeReceiver must equal paymentInfo.feeReceiver";
  }
  if (feeAmount > 0n && feeReceiver === null) {
    return "a non-zero fee requires a fee receiver";
  }
  return undefined;
}

/**
 * Finds the first payment-info role held by a facilitator address.
 *
 * @param facilitator - Facilitator addresses
 * @param roles - Role name to address (null entries are skipped)
 * @returns The offending role, or undefined
 */
export function facilitatorRole(
  facilitator: ReadonlySet<string>,
  roles: Record<string, string | null | undefined>,
): string | undefined {
  return Object.entries(roles).find(([, address]) => address && facilitator.has(address))?.[0];
}
