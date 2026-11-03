import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";
import { createEd25519Signer, STELLAR_TESTNET_CAIP2 } from "../../src";
import { AuthCaptureStellarScheme as AuthCaptureClient } from "../../src/auth-capture/client";
import { AuthCaptureStellarScheme as AuthCaptureFacilitator } from "../../src/auth-capture/facilitator";
import {
  AuthCaptureStellarScheme as AuthCaptureServer,
  computePaymentHash,
  paymentInfoFromCollect,
  type AuthCaptureLifecycleManager,
} from "../../src/auth-capture/server";
import { AUTH_CAPTURE_ESCROW_ADDRESSES } from "../../src/auth-capture/constants";
import { parseAuthCaptureExtra } from "../../src/auth-capture/extra";
import { readPaymentState, readTokenBalance } from "../../src/auth-capture/soroban";
import type { AuthCaptureCollectPayload, PaymentState } from "../../src/auth-capture/types";
import { friendbot, issueTestToken, RPC_TESTNET } from "./authCaptureSetup";

const ESCROW = AUTH_CAPTURE_ESCROW_ADDRESSES[STELLAR_TESTNET_CAIP2];
const MAX_AMOUNT = 10_000_000n; // 1 unit of a 7-decimal token
const PAYER_FUNDING = 1_000_000_000n;
const TX_EXPLORER = "https://stellar.expert/explorer/testnet/tx";
const LONG = 240_000;

/**
 * Exposes an in-process facilitator through the `FacilitatorClient` interface.
 */
class LocalFacilitatorClient implements FacilitatorClient {
  /**
   * Creates the client.
   *
   * @param facilitator - In-process facilitator
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment.
   *
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @returns Verify response
   */
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(payload, requirements);
  }

  /**
   * Settles a payment.
   *
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @returns Settle response
   */
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(payload, requirements);
  }

  /**
   * Supported kinds.
   *
   * @returns Supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

/**
 * Logs a settle and asserts it succeeded.
 *
 * @param label - Step name
 * @param response - Settle response
 */
function expectSettled(label: string, response: SettleResponse | void): void {
  expect(response, label).toBeDefined();
  const settled = response as SettleResponse;
  if (!settled.success) {
    console.error(label, settled);
  }
  expect(settled.success, `${label}: ${settled.errorReason} ${settled.errorMessage ?? ""}`).toBe(
    true,
  );
  console.log(`${label}: ${TX_EXPLORER}/${settled.transaction}`);
}

describe("auth-capture on Stellar testnet", () => {
  const server = new rpc.Server(RPC_TESTNET);
  const issuer = Keypair.random();
  const payer = Keypair.random();
  const receiver = Keypair.random();
  const operator = Keypair.random();
  let token: string;
  let client: x402Client;
  let resourceServer: x402ResourceServer;
  let lifecycle: AuthCaptureLifecycleManager;
  let facilitatorClient: LocalFacilitatorClient;

  const balance = (address: string) => readTokenBalance(server, Networks.TESTNET, token, address);

  const stateOf = (requirements: PaymentRequirements, payload: PaymentPayload) => {
    const parsed = parseAuthCaptureExtra(requirements.extra);
    if ("error" in parsed) throw new Error(parsed.message);
    const info = paymentInfoFromCollect(
      payload.payload as unknown as AuthCaptureCollectPayload,
      requirements,
      parsed.value,
    );
    const paymentHash = computePaymentHash(info, ESCROW, Networks.TESTNET);
    return {
      paymentHash,
      read: (): Promise<PaymentState> =>
        readPaymentState(server, Networks.TESTNET, ESCROW, paymentHash),
    };
  };

  /**
   * Builds requirements through the resource server and has the client pay them.
   *
   * @param extra - Route extra
   * @returns Matched requirements and the client payload
   */
  async function pay(
    extra: Record<string, unknown>,
  ): Promise<{ requirements: PaymentRequirements; payload: PaymentPayload }> {
    const accepts = await resourceServer.buildPaymentRequirements({
      scheme: "auth-capture",
      network: STELLAR_TESTNET_CAIP2,
      price: { amount: MAX_AMOUNT.toString(), asset: token },
      payTo: receiver.publicKey(),
      maxTimeoutSeconds: 120,
      extra: { captureDeadlineSeconds: 3600, refundDeadlineSeconds: 7200, ...extra },
    });
    const paymentRequired = await resourceServer.createPaymentRequiredResponse(accepts, {
      url: "https://example.com/resource",
      description: "auth-capture test resource",
      mimeType: "application/json",
    });
    const payload = await client.createPaymentPayload(paymentRequired);
    const requirements = resourceServer.findMatchingRequirements(accepts, payload);
    expect(requirements).toBeDefined();
    return { requirements: requirements!, payload };
  }

  beforeAll(async () => {
    await Promise.all([issuer, payer, receiver, operator].map(k => friendbot(k.publicKey())));
    ({ token } = await issueTestToken(issuer, [payer, receiver], PAYER_FUNDING));
    console.log(`test token ${token}, escrow ${ESCROW}`);

    client = new x402Client()
      .setSpendControls(false)
      .register(STELLAR_TESTNET_CAIP2, new AuthCaptureClient(createEd25519Signer(payer.secret())));

    const facilitator = new x402Facilitator().register(
      STELLAR_TESTNET_CAIP2,
      new AuthCaptureFacilitator([createEd25519Signer(operator.secret())]),
    );
    facilitatorClient = new LocalFacilitatorClient(facilitator);
    const scheme = new AuthCaptureServer({ consentSigner: createEd25519Signer(receiver.secret()) });
    resourceServer = new x402ResourceServer(facilitatorClient).register(
      STELLAR_TESTNET_CAIP2,
      scheme,
    );
    await resourceServer.initialize();
    lifecycle = scheme.createLifecycleManager(facilitatorClient);
  }, LONG);

  it(
    "escrow sync: authorize, partial capture with voidRemainder, refund from the receiver",
    async () => {
      const { requirements, payload } = await pay({ paymentFlow: "escrow", captureMode: "sync" });
      const payment = stateOf(requirements, payload);
      const [payerBefore, receiverBefore] = await Promise.all([
        balance(payer.publicKey()),
        balance(receiver.publicKey()),
      ]);

      const authorized = await resourceServer.settlePayment(
        payload,
        requirements,
        undefined,
        undefined,
        undefined,
        "before-handler",
      );
      expectSettled("authorize", authorized);
      expect(authorized.amount).toBe(MAX_AMOUNT.toString());
      expect(await payment.read()).toEqual({
        collected: true,
        capturable: MAX_AMOUNT,
        refundable: 0n,
      });
      expect(await balance(payer.publicKey())).toBe(payerBefore - MAX_AMOUNT);
      expect(await balance(ESCROW)).toBeGreaterThanOrEqual(MAX_AMOUNT);

      const replay = await facilitatorClient.settle(payload, requirements);
      expect(replay.success).toBe(false);
      expect(replay.errorReason).toBe("invalid_auth_capture_stellar_already_collected");

      const captured = await resourceServer.settlePayment(
        payload,
        requirements,
        undefined,
        undefined,
        { amount: "6000000" },
        "after-handler",
      );
      expectSettled("capture (voidRemainder)", captured);
      expect(captured.amount).toBe("6000000");
      expect(await payment.read()).toEqual({
        collected: true,
        capturable: 0n,
        refundable: 6_000_000n,
      });
      expect(await balance(payer.publicKey())).toBe(payerBefore - 6_000_000n);
      expect(await balance(receiver.publicKey())).toBe(receiverBefore + 6_000_000n);

      const refunded = await lifecycle.refund(payment.paymentHash, { amount: "2000000" });
      expectSettled("refund (funder = receiver)", refunded);
      expect(await payment.read()).toEqual({
        collected: true,
        capturable: 0n,
        refundable: 4_000_000n,
      });
      expect(await balance(payer.publicKey())).toBe(payerBefore - 4_000_000n);
      expect(await balance(receiver.publicKey())).toBe(receiverBefore + 4_000_000n);
      expect((await lifecycle.getAuthorizedPayment(payment.paymentHash))?.refundableAmount).toBe(
        "4000000",
      );
    },
    LONG,
  );

  it(
    "escrow: authorize, then void when the handler fails",
    async () => {
      const { requirements, payload } = await pay({ paymentFlow: "escrow", captureMode: "sync" });
      const payment = stateOf(requirements, payload);
      const payerBefore = await balance(payer.publicKey());

      const authorized = await resourceServer.settlePayment(
        payload,
        requirements,
        undefined,
        undefined,
        undefined,
        "before-handler",
      );
      expectSettled("authorize", authorized);
      expect(await balance(payer.publicKey())).toBe(payerBefore - MAX_AMOUNT);

      const voided = await resourceServer
        .createPaymentCancellationDispatcher(payload, requirements, undefined, undefined, [
          "before-handler",
        ])
        .cancel({ reason: "handler_failed" });
      expectSettled("void", voided);
      expect((voided as SettleResponse).amount).toBe(MAX_AMOUNT.toString());
      expect(await payment.read()).toEqual({ collected: true, capturable: 0n, refundable: 0n });
      expect(await balance(payer.publicKey())).toBe(payerBefore);
    },
    LONG,
  );

  it(
    "escrow deferred: authorize, skipped after-handler settle, capture and void later",
    async () => {
      const { requirements, payload } = await pay({
        paymentFlow: "escrow",
        captureMode: "deferred",
      });
      const payment = stateOf(requirements, payload);
      const [payerBefore, receiverBefore] = await Promise.all([
        balance(payer.publicKey()),
        balance(receiver.publicKey()),
      ]);

      const authorized = await resourceServer.settlePayment(
        payload,
        requirements,
        undefined,
        undefined,
        undefined,
        "before-handler",
      );
      expectSettled("authorize", authorized);
      const skipped = await resourceServer.settlePayment(payload, requirements);
      expect(skipped.transaction).toBe(authorized.transaction);

      expectSettled(
        "deferred capture",
        await lifecycle.capture(payment.paymentHash, { amount: "3000000" }),
      );
      expect(await payment.read()).toEqual({
        collected: true,
        capturable: 7_000_000n,
        refundable: 3_000_000n,
      });
      expectSettled("deferred void", await lifecycle.voidPayment(payment.paymentHash));
      expect(await payment.read()).toEqual({
        collected: true,
        capturable: 0n,
        refundable: 3_000_000n,
      });
      expect(await balance(payer.publicKey())).toBe(payerBefore - 3_000_000n);
      expect(await balance(receiver.publicKey())).toBe(receiverBefore + 3_000_000n);
    },
    LONG,
  );

  it(
    "authorization flow: verify, then charge the final amount after the handler",
    async () => {
      const { requirements, payload } = await pay({ paymentFlow: "authorization" });
      const payment = stateOf(requirements, payload);
      const [payerBefore, receiverBefore] = await Promise.all([
        balance(payer.publicKey()),
        balance(receiver.publicKey()),
      ]);

      const verified = await resourceServer.verifyPayment(payload, requirements);
      expect(verified.isValid, verified.invalidReason).toBe(true);
      expect(verified.payer).toBe(payer.publicKey());

      const charged = await resourceServer.settlePayment(
        payload,
        requirements,
        undefined,
        undefined,
        { amount: "7500000" },
      );
      expectSettled("charge", charged);
      expect(charged.amount).toBe("7500000");
      expect(await payment.read()).toEqual({
        collected: true,
        capturable: 0n,
        refundable: 7_500_000n,
      });
      expect(await balance(payer.publicKey())).toBe(payerBefore - 7_500_000n);
      expect(await balance(receiver.publicKey())).toBe(receiverBefore + 7_500_000n);

      // The server's consent simulation already sees the payment as collected.
      await expect(
        resourceServer.settlePayment(payload, requirements, undefined, undefined, {
          amount: "7500000",
        }),
      ).rejects.toThrow("Error(Contract, #10)");
    },
    LONG,
  );
});
