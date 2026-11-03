import type { AuthCapturePaymentFlow, PaymentInfoJson } from "../types";
import type { Network } from "@x402/core/types";

/** A collected payment the server can still capture, void or refund. */
export interface AuthorizedPayment {
  /** Escrow payment hash (hex), the storage key. */
  paymentHash: string;
  paymentInfo: PaymentInfoJson;
  network: Network;
  /** `AuthCaptureEscrow` contract address. */
  escrow: string;
  paymentFlow: AuthCapturePaymentFlow;
  capturableAmount: string;
  refundableAmount: string;
  collectTransaction: string;
  createdAt: number;
}

export interface AuthorizedPaymentUpdateResult {
  payment: AuthorizedPayment | undefined;
  status: "updated" | "unchanged" | "deleted";
}

export interface AuthorizedPaymentStorage {
  get(paymentHash: string): Promise<AuthorizedPayment | undefined>;
  list(): Promise<AuthorizedPayment[]>;
  /**
   * Atomically inspects and mutates a payment record. No concurrent mutation may interleave
   * between reading `current` and writing the result, across every instance that shares the
   * backend.
   *
   * @param paymentHash - Escrow payment hash
   * @param update - Mutation callback; return `undefined` to delete or `current` to keep
   * @returns The final record and whether it was updated, kept, or deleted
   */
  update(
    paymentHash: string,
    update: (current: AuthorizedPayment | undefined) => AuthorizedPayment | undefined,
  ): Promise<AuthorizedPaymentUpdateResult>;
}

/**
 * Per-key async mutex: calls with the same key run one at a time.
 *
 * @returns A `withLock(key, fn)` function
 */
function createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const locks = new Map<string, Promise<void>>();
  return async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const next = previous.then(() => current);
    locks.set(key, next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === next) locks.delete(key);
    }
  };
}

/**
 * In-memory {@link AuthorizedPaymentStorage}. Atomic only inside one JS runtime, and records
 * are lost on restart; the payer then recovers a hold with `reclaim` after the capture deadline.
 */
export class InMemoryAuthorizedPaymentStorage implements AuthorizedPaymentStorage {
  private readonly payments = new Map<string, AuthorizedPayment>();
  private readonly withLock = createKeyedLock();

  /**
   * Returns a record.
   *
   * @param paymentHash - Escrow payment hash
   * @returns The record, or undefined
   */
  async get(paymentHash: string): Promise<AuthorizedPayment | undefined> {
    return this.payments.get(paymentHash.toLowerCase());
  }

  /**
   * Lists all records.
   *
   * @returns All records
   */
  async list(): Promise<AuthorizedPayment[]> {
    return [...this.payments.values()];
  }

  /**
   * Atomically inspects and mutates a record.
   *
   * @param paymentHash - Escrow payment hash
   * @param update - Mutation callback
   * @returns The final record and the kind of change
   */
  async update(
    paymentHash: string,
    update: (current: AuthorizedPayment | undefined) => AuthorizedPayment | undefined,
  ): Promise<AuthorizedPaymentUpdateResult> {
    const key = paymentHash.toLowerCase();
    return this.withLock(key, async () => {
      const current = this.payments.get(key);
      const next = update(current);
      if (next === current) return { payment: current, status: "unchanged" };
      if (!next) {
        this.payments.delete(key);
        return { payment: undefined, status: current ? "deleted" : "unchanged" };
      }
      this.payments.set(key, next);
      return { payment: next, status: "updated" };
    });
  }
}

/**
 * Applies a successful capture to stored balances.
 *
 * @param storage - Storage
 * @param paymentHash - Escrow payment hash
 * @param amount - Captured amount
 * @param voidRemainder - Whether the remaining hold was released
 * @returns Nothing
 */
export async function applyCapture(
  storage: AuthorizedPaymentStorage,
  paymentHash: string,
  amount: string,
  voidRemainder: boolean,
): Promise<void> {
  await storage.update(paymentHash, current => {
    if (!current) return current;
    const capturable = BigInt(current.capturableAmount) - BigInt(amount);
    return {
      ...current,
      capturableAmount: voidRemainder ? "0" : capturable.toString(),
      refundableAmount: (BigInt(current.refundableAmount) + BigInt(amount)).toString(),
    };
  });
}

/**
 * Applies a successful void to stored balances.
 *
 * @param storage - Storage
 * @param paymentHash - Escrow payment hash
 * @returns Nothing
 */
export async function applyVoid(
  storage: AuthorizedPaymentStorage,
  paymentHash: string,
): Promise<void> {
  await storage.update(paymentHash, current =>
    current ? { ...current, capturableAmount: "0" } : current,
  );
}

/**
 * Applies a successful refund to stored balances.
 *
 * @param storage - Storage
 * @param paymentHash - Escrow payment hash
 * @param amount - Refunded amount
 * @returns Nothing
 */
export async function applyRefund(
  storage: AuthorizedPaymentStorage,
  paymentHash: string,
  amount: string,
): Promise<void> {
  await storage.update(paymentHash, current =>
    current
      ? {
          ...current,
          refundableAmount: (BigInt(current.refundableAmount) - BigInt(amount)).toString(),
        }
      : current,
  );
}
