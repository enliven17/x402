import { STELLAR_TESTNET_CAIP2 } from "../constants";
import type { Network } from "@x402/core/types";

export const AUTH_CAPTURE_SCHEME = "auth-capture";

/** Upper bound for every basis-point field. */
export const MAX_FEE_BPS = 10_000;

/** Default `maxTimeoutSeconds` when requirements omit it. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/** Ledgers of RPC skew tolerated on the client entry's `signatureExpirationLedger` bound. */
export const SIGNATURE_EXPIRATION_LEDGER_TOLERANCE = 2;

/**
 * Canonical `AuthCaptureEscrow` deployments. A network without an entry has no
 * canonical deployment yet; callers must pass an explicit override.
 */
export const AUTH_CAPTURE_ESCROW_ADDRESSES: Readonly<Record<string, string>> = {
  [STELLAR_TESTNET_CAIP2]: "CCB3W5542IQIVWT3ZDTSQIN2LPRMVYLZ2KKQOJT2CTIIDDTYIQVHHCCI",
};

/**
 * Resolves the canonical escrow address for a network.
 *
 * @param network - CAIP-2 network identifier
 * @param overrides - Optional per-network overrides (local networks, new deployments)
 * @returns The escrow contract address, or undefined when the network has none
 */
export function canonicalEscrowAddress(
  network: Network,
  overrides?: Readonly<Record<string, string>>,
): string | undefined {
  return overrides?.[network] ?? AUTH_CAPTURE_ESCROW_ADDRESSES[network];
}
