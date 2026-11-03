---
"@x402/stellar": minor
---

Add the `auth-capture` scheme for Stellar on the `AuthCaptureEscrow` Soroban contract, with `@x402/stellar/auth-capture/client`, `/server` and `/facilitator` entry points. The client signs one authorization entry for `authorize` or `charge`; the facilitator submits every escrow call as operator from its own account without signing entries; the server signs consent entries for `charge`, `capture`, `void` and `refund`, completes sync captures and charges after the handler, voids on handler failure, and runs deferred capture, void and refund through `createLifecycleManager`.
