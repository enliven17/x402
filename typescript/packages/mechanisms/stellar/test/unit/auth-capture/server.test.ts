import { xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeEscrowCall,
  ESCROW,
  keys,
  MAX_AMOUNT,
  mockServer,
  now,
  PASSPHRASE,
  paymentInfo,
  requirements,
  recordedEntries,
  SALT,
  signedEntry,
  simSuccess,
  TOKEN,
} from "./fixtures";
import { payerInvocation } from "../../../src/auth-capture/invocation";
import {
  AuthCaptureStellarScheme,
  buildRefundPayload,
  computePaymentHash,
  InMemoryAuthorizedPaymentStorage,
  requirementsFromRecord,
  type AuthorizedPayment,
} from "../../../src/auth-capture/server";
import { createEd25519Signer } from "../../../src/signer";
import * as stellarUtils from "../../../src/utils";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";

vi.mock("../../../src/utils", async () => {
  const actual = await vi.importActual<typeof stellarUtils>("../../../src/utils");
  return {
    ...actual,
    getRpcClient: vi.fn(),
    getEstimatedLedgerCloseTimeSeconds: vi.fn(async () => 5),
  };
});

const receiver = keys.receiver.publicKey();
const operator = keys.operator.publicKey();
const consentSigner = createEd25519Signer(keys.receiver.secret());
const supportedKind = {
  x402Version: 2,
  scheme: "auth-capture",
  network: "stellar:testnet" as const,
  extra: {
    areFeesSponsored: true,
    authCaptureEscrow: ESCROW,
    captureAuthorizer: operator,
    minFeeBps: 0,
    maxFeeBps: 0,
  },
};

let server: ReturnType<typeof mockServer>;

beforeEach(() => {
  server = mockServer((_, tx) => simSuccess({ auth: recordedEntries(decodeEscrowCall(tx)) }));
  vi.mocked(stellarUtils.getRpcClient).mockReturnValue(server as never);
});

/**
 * Base requirements before enhancement.
 *
 * @param extra - Route extra
 * @returns Requirements
 */
function base(extra: Record<string, unknown>): PaymentRequirements {
  return {
    scheme: "auth-capture",
    network: "stellar:testnet",
    amount: MAX_AMOUNT,
    asset: TOKEN,
    payTo: receiver,
    maxTimeoutSeconds: 60,
    extra,
  };
}

const relative = { captureDeadlineSeconds: 3600, refundDeadlineSeconds: 7200 };

describe("enhancePaymentRequirements", () => {
  const scheme = new AuthCaptureStellarScheme({ consentSigner });

  it("merges /supported, resolves relative deadlines and defaults", async () => {
    const result = await scheme.enhancePaymentRequirements(base(relative), supportedKind, []);
    const extra = result.extra as Record<string, number | string>;
    expect(extra).toMatchObject({
      areFeesSponsored: true,
      authCaptureEscrow: ESCROW,
      captureAuthorizer: operator,
      paymentFlow: "escrow",
      captureMode: "sync",
      minFeeBps: 0,
      maxFeeBps: 0,
    });
    expect(extra).not.toHaveProperty("captureDeadlineSeconds");
    expect(extra).not.toHaveProperty("receiverAuthorizer");
    expect(extra.captureDeadline as number).toBeGreaterThan(now() + 3500);
    expect((extra.captureDeadline as number) % 60).toBe(0);
    expect((extra.refundDeadline as number) - (extra.captureDeadline as number)).toBe(3600);
  });

  it("keeps absolute deadlines", async () => {
    const deadlines = { captureDeadline: now() + 100, refundDeadline: now() + 200 };
    const result = await scheme.enhancePaymentRequirements(base(deadlines), supportedKind, []);
    expect(result.extra).toMatchObject(deadlines);
  });

  it.each([
    [{}, "either"],
    [{ captureDeadlineSeconds: 10, refundDeadline: now() + 20 }, "either"],
    [{ captureDeadlineSeconds: 10, refundDeadlineSeconds: -1 }, "positive"],
    [{ ...relative, paymentFlow: "authorization", captureMode: "sync" }, "invalid"],
    [{ ...relative, authCaptureEscrow: TOKEN }, "not canonical"],
    [{ ...relative, receiverAuthorizer: keys.authorizer.publicKey() }, "does not match"],
  ])("rejects %o", async (extra, message) => {
    await expect(scheme.enhancePaymentRequirements(base(extra), supportedKind, [])).rejects.toThrow(
      message,
    );
  });

  it("publishes the consent signer as receiverAuthorizer when it is not payTo", async () => {
    const authorizer = new AuthCaptureStellarScheme({
      consentSigner: createEd25519Signer(keys.authorizer.secret()),
    });
    const result = await authorizer.enhancePaymentRequirements(base(relative), supportedKind, []);
    expect(result.extra.receiverAuthorizer).toBe(keys.authorizer.publicKey());
  });

  it("requires a consent signer for sync and authorization routes only", async () => {
    const unsigned = new AuthCaptureStellarScheme();
    await expect(
      unsigned.enhancePaymentRequirements(base(relative), supportedKind, []),
    ).rejects.toThrow("consentSigner");
    await expect(
      unsigned.enhancePaymentRequirements(
        base({ ...relative, paymentFlow: "authorization" }),
        supportedKind,
        [],
      ),
    ).rejects.toThrow("consentSigner");
    const deferred = await unsigned.enhancePaymentRequirements(
      base({ ...relative, captureMode: "deferred" }),
      supportedKind,
      [],
    );
    expect(deferred.extra.captureMode).toBe("deferred");
    const ownFacilitator = await unsigned.enhancePaymentRequirements(
      base({ ...relative, receiverAuthorizer: operator }),
      supportedKind,
      [],
    );
    expect(ownFacilitator.extra.receiverAuthorizer).toBe(operator);
  });

  it("fails without a deployment", async () => {
    await expect(
      scheme.enhancePaymentRequirements(
        { ...base(relative), network: "stellar:pubnet" },
        { ...supportedKind, network: "stellar:pubnet" },
        [],
      ),
    ).rejects.toThrow("no escrow deployment");
  });

  it("validates facilitator support", () => {
    expect(scheme.validateFacilitatorSupport("stellar:testnet", supportedKind, [])).toBeUndefined();
    expect(
      scheme.validateFacilitatorSupport("stellar:testnet", { ...supportedKind, extra: {} }, []),
    ).toMatch("captureAuthorizer");
    expect(
      scheme.validateFacilitatorSupport(
        "stellar:testnet",
        { ...supportedKind, extra: { captureAuthorizer: operator } },
        [],
      ),
    ).toMatch("sponsor");
  });

  it("parses prices", async () => {
    expect(await scheme.parsePrice({ amount: "5", asset: TOKEN }, "stellar:testnet")).toEqual({
      amount: "5",
      asset: TOKEN,
      extra: {},
    });
    expect(await scheme.parsePrice("$0.01", "stellar:testnet")).toMatchObject({ amount: "100000" });
    await expect(scheme.parsePrice({ amount: "5" } as never, "stellar:testnet")).rejects.toThrow(
      "Asset address",
    );
    const custom = new AuthCaptureStellarScheme().registerMoneyParser(async () => ({
      amount: "1",
      asset: TOKEN,
    }));
    expect(await custom.parsePrice("1", "stellar:testnet")).toEqual({ amount: "1", asset: TOKEN });
    expect(scheme.getAssetDecimals(TOKEN, "stellar:testnet")).toBe(7);
  });
});

describe("settlement hooks", () => {
  /**
   * A client collect payload for requirements.
   *
   * @param req - Requirements
   * @returns Payment payload
   */
  async function clientPayload(req: PaymentRequirements): Promise<PaymentPayload> {
    const info = paymentInfo(req);
    const fn = req.extra.paymentFlow === "authorization" ? "charge" : "authorize";
    const entry = await signedEntry(keys.payer, payerInvocation(ESCROW, fn, info));
    return {
      x402Version: 2,
      accepted: req,
      payload: {
        authorizationEntry: entry.toXDR("base64"),
        salt: SALT,
        preApprovalExpiry: info.preApprovalExpiry,
      },
    };
  }

  const ctx = (payload: PaymentPayload, req: PaymentRequirements, phase: string) =>
    ({ paymentPayload: payload, requirements: req, declaredExtensions: {}, phase }) as never;
  const settled = (amount: string): SettleResponse => ({
    success: true,
    transaction: "tx",
    network: "stellar:testnet",
    amount,
  });

  it("adds a signed capture with voidRemainder after the handler on sync routes", async () => {
    const scheme = new AuthCaptureStellarScheme({ consentSigner });
    const req = requirements();
    const payload = await clientPayload(req);
    expect(
      await scheme.enrichSettlementPayload(ctx(payload, req, "before-handler")),
    ).toBeUndefined();

    const partial = { ...req, amount: "6000000" };
    const fields = (await scheme.enrichSettlementPayload(
      ctx(payload, partial, "after-handler"),
    )) as Record<string, unknown>;
    expect(fields).toMatchObject({
      type: "capture",
      amount: "6000000",
      feeAmount: "0",
      feeReceiver: null,
      voidRemainder: true,
    });
    expect(fields.paymentInfo).toMatchObject({ maxAmount: MAX_AMOUNT, salt: SALT });
    const consent = xdr.SorobanAuthorizationEntry.fromXDR(fields.consentEntry as string, "base64");
    expect(consent.credentials().address().signature().switch().name).toBe("scvVec");
    expect(Object.keys(fields).some(key => key in payload.payload)).toBe(false);

    const full = (await scheme.enrichSettlementPayload(
      ctx(payload, req, "after-handler"),
    )) as Record<string, unknown>;
    expect(full.voidRemainder).toBe(false);
  });

  it("completes a charge on authorization routes and voids on cancel", async () => {
    const scheme = new AuthCaptureStellarScheme({ consentSigner });
    const authReq = requirements({ paymentFlow: "authorization", captureMode: undefined });
    const charge = (await scheme.enrichSettlementPayload(
      ctx(await clientPayload(authReq), { ...authReq, amount: "5" }, "after-handler"),
    )) as Record<string, unknown>;
    expect(charge).toMatchObject({ amount: "5", feeAmount: "0", feeReceiver: null });
    expect(charge).toHaveProperty("consentEntry");
    expect(
      await scheme.enrichSettlementPayload(ctx(await clientPayload(authReq), authReq, "cancel")),
    ).toBeUndefined();

    const req = requirements();
    const voided = (await scheme.enrichSettlementPayload(
      ctx(await clientPayload(req), req, "cancel"),
    )) as Record<string, unknown>;
    expect(voided).toMatchObject({ type: "void" });
    expect(voided).toHaveProperty("consentEntry");
  });

  it("does nothing without consent or on deferred routes", async () => {
    const unsigned = new AuthCaptureStellarScheme();
    const req = requirements();
    expect(
      await unsigned.enrichSettlementPayload(ctx(await clientPayload(req), req, "after-handler")),
    ).toBeUndefined();
    const deferred = requirements({ captureMode: "deferred" });
    const scheme = new AuthCaptureStellarScheme({ consentSigner });
    expect(
      await scheme.enrichSettlementPayload(
        ctx(await clientPayload(deferred), deferred, "after-handler"),
      ),
    ).toBeUndefined();
    expect(
      await scheme.enrichSettlementPayload(
        ctx({ ...(await clientPayload(req)), payload: {} }, req, "after-handler"),
      ),
    ).toBeUndefined();
  });

  it("records collected payments and applies capture and void", async () => {
    const storage = new InMemoryAuthorizedPaymentStorage();
    const scheme = new AuthCaptureStellarScheme({ consentSigner, storage });
    const req = requirements();
    const payload = await clientPayload(req);
    const hash = computePaymentHash(paymentInfo(req), ESCROW, PASSPHRASE);

    await scheme.schemeHooks.onAfterSettle!({
      ...ctx(payload, req, "before-handler"),
      result: settled(MAX_AMOUNT),
    } as never);
    expect(await storage.get(hash)).toMatchObject({
      capturableAmount: MAX_AMOUNT,
      refundableAmount: "0",
      paymentFlow: "escrow",
      escrow: ESCROW,
    });

    await scheme.schemeHooks.onAfterSettle!({
      ...ctx(payload, { ...req, amount: "6000000" }, "after-handler"),
      result: settled("6000000"),
    } as never);
    expect(await storage.get(hash)).toMatchObject({
      capturableAmount: "0",
      refundableAmount: "6000000",
    });

    await scheme.schemeHooks.onAfterSettle!({
      ...ctx(payload, req, "cancel"),
      result: settled(MAX_AMOUNT),
    } as never);
    expect((await storage.get(hash))?.capturableAmount).toBe("0");

    await scheme.schemeHooks.onAfterSettle!({
      ...ctx(payload, req, "before-handler"),
      result: { ...settled("1"), success: false },
    } as never);
    expect(await storage.list()).toHaveLength(1);
  });

  it("records charges as refundable", async () => {
    const storage = new InMemoryAuthorizedPaymentStorage();
    const scheme = new AuthCaptureStellarScheme({ consentSigner, storage });
    const req = requirements({ paymentFlow: "authorization", captureMode: undefined });
    await scheme.schemeHooks.onAfterSettle!({
      ...ctx(await clientPayload(req), { ...req, amount: "7" }, "after-handler"),
      result: settled("7"),
    } as never);
    const [record] = await storage.list();
    expect(record).toMatchObject({ capturableAmount: "0", refundableAmount: "7" });
  });

  it("skips the after-handler settle on deferred routes", async () => {
    const scheme = new AuthCaptureStellarScheme();
    const req = requirements({ captureMode: "deferred" });
    const payload = await clientPayload(req);
    expect(
      await scheme.schemeHooks.onBeforeSettle!(ctx(payload, req, "after-handler")),
    ).toBeUndefined();
    await scheme.schemeHooks.onAfterSettle!({
      ...ctx(payload, req, "before-handler"),
      result: settled(MAX_AMOUNT),
    } as never);
    expect(await scheme.schemeHooks.onBeforeSettle!(ctx(payload, req, "after-handler"))).toEqual({
      skip: true,
      result: settled(MAX_AMOUNT),
    });
    const sync = requirements();
    expect(
      await scheme.schemeHooks.onBeforeSettle!(ctx(payload, sync, "after-handler")),
    ).toBeUndefined();
  });

  it("settles a void on cancel only after a hold was placed", async () => {
    const scheme = new AuthCaptureStellarScheme({ consentSigner });
    const req = requirements();
    const payload = await clientPayload(req);
    const cancel = (phases: string[], r = req) =>
      scheme.settleOnCancel({ ...ctx(payload, r, "cancel"), settledPhases: phases } as never);
    expect(await cancel(["before-handler"])).toBe(req);
    expect(await cancel([])).toBeUndefined();
    const authReq = requirements({ paymentFlow: "authorization", captureMode: undefined });
    expect(await cancel(["before-handler"], authReq)).toBeUndefined();
    const unsigned = new AuthCaptureStellarScheme();
    expect(
      await unsigned.settleOnCancel({
        ...ctx(payload, req, "cancel"),
        settledPhases: ["before-handler"],
      } as never),
    ).toBeUndefined();
  });
});

describe("lifecycle manager", () => {
  const info = paymentInfo();
  const hash = computePaymentHash(info, ESCROW, PASSPHRASE);
  const record = (overrides: Partial<AuthorizedPayment> = {}): AuthorizedPayment => ({
    paymentHash: hash,
    paymentInfo: info,
    network: "stellar:testnet",
    escrow: ESCROW,
    paymentFlow: "escrow",
    capturableAmount: MAX_AMOUNT,
    refundableAmount: "0",
    collectTransaction: "tx",
    createdAt: 0,
    ...overrides,
  });

  /**
   * Builds a manager over a fake facilitator.
   *
   * @param stored - Initial record
   * @param config - Extra scheme config
   * @returns Manager, storage and the facilitator's settle spy
   */
  async function setup(
    stored: AuthorizedPayment,
    config: ConstructorParameters<typeof AuthCaptureStellarScheme>[0] = {},
  ) {
    const storage = new InMemoryAuthorizedPaymentStorage();
    await storage.update(hash, () => stored);
    const settle = vi.fn(
      async (): Promise<SettleResponse> => ({
        success: true,
        transaction: "t",
        network: "stellar:testnet",
      }),
    );
    const facilitator = { settle } as unknown as FacilitatorClient;
    const scheme = new AuthCaptureStellarScheme({ consentSigner, storage, ...config });
    return { manager: scheme.createLifecycleManager(facilitator), storage, settle };
  }

  it("captures, voids and refunds while tracking balances", async () => {
    const { manager, storage, settle } = await setup(record());
    await manager.capture(hash, { amount: "4000000" });
    expect(await storage.get(hash)).toMatchObject({
      capturableAmount: "6000000",
      refundableAmount: "4000000",
    });
    const [payload, req] = settle.mock.calls[0] as unknown as [PaymentPayload, PaymentRequirements];
    expect(payload.payload).toMatchObject({
      type: "capture",
      amount: "4000000",
      voidRemainder: false,
    });
    expect(req.extra).toMatchObject({ captureMode: "deferred", captureAuthorizer: operator });

    await manager.voidPayment(hash);
    expect((await storage.get(hash))?.capturableAmount).toBe("0");

    await manager.refund(hash, { amount: "1000000" });
    expect((await storage.get(hash))?.refundableAmount).toBe("3000000");
    const refund = (settle.mock.calls[2] as unknown as [PaymentPayload])[0].payload;
    expect(refund).toMatchObject({ type: "refund", funder: receiver });
    expect(refund).not.toHaveProperty("funderEntry");
    expect(await manager.listAuthorizedPayments()).toHaveLength(1);
    expect(await manager.getAuthorizedPayment(hash)).toBeDefined();
  });

  it("captures the whole hold by default and keeps balances on failure", async () => {
    const { manager, storage, settle } = await setup(record());
    settle.mockResolvedValueOnce({ success: false, transaction: "", network: "stellar:testnet" });
    await manager.capture(hash);
    expect((await storage.get(hash))?.capturableAmount).toBe(MAX_AMOUNT);
    await manager.capture(hash, { voidRemainder: true, amount: "1" });
    expect(await storage.get(hash)).toMatchObject({ capturableAmount: "0", refundableAmount: "1" });
  });

  it("uses a separate funder signer for refunds", async () => {
    const { manager, settle } = await setup(record({ refundableAmount: "5" }), {
      funderSigner: createEd25519Signer(keys.funder.secret()),
    });
    await manager.refund(hash, { amount: "5" });
    const refund = (settle.mock.calls[0] as unknown as [PaymentPayload])[0].payload;
    expect(refund).toMatchObject({ funder: keys.funder.publicKey() });
    expect(refund).toHaveProperty("funderEntry");
  });

  it("refuses unknown payments, capture on charges and missing signers", async () => {
    const { manager } = await setup(record({ paymentFlow: "authorization" }));
    await expect(manager.capture("00")).rejects.toThrow("no payment");
    await expect(manager.capture(hash)).rejects.toThrow("only refund applies");
    await expect(manager.voidPayment(hash)).rejects.toThrow("only refund applies");

    const { manager: unsigned } = await setup(record(), { consentSigner: undefined });
    await expect(unsigned.voidPayment(hash)).rejects.toThrow("consent address");
    await expect(
      buildRefundPayload({ network: "stellar:testnet", escrow: ESCROW, consentSigner }, info, {
        amount: "1",
        funder: keys.funder.publicKey(),
      }),
    ).rejects.toThrow("refund funder");
  });

  it("rebuilds requirements from a record", () => {
    const withFees = record({
      paymentFlow: "authorization",
      paymentInfo: {
        ...info,
        receiverAuthorizer: keys.authorizer.publicKey(),
        feeReceiver: keys.feeRecipient.publicKey(),
      },
    });
    const req = requirementsFromRecord(withFees);
    expect(req.extra).toMatchObject({
      paymentFlow: "authorization",
      receiverAuthorizer: keys.authorizer.publicKey(),
      feeRecipient: keys.feeRecipient.publicKey(),
    });
    expect(req.extra).not.toHaveProperty("captureMode");
  });
});

describe("InMemoryAuthorizedPaymentStorage", () => {
  it("reports unchanged, updated and deleted", async () => {
    const storage = new InMemoryAuthorizedPaymentStorage();
    expect((await storage.update("AB", current => current)).status).toBe("unchanged");
    const value = { paymentHash: "ab" } as AuthorizedPayment;
    expect((await storage.update("AB", () => value)).status).toBe("updated");
    expect(await storage.get("ab")).toBe(value);
    expect((await storage.update("ab", () => undefined)).status).toBe("deleted");
    expect((await storage.update("ab", () => undefined)).status).toBe("unchanged");
  });

  it("serializes concurrent updates per key", async () => {
    const storage = new InMemoryAuthorizedPaymentStorage();
    await storage.update("k", () => ({ refundableAmount: "0" }) as AuthorizedPayment);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        storage.update("k", current => ({
          ...current!,
          refundableAmount: (BigInt(current!.refundableAmount) + 1n).toString(),
        })),
      ),
    );
    expect((await storage.get("k"))?.refundableAmount).toBe("10");
  });
});
