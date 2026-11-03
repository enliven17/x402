/**
 * Error reasons for the Stellar auth-capture binding. Scheme-defined reasons use the
 * `invalid_auth_capture_stellar_` prefix; generic x402 reasons keep their names.
 */

const PREFIX = "invalid_auth_capture_stellar_";

export const ErrPayloadFormat = `${PREFIX}payload_format`;
export const ErrEscrowMismatch = `${PREFIX}escrow_mismatch`;
export const ErrOperatorNotAdmitted = `${PREFIX}operator_not_admitted`;
export const ErrUnsupportedPaymentFlow = `${PREFIX}unsupported_payment_flow`;
export const ErrExtra = `${PREFIX}extra`;
export const ErrAuthorizationEntry = `${PREFIX}authorization_entry`;
export const ErrConsentEntry = `${PREFIX}consent_entry`;
export const ErrSignature = `${PREFIX}signature`;
export const ErrExpired = `${PREFIX}expired`;
export const ErrAlreadyCollected = `${PREFIX}already_collected`;
export const ErrInsufficientBalance = `${PREFIX}insufficient_balance`;
export const ErrFacilitatorSafety = `${PREFIX}facilitator_safety`;
export const ErrSimulationFailed = `${PREFIX}simulation_failed`;
export const ErrFeeExceedsMaximum = `${PREFIX}fee_exceeds_maximum`;

export const ErrInvalidVersion = "invalid_x402_version";
export const ErrUnsupportedScheme = "unsupported_scheme";
export const ErrNetworkMismatch = "network_mismatch";
export const ErrInvalidNetwork = "invalid_network";
export const ErrUnexpectedVerify = "unexpected_verify_error";
export const ErrUnexpectedSettle = "unexpected_settle_error";

// Settle-only reasons
export const ErrTransactionSigningFailed = `${PREFIX}transaction_signing_failed`;
export const ErrSubmissionFailed = `${PREFIX}transaction_submission_failed`;
export const ErrSubmissionRetryable = `${PREFIX}transaction_submission_retryable`;
export const ErrTransactionFailed = `${PREFIX}transaction_failed`;

// Resource-server lifecycle errors (never sent on the wire)
export const ErrServerLifecycleUnavailable = `${PREFIX}server_lifecycle_unavailable`;

/**
 * `AuthCaptureEscrow` contract error codes (`Error(Contract, #n)`) mapped to reasons.
 */
export const ESCROW_ERROR_TO_REASON: Readonly<Record<number, string>> = {
  1: ErrPayloadFormat, // ZeroAmount
  2: ErrPayloadFormat, // ExceedsMaxAmount
  3: ErrExpired, // AfterPreApprovalExpiry
  4: ErrExtra, // InvalidExpiries
  5: ErrExtra, // FeeBpsOverflow
  6: ErrExtra, // InvalidFeeBpsRange
  7: ErrPayloadFormat, // FeeAmountOutOfRange
  8: ErrExtra, // MissingFeeReceiver
  9: ErrPayloadFormat, // InvalidFeeReceiver
  10: ErrAlreadyCollected, // AlreadyCollected
  11: ErrExpired, // AfterAuthorizationExpiry
  12: ErrInsufficientBalance, // InsufficientAuthorization
  13: ErrInsufficientBalance, // ZeroAuthorization
  14: ErrExpired, // BeforeAuthorizationExpiry
  15: ErrExpired, // AfterRefundExpiry
  16: ErrInsufficientBalance, // RefundExceedsCapture
  17: ErrSimulationFailed, // TokenCollectionFailed
};
