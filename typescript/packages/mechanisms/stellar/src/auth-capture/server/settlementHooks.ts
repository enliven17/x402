import { getNetworkPassphrase, type RpcConfig } from "../../utils";
import { DEFAULT_MAX_TIMEOUT_SECONDS } from "../constants";
import { parseAuthCaptureExtra } from "../extra";
import {
  buildCapturePayload,
  buildChargeCompletion,
  buildVoidPayload,
  paymentInfoFromCollect,
  type LifecycleContext,
} from "../lifecyclePayload";
import { parseCollectPayload, parseLifecyclePayload } from "../payload";
import { computePaymentHash, consentAddress } from "../paymentInfo";
import { applyCapture, applyVoid, type AuthorizedPaymentStorage } from "./storage";
import type { ClientStellarSigner } from "../../signer";
import type { AuthCaptureStellarExtra, PaymentInfoJson } from "../types";
import type {
  SettleContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
} from "@x402/core/server";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";

export interface AuthCaptureSettlementHooksConfig {
  storage: AuthorizedPaymentStorage;
  consentSigner?: ClientStellarSigner;
  rpcConfig?: RpcConfig;
}

type ReadonlyRequirements = SettleContext["requirements"];

/**
 * In-request settlement hooks for the resource server: completes the after-handler payload
 * (sync capture or charge), voids the hold on handler failure, skips the after-handler settle
 * for deferred capture, and records collected payments for later lifecycle calls.
 */
export class AuthCaptureSettlementHooks {
  private readonly authorizeResults = new WeakMap<object, SettleResponse>();

  /**
   * Creates the hooks.
   *
   * @param config - Storage, consent signer and RPC settings
   */
  constructor(private readonly config: AuthCaptureSettlementHooksConfig) {}

  /**
   * Whether the server can produce consent for a payment.
   *
   * @param info - Payment info
   * @returns True when the consent address is the operator or the configured signer
   */
  canConsent(info: PaymentInfoJson): boolean {
    const consent = consentAddress(info);
    return consent === info.operator || this.config.consentSigner?.address === consent;
  }

  /**
   * Fields appended to the client payload: capture fields for a sync escrow route, charge
   * completion for an authorization route, and void fields on cancel.
   *
   * @param ctx - Settle context
   * @returns Fields to merge, or void
   */
  async enrichSettlementPayload(ctx: SettleContext): Promise<Record<string, unknown> | void> {
    if (ctx.phase === "before-handler") return;
    const resolved = this.resolve(ctx.requirements, ctx.paymentPayload.payload);
    if (!resolved || !this.canConsent(resolved.paymentInfo)) return;
    const { extra, paymentInfo } = resolved;
    const lifecycle = this.lifecycleContext(ctx.requirements, extra);

    if (ctx.phase === "cancel") {
      if (extra.paymentFlow !== "escrow") return;
      return { ...(await buildVoidPayload(lifecycle, paymentInfo)) };
    }
    if (ctx.phase !== "after-handler") return;

    if (extra.paymentFlow === "authorization") {
      return {
        ...(await buildChargeCompletion(lifecycle, paymentInfo, {
          amount: ctx.requirements.amount,
        })),
      };
    }
    if (extra.captureMode === "sync") {
      const amount = ctx.requirements.amount;
      const payload = await buildCapturePayload(lifecycle, paymentInfo, {
        amount,
        voidRemainder: BigInt(amount) < BigInt(paymentInfo.maxAmount),
      });
      return { ...payload };
    }
  }

  /**
   * Requirements to settle a void when the handler fails after the hold was placed.
   *
   * @param context - Cancellation context
   * @returns Requirements for the cancel settle, or void
   */
  async settleOnCancel(
    context: VerifiedPaymentCanceledContext,
  ): Promise<PaymentRequirements | void> {
    if (!context.settledPhases.includes("before-handler")) return;
    const resolved = this.resolve(context.requirements, context.paymentPayload.payload);
    if (!resolved || resolved.extra.paymentFlow !== "escrow") return;
    if (!this.canConsent(resolved.paymentInfo)) return;
    return context.requirements as PaymentRequirements;
  }

  /**
   * Skips the after-handler facilitator settle on deferred escrow routes and echoes the
   * authorize receipt.
   *
   * @param ctx - Settle context
   * @returns Skip directive, or void
   */
  async handleBeforeSettle(
    ctx: SettleContext,
  ): Promise<void | { skip: true; result: SettleResponse }> {
    if (ctx.phase !== "after-handler") return;
    const parsed = parseAuthCaptureExtra(ctx.requirements.extra);
    if ("error" in parsed || parsed.value.captureMode !== "deferred") return;
    const prior = this.authorizeResults.get(ctx.paymentPayload);
    return prior ? { skip: true, result: prior } : undefined;
  }

  /**
   * Records collected payments and applies capture and void results to stored balances.
   *
   * @param ctx - Settle result context
   * @returns Nothing
   */
  async handleAfterSettle(ctx: SettleResultContext): Promise<void> {
    if (!ctx.result.success) return;
    const resolved = this.resolve(ctx.requirements, ctx.paymentPayload.payload);
    if (!resolved) return;
    const { extra, paymentInfo } = resolved;
    const paymentHash = computePaymentHash(
      paymentInfo,
      extra.authCaptureEscrow,
      getNetworkPassphrase(ctx.requirements.network),
    );

    const collected =
      ctx.phase === "before-handler" ||
      (ctx.phase === "after-handler" && extra.paymentFlow === "authorization");
    if (collected) {
      if (ctx.phase === "before-handler") {
        this.authorizeResults.set(ctx.paymentPayload, ctx.result as SettleResponse);
      }
      const charged = extra.paymentFlow === "authorization";
      const amount = ctx.result.amount ?? ctx.requirements.amount;
      await this.config.storage.update(
        paymentHash,
        current =>
          current ?? {
            paymentHash,
            paymentInfo,
            network: ctx.requirements.network,
            escrow: extra.authCaptureEscrow,
            paymentFlow: extra.paymentFlow,
            capturableAmount: charged ? "0" : paymentInfo.maxAmount,
            refundableAmount: charged ? amount : "0",
            collectTransaction: ctx.result.transaction,
            createdAt: Date.now(),
          },
      );
      return;
    }

    if (ctx.phase === "cancel") {
      await applyVoid(this.config.storage, paymentHash);
    } else if (ctx.phase === "after-handler" && extra.captureMode === "sync") {
      const amount = ctx.result.amount ?? ctx.requirements.amount;
      await applyCapture(
        this.config.storage,
        paymentHash,
        amount,
        BigInt(amount) < BigInt(paymentInfo.maxAmount),
      );
    }
  }

  /**
   * Parses the route extra and rebuilds `PaymentInfo` from the client (or lifecycle) payload.
   *
   * @param requirements - Requirements of this settle
   * @param raw - Payload as sent by the client
   * @returns Extra and payment info, or undefined when the payload is not auth-capture
   */
  private resolve(
    requirements: ReadonlyRequirements,
    raw: unknown,
  ): { extra: AuthCaptureStellarExtra; paymentInfo: PaymentInfoJson } | undefined {
    const parsed = parseAuthCaptureExtra(requirements.extra);
    if ("error" in parsed) return undefined;
    const collect = parseCollectPayload(raw);
    if (collect) {
      try {
        return {
          extra: parsed.value,
          paymentInfo: paymentInfoFromCollect(collect, requirements, parsed.value),
        };
      } catch {
        return undefined;
      }
    }
    const lifecycle = parseLifecyclePayload(raw);
    return lifecycle ? { extra: parsed.value, paymentInfo: lifecycle.paymentInfo } : undefined;
  }

  /**
   * Network context for server-signed entries.
   *
   * @param requirements - Requirements of this settle
   * @param extra - Validated extra
   * @returns Lifecycle context
   */
  private lifecycleContext(
    requirements: ReadonlyRequirements,
    extra: AuthCaptureStellarExtra,
  ): LifecycleContext {
    return {
      network: requirements.network,
      escrow: extra.authCaptureEscrow,
      rpcConfig: this.config.rpcConfig,
      timeoutSeconds: requirements.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
      consentSigner: this.config.consentSigner,
    };
  }
}
