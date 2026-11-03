/**
 * Stellar blockchain support for x402 protocol.
 *
 * This package provides Stellar network support for the x402 payment protocol,
 * including client signing, server validation, and facilitator settlement.
 *
 * @module
 */

// Exact scheme client
export { ExactStellarScheme } from "./exact";

// Auth-capture scheme: shared types, constants and encoding helpers.
// Role implementations are imported from `@x402/stellar/auth-capture/{client,server,facilitator}`.
export * as authCapture from "./auth-capture";

// Types
export * from "./types";

// Constants
export * from "./constants";

// Signers
export * from "./signer";

// Errors
export * from "./errors";

// Utilities
export * from "./utils";
export * from "./shared";

export {
  DEFAULT_ASSETS,
  getDefaultAsset,
  findDefaultAsset,
  type StellarDefaultAsset,
} from "./defaultAssets";
