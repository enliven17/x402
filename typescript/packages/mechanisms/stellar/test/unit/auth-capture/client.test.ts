import { xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_LEDGER,
  decodeEscrowCall,
  ESCROW,
  keys,
  mockServer,
  now,
  requirements,
  recordedEntries,
  simSuccess,
  type SimHandler,
} from "./fixtures";
import { AuthCaptureStellarScheme } from "../../../src/auth-capture/client";
import { verifyEntrySignatures } from "../../../src/auth-capture/facilitator/checks";
import { payerInvocation } from "../../../src/auth-capture/invocation";
import { paymentInfoFromScVal } from "../../../src/auth-capture/paymentInfo";
import { createEd25519Signer } from "../../../src/signer";
import * as stellarUtils from "../../../src/utils";
import type { AuthCaptureCollectPayload } from "../../../src/auth-capture/types";

vi.mock("../../../src/utils", async () => {
  const actual = await vi.importActual<typeof stellarUtils>("../../../src/utils");
  return {
    ...actual,
    getRpcClient: vi.fn(),
    getEstimatedLedgerCloseTimeSeconds: vi.fn(async () => 5),
  };
});

let handler: SimHandler;
let server: ReturnType<typeof mockServer>;

beforeEach(() => {
  handler = (_, tx) => simSuccess({ auth: recordedEntries(decodeEscrowCall(tx)) });
  server = mockServer((fn, tx, mode) => handler(fn, tx, mode));
  vi.mocked(stellarUtils.getRpcClient).mockReturnValue(server as never);
});

const client = () => new AuthCaptureStellarScheme(createEd25519Signer(keys.payer.secret()));

describe("AuthCaptureStellarScheme (client)", () => {
  it("signs only the payer entry for authorize", async () => {
    const req = requirements();
    const result = await client().createPaymentPayload(2, req);
    const payload = result.payload as unknown as AuthCaptureCollectPayload;

    expect(result.x402Version).toBe(2);
    expect(payload.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.preApprovalExpiry).toBeGreaterThan(now());
    expect(payload.preApprovalExpiry).toBeLessThanOrEqual(now() + 60);

    const [tx, , mode] = server.simulateTransaction.mock.calls[0];
    expect(mode).toBe("record");
    const call = decodeEscrowCall(tx);
    expect(call.fn).toBe("authorize");
    expect(call.paymentInfo.salt).toBe(payload.salt);

    const entry = xdr.SorobanAuthorizationEntry.fromXDR(payload.authorizationEntry, "base64");
    const credentials = entry.credentials().address();
    expect(credentials.signatureExpirationLedger()).toBe(CURRENT_LEDGER + 12);
    expect(verifyEntrySignatures(entry, "Test SDF Network ; September 2015")).toBe(true);
    expect(
      entry
        .rootInvocation()
        .toXDR()
        .equals(payerInvocation(ESCROW, "authorize", call.paymentInfo).toXDR()),
    ).toBe(true);
  });

  it("roots the entry at charge for the authorization flow", async () => {
    const req = requirements({
      paymentFlow: "authorization",
      captureMode: undefined,
      minFeeBps: 100,
      maxFeeBps: 200,
      feeRecipient: keys.feeRecipient.publicKey(),
    });
    const result = await client().createPaymentPayload(2, req);
    const payload = result.payload as unknown as AuthCaptureCollectPayload;
    const call = decodeEscrowCall(server.simulateTransaction.mock.calls[0][0]);
    expect(call).toMatchObject({ fn: "charge", amount: req.amount, feeAmount: "100000" });
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(payload.authorizationEntry, "base64");
    expect(entry.rootInvocation().function().contractFn().functionName().toString()).toBe("charge");
  });

  it("clamps preApprovalExpiry to the capture deadline", async () => {
    const deadline = now() + 10;
    const result = await client().createPaymentPayload(
      2,
      requirements({ captureDeadline: deadline }),
    );
    expect((result.payload as unknown as AuthCaptureCollectPayload).preApprovalExpiry).toBe(
      deadline,
    );
  });

  it.each([
    [{ scheme: "exact" }, "Unsupported scheme"],
    [{ network: "eip155:1" }, "Unsupported Stellar network"],
    [{ amount: "0" }, "Invalid amount"],
    [{ payTo: "nope" }, "Invalid payTo"],
    [{ asset: keys.payer.publicKey() }, "Invalid asset"],
  ])("rejects requirements %o", async (overrides, message) => {
    await expect(
      client().createPaymentPayload(2, { ...requirements(), ...overrides } as never),
    ).rejects.toThrow(message);
  });

  it("rejects invalid extra and a non-canonical escrow", async () => {
    await expect(client().createPaymentPayload(2, requirements({ maxFeeBps: 9 }))).rejects.toThrow(
      "Invalid auth-capture extra",
    );
    await expect(
      client().createPaymentPayload(
        2,
        requirements({
          authCaptureEscrow: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
        }),
      ),
    ).rejects.toThrow("not canonical");
  });

  it("refuses to sign an entry that does not match the expected tree", async () => {
    handler = (_, tx) => {
      const call = decodeEscrowCall(tx);
      const tampered = { ...call, paymentInfo: { ...call.paymentInfo, maxAmount: "99999999" } };
      return simSuccess({ auth: recordedEntries(tampered) });
    };
    await expect(client().createPaymentPayload(2, requirements())).rejects.toThrow(
      "unexpected payer entry",
    );
  });

  it("surfaces simulation failures", async () => {
    handler = () => ({ error: "HostError: boom", events: [], latestLedger: 1, _parsed: true });
    await expect(client().createPaymentPayload(2, requirements())).rejects.toThrow("boom");
  });

  it("decodes the simulated payment info", async () => {
    await client().createPaymentPayload(2, requirements());
    const tx = server.simulateTransaction.mock.calls[0][0];
    const op = tx.operations[0] as unknown as { func: xdr.HostFunction };
    const info = paymentInfoFromScVal(op.func.invokeContract().args()[0]);
    expect(info.payer).toBe(keys.payer.publicKey());
    expect(info.operator).toBe(keys.operator.publicKey());
  });
});
