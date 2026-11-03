# Auth-Capture Stellar Scheme (`@x402/stellar/auth-capture`)

Stellar binding of the `auth-capture` scheme on the `AuthCaptureEscrow` Soroban contract. The client signs one Soroban authorization entry for `authorize` (escrow flow) or `charge` (authorization flow). The facilitator is the escrow operator: it submits every call from its own account, authorizes as transaction source only, and never signs an authorization entry. Server consent for `charge`, `capture`, `void` and `refund` is a Soroban authorization entry signed by the consent address and checked by the escrow.

See the [Stellar binding specification](../../../../../../specs/schemes/auth-capture/scheme_auth_capture_stellar.md).

## Import paths

| Role        | Import                                   |
| ----------- | ---------------------------------------- |
| Client      | `@x402/stellar/auth-capture/client`      |
| Server      | `@x402/stellar/auth-capture/server`      |
| Facilitator | `@x402/stellar/auth-capture/facilitator` |

Shared types, error codes, `PaymentInfo` encoding and the payment hash are exported from `@x402/stellar` as `authCapture`.

## Deployments

| Network           | `AuthCaptureEscrow`                                        |
| ----------------- | ---------------------------------------------------------- |
| `stellar:testnet` | `CAZUU5HON2LQBRLWNTQX2NFWB7AYMCZRZT6C6N7KUPP6AOAXNFCF6FK2` |
| `stellar:pubnet`  | none yet                                                   |

Every role accepts `escrowAddresses` to override the deployment per network (local networks, new deployments).

## Client

```typescript
import { x402Client } from "@x402/core/client";
import { createEd25519Signer } from "@x402/stellar";
import { AuthCaptureStellarScheme } from "@x402/stellar/auth-capture/client";

const client = new x402Client().register(
  "stellar:testnet",
  new AuthCaptureStellarScheme(createEd25519Signer(process.env.STELLAR_PRIVATE_KEY!)),
);
```

The client builds `PaymentInfo` (random salt, `preApprovalExpiry = now + maxTimeoutSeconds`, capped at `captureDeadline`), simulates the escrow call in recording mode, checks that the recorded payer entry is exactly `fn(payment_info)` with one `transfer(payer, escrow, max_amount)` sub-invocation, and signs it with expiration `currentLedger + ceil(maxTimeoutSeconds / ledgerSeconds)`.

## Server

```typescript
import { createEd25519Signer } from "@x402/stellar";
import { AuthCaptureStellarScheme } from "@x402/stellar/auth-capture/server";

const scheme = new AuthCaptureStellarScheme({
  consentSigner: createEd25519Signer(process.env.RECEIVER_PRIVATE_KEY!),
});
resourceServer.register("stellar:testnet", scheme);

// Route accepts entry
{
  scheme: "auth-capture",
  network: "stellar:testnet",
  price: "$0.01",
  payTo: receiverAddress,
  extra: {
    paymentFlow: "escrow", // or "authorization"
    captureMode: "sync", // or "deferred"; escrow only
    captureDeadlineSeconds: 3600, // or absolute captureDeadline / refundDeadline
    refundDeadlineSeconds: 86400,
  },
}
```

`enhancePaymentRequirements` merges the facilitator's `/supported` extra (`areFeesSponsored`, `authCaptureEscrow`, `captureAuthorizer`, fee terms), resolves deadlines, and publishes the consent signer as `receiverAuthorizer` when it is not `payTo`. Escrow `"sync"` and `"authorization"` routes need a consent signer for the consent address unless that address is the operator.

| `paymentFlow` | `captureMode` | Before the handler | After the handler |
| --- | --- | --- | --- |
| `escrow` | `sync` | settle `authorize` | settle `capture` of `requirements.amount`; `voidRemainder` when it is below the maximum |
| `escrow` | `deferred` | settle `authorize` | skipped; capture or void later through the lifecycle manager |
| `authorization` | n/a | verify | settle `charge` of `requirements.amount` |

A settlement override (response header) sets the captured or charged amount. A failed handler after `authorize` settles a `void`. Collected payments are recorded in `storage` (in memory by default).

### Lifecycle manager and payload builders

```typescript
const lifecycle = scheme.createLifecycleManager(facilitatorClient);
await lifecycle.capture(paymentHash, { amount: "5000000", voidRemainder: true });
await lifecycle.voidPayment(paymentHash);
await lifecycle.refund(paymentHash, { amount: "1000000" }); // funder: funderSigner, else the consent address
```

`buildCapturePayload`, `buildVoidPayload`, `buildRefundPayload` and `buildChargeCompletion` build the same payloads without storage. Each simulates the escrow call in recording mode, checks the recorded tree, and signs the consent entry (and, for a separate refund funder, the funder entry rooted at the same `refund` call).

## Facilitator

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import { AuthCaptureStellarScheme } from "@x402/stellar/auth-capture/facilitator";

const facilitator = new x402Facilitator().register(
  "stellar:testnet",
  new AuthCaptureStellarScheme([createEd25519Signer(process.env.OPERATOR_PRIVATE_KEY!)], {
    feeTerms: { minFeeBps: 0, maxFeeBps: 0 },
  }),
);
```

| Option | Default | Notes |
| --- | --- | --- |
| `rpcConfig` | testnet RPC | Required for pubnet. |
| `maxTransactionFeeStroops` | `1_000_000` | Ceiling on `minResourceFee + inclusionFeeStroops`; above it verify fails with `invalid_auth_capture_stellar_fee_exceeds_maximum`. Escrow calls write persistent state with a TTL up to the refund deadline. |
| `inclusionFeeStroops` | `100` | Inclusion bid added to the simulated resource fee. |
| `feeTerms` | zero fees | Advertised on `/supported`. |
| `allowOperatorConsent` | `false` | Accept `receiverAuthorizer == captureAuthorizer` (a server running its own facilitator); `consentEntry` is then omitted. |
| `selectCaptureAuthorizer` | round-robin | Chooses the advertised operator among the signers. |

Verification checks the envelope and `extra`, the canonical escrow, that `captureAuthorizer` is a facilitator signer, the exact shape of every entry (address credentials only, root call and arguments, sub-invocations), entry expiration, Ed25519 signatures of account entries, `preApprovalExpiry`, payment state, fee bounds, and facilitator safety (no facilitator address as payer, receiver, receiver authorizer, fee receiver, funder or entry signer). It then simulates the call from the operator account in enforcing mode with the operator's source-account entry attached, checks the fee ceiling, and compares the net token balance changes of the simulation with the spec table. Settle re-runs verification, builds the transaction with the simulated resources, signs it as source, submits, and polls. `amount` in the settle response is what the call collected, charged, captured, voided or refunded.

An `authorization`-flow client payload verifies before the resource runs without completion fields: it is checked structurally, its signature locally, and the payer balance against the maximum. Settlement requires the completion (`amount`, `feeAmount`, `feeReceiver`, `consentEntry`).
