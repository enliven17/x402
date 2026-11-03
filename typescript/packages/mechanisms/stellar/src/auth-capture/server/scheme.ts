import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import { AUTH_CAPTURE_SCHEME, canonicalEscrowAddress } from "../constants";
import { isAccountAddress, parseAuthCaptureExtra } from "../extra";
import { AuthCaptureLifecycleManager } from "./lifecycleManager";
import { AuthCaptureSettlementHooks } from "./settlementHooks";
import { InMemoryAuthorizedPaymentStorage, type AuthorizedPaymentStorage } from "./storage";
import type { ClientStellarSigner } from "../../signer";
import type { RpcConfig } from "../../utils";
import type { FacilitatorClient, VerifiedPaymentCanceledContext } from "@x402/core/server";
import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemeServerHooks,
  SupportedKind,
} from "@x402/core/types";

export interface AuthCaptureStellarServerConfig {
  /**
   * Signer for the consent address (`receiverAuthorizer`, or `payTo` when unset). Required for
   * escrow `"sync"` and `"authorization"` routes unless the consent address is the operator.
   * When its address differs from `payTo`, it is published as `extra.receiverAuthorizer`.
   */
  consentSigner?: ClientStellarSigner;
  /** Refund funder when it is not the consent address. */
  funderSigner?: ClientStellarSigner;
  /** Storage for collected payments (default: in memory). */
  storage?: AuthorizedPaymentStorage;
  /** Custom RPC URL (required for pubnet). */
  rpcConfig?: RpcConfig;
  /** Escrow addresses per network that override the canonical deployments. */
  escrowAddresses?: Readonly<Record<string, string>>;
}

/**
 * Route `extra` accepted by {@link AuthCaptureStellarScheme.enhancePaymentRequirements}. Set
 * either the relative deadline offsets (recommended) or both absolute deadlines.
 */
export interface AuthCaptureStellarRouteExtra {
  paymentFlow?: "escrow" | "authorization";
  captureMode?: "sync" | "deferred";
  captureDeadlineSeconds?: number;
  refundDeadlineSeconds?: number;
  captureDeadline?: number;
  refundDeadline?: number;
  receiverAuthorizer?: string;
  minFeeBps?: number;
  maxFeeBps?: number;
  feeRecipient?: string;
}

/** Relative deadlines are bucketed so repeated 402s within a minute publish equal values. */
const DEADLINE_BUCKET_SECONDS = 60;

/**
 * Resolves the relative or absolute deadline pair.
 *
 * @param extra - Merged extra (mutated: relative keys are removed)
 * @throws When the pair is missing, mixed, or not positive
 */
function resolveDeadlines(extra: Record<string, unknown>): void {
  const relative = ["captureDeadlineSeconds", "refundDeadlineSeconds"].map(key => extra[key]);
  const absolute = ["captureDeadline", "refundDeadline"].map(key => extra[key]);
  const hasRelative = relative.some(value => value !== undefined);
  const hasAbsolute = absolute.some(value => value !== undefined);
  delete extra.captureDeadlineSeconds;
  delete extra.refundDeadlineSeconds;

  if (hasRelative === hasAbsolute) {
    throw new Error(
      "auth-capture extra must set either captureDeadlineSeconds and refundDeadlineSeconds, " +
        "or captureDeadline and refundDeadline",
    );
  }
  const values = hasRelative ? relative : absolute;
  if (
    !values.every(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  ) {
    throw new Error("auth-capture deadlines must both be positive integers");
  }
  if (hasRelative) {
    const now = Math.floor(Date.now() / 1000);
    const base = now - (now % DEADLINE_BUCKET_SECONDS);
    extra.captureDeadline = base + (values[0] as number);
    extra.refundDeadline = base + (values[1] as number);
  }
}

/**
 * Stellar resource-server implementation of the `auth-capture` scheme.
 *
 * Publishes the binding's `extra`, completes after-handler settles (sync capture, charge),
 * voids holds when the handler fails, skips the after-handler settle on deferred routes, and
 * records collected payments for {@link AuthCaptureLifecycleManager}.
 */
export class AuthCaptureStellarScheme implements SchemeNetworkServer {
  readonly scheme = AUTH_CAPTURE_SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly dynamicExtraFields = ["captureDeadline", "refundDeadline"];
  readonly paymentFlows = {
    default: { supported: ["escrow", "authorization"], default: "escrow" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  readonly schemeHooks: SchemeServerHooks;
  readonly enrichSettlementPayload: AuthCaptureSettlementHooks["enrichSettlementPayload"];

  private readonly moneyParsers: MoneyParser[] = [];
  private readonly storage: AuthorizedPaymentStorage;
  private readonly hooks: AuthCaptureSettlementHooks;

  /**
   * Creates the server scheme.
   *
   * @param config - Signers, storage and RPC settings
   */
  constructor(private readonly config: AuthCaptureStellarServerConfig = {}) {
    this.storage = config.storage ?? new InMemoryAuthorizedPaymentStorage();
    this.hooks = new AuthCaptureSettlementHooks({
      storage: this.storage,
      consentSigner: config.consentSigner,
      rpcConfig: config.rpcConfig,
    });
    this.schemeHooks = {
      onBeforeSettle: ctx => this.hooks.handleBeforeSettle(ctx),
      onAfterSettle: ctx => this.hooks.handleAfterSettle(ctx),
    };
    this.enrichSettlementPayload = ctx => this.hooks.enrichSettlementPayload(ctx);
  }

  /**
   * Adds a money parser; parsers run in registration order before the default asset.
   *
   * @param parser - Parser returning an `AssetAmount`, or null to defer
   * @returns This scheme
   */
  registerMoneyParser(parser: MoneyParser): AuthCaptureStellarScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Decimals of a known default asset.
   *
   * @param asset - Asset address or symbol
   * @param network - Network
   * @returns Decimals, or undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Converts a price into an asset amount.
   *
   * @param price - Money or `AssetAmount`
   * @param network - Network
   * @returns Asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return { amount: price.amount, asset: price.asset, extra: price.extra || {} };
    }
    const { amount, symbol } = parseMoney(price);
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) return result;
    }
    const asset = getDefaultAsset(network, symbol);
    return {
      amount: convertToTokenAmount(amount, asset.decimals),
      asset: asset.asset,
      extra: {},
    };
  }

  /**
   * Merges the facilitator's `/supported` extra with the route extra, resolves deadlines,
   * payment flow, capture mode and receiver authorizer, and validates the result.
   *
   * @param requirements - Route requirements
   * @param supportedKind - Facilitator kind for this scheme and network
   * @param _ - Facilitator extensions (unused)
   * @returns Requirements with the binding's `extra`
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: SupportedKind,
    _: string[],
  ): Promise<PaymentRequirements> {
    const extra: Record<string, unknown> = { ...supportedKind.extra, ...requirements.extra };
    resolveDeadlines(extra);

    extra.paymentFlow = extra.paymentFlow ?? "escrow";
    if (extra.paymentFlow === "escrow") {
      extra.captureMode = extra.captureMode ?? "sync";
    }

    const signer = this.config.consentSigner;
    const route = requirements.extra?.receiverAuthorizer;
    if (signer && route !== undefined && route !== signer.address) {
      throw new Error(
        `auth-capture receiverAuthorizer ${String(route)} does not match the consent signer ${signer.address}`,
      );
    }
    if (route === undefined && signer && signer.address !== requirements.payTo) {
      extra.receiverAuthorizer = signer.address;
    }
    if (extra.feeRecipient === undefined) {
      extra.minFeeBps = extra.minFeeBps ?? 0;
      extra.maxFeeBps = extra.maxFeeBps ?? 0;
    }

    const escrow = canonicalEscrowAddress(requirements.network, this.config.escrowAddresses);
    if (!escrow) {
      throw new Error(`auth-capture has no escrow deployment on ${requirements.network}`);
    }
    if (extra.authCaptureEscrow !== undefined && extra.authCaptureEscrow !== escrow) {
      throw new Error(`auth-capture escrow ${String(extra.authCaptureEscrow)} is not canonical`);
    }
    extra.authCaptureEscrow = escrow;

    const parsed = parseAuthCaptureExtra(extra);
    if ("error" in parsed) {
      throw new Error(`auth-capture extra is invalid: ${parsed.message}`);
    }
    const value = parsed.value;
    const needsConsent = value.paymentFlow === "authorization" || value.captureMode === "sync";
    const consent = value.receiverAuthorizer ?? requirements.payTo;
    if (needsConsent && consent !== value.captureAuthorizer && signer?.address !== consent) {
      throw new Error(
        `auth-capture ${value.paymentFlow} routes${value.captureMode ? ` with captureMode "${value.captureMode}"` : ""} ` +
          `need a consentSigner for ${consent}`,
      );
    }
    return { ...requirements, extra: { ...extra, ...value } };
  }

  /**
   * Fails server startup when the facilitator does not advertise an operator account.
   *
   * @param network - Network
   * @param supportedKind - Facilitator kind
   * @param _ - Facilitator extensions (unused)
   * @returns Problem description, or void
   */
  validateFacilitatorSupport(
    network: Network,
    supportedKind: SupportedKind,
    _: string[],
  ): string | void {
    if (!isAccountAddress(supportedKind.extra?.captureAuthorizer)) {
      return `facilitator does not advertise a captureAuthorizer account for auth-capture on ${network}`;
    }
    if (supportedKind.extra?.areFeesSponsored !== true) {
      return `facilitator does not sponsor fees for auth-capture on ${network}`;
    }
  }

  /**
   * Requirements for a void settle when the handler fails after the hold was placed.
   *
   * @param context - Cancellation context
   * @returns Requirements, or void
   */
  settleOnCancel(context: VerifiedPaymentCanceledContext): Promise<PaymentRequirements | void> {
    return this.hooks.settleOnCancel(context);
  }

  /**
   * Creates a manager for out-of-band capture, void and refund.
   *
   * @param facilitator - Facilitator client
   * @returns Lifecycle manager
   */
  createLifecycleManager(facilitator: FacilitatorClient): AuthCaptureLifecycleManager {
    return new AuthCaptureLifecycleManager({ scheme: this, facilitator });
  }

  /**
   * Storage of collected payments.
   *
   * @returns Storage backend
   */
  getStorage(): AuthorizedPaymentStorage {
    return this.storage;
  }

  /**
   * Consent signer, if configured.
   *
   * @returns Signer, or undefined
   */
  getConsentSigner(): ClientStellarSigner | undefined {
    return this.config.consentSigner;
  }

  /**
   * Refund funder signer, if configured.
   *
   * @returns Signer, or undefined
   */
  getFunderSigner(): ClientStellarSigner | undefined {
    return this.config.funderSigner;
  }

  /**
   * RPC settings.
   *
   * @returns RPC configuration, or undefined
   */
  getRpcConfig(): RpcConfig | undefined {
    return this.config.rpcConfig;
  }
}
