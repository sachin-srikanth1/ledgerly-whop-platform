import type { WhopClient } from "@whop/sdk";
import { LEDGERLY_FEE_BASIS_POINTS } from "./checkout";
import { toCents, toMajorUnits } from "./money";

const BASIS_POINTS_PER_UNIT = 10_000;

export interface PaySellerShareInput {
  /** The platform account funds leave, prefixed `biz_`. */
  platformAccountId: string;
  /** The seller's connected account, prefixed `biz_`. */
  sellerAccountId: string;
  /** The full amount the buyer paid, in major units. */
  grossAmount: number;
  currency: string;
  /**
   * A key unique to this payout. Whop returns the original transfer rather than
   * moving money twice when a key repeats, which is what makes a retry safe.
   * Derive it from the payment being settled (`payout:pay_abc123`), never from
   * a timestamp or random value, or a retry creates a second transfer.
   */
  idempotenceKey: string;
  metadata?: Record<string, unknown>;
  notes?: string;
}

export interface PaySellerShareResult {
  transferId: string;
  status: string;
  /** What the seller was sent, in major units. */
  sellerAmount: number;
  /** What Ledgerly kept, in major units. */
  platformFee: number;
  currency: string;
}

/**
 * Transfer a seller their share of a payment Ledgerly collected, keeping 8%.
 *
 * This is the second money flow: rather than charging on the seller's account
 * and letting Whop split it, Ledgerly takes the whole charge and moves the
 * seller's share afterwards.
 *
 * ## Balance must have settled
 *
 * A transfer draws on the platform's *available* balance. A charge collected
 * moments ago is still pending and cannot fund one: the call fails when the
 * amount exceeds the available balance. Drive this from the
 * `ledger_account.funds_available` webhook, or a scheduled sweep, rather than
 * calling it inline on `payment.succeeded`.
 *
 * (A platform account may be configured to transfer pending balance to its
 * connected accounts; `can_transfer_pending_balance_to_children` on the account
 * says whether yours is.)
 *
 * @throws whatever the API returns, notably an insufficient-balance error,
 * which is a signal to retry later with the same `idempotenceKey`, not to
 * halve the amount.
 */
export async function paySellerShare(
  client: WhopClient,
  input: PaySellerShareInput
): Promise<PaySellerShareResult> {
  const {
    platformAccountId,
    sellerAccountId,
    grossAmount,
    currency,
    idempotenceKey,
    metadata,
    notes,
  } = input;

  if (!platformAccountId) throw new Error("platformAccountId is required");
  if (!sellerAccountId) throw new Error("sellerAccountId is required");
  if (!idempotenceKey) throw new Error("idempotenceKey is required");

  const { sellerAmount, platformFee } = splitSellerShare(grossAmount);

  const transfer: any = await (client.transfers.create as any)({
    type: "ledger",
    origin_id: platformAccountId,
    destination_id: sellerAccountId,
    amount: sellerAmount,
    currency: currency.toLowerCase(),
    idempotence_key: idempotenceKey,
    ...(metadata ? { metadata } : {}),
    ...(notes ? { notes } : {}),
  });

  return {
    transferId: transfer.id,
    status: transfer.status,
    sellerAmount,
    platformFee,
    currency: currency.toLowerCase(),
  };
}

/**
 * Split a gross amount into the seller's share and Ledgerly's 8%.
 *
 * The two always sum back to the gross exactly: the fee is rounded and the
 * seller gets the remainder, so no cent is created or lost in the split.
 */
export function splitSellerShare(grossAmount: number): {
  sellerAmount: number;
  platformFee: number;
} {
  const grossCents = toCents(grossAmount);

  if (grossCents <= 0) {
    throw new RangeError(`Gross amount must be greater than 0, got ${grossAmount}`);
  }

  const feeCents = Math.round((grossCents * LEDGERLY_FEE_BASIS_POINTS) / BASIS_POINTS_PER_UNIT);
  const sellerCents = grossCents - feeCents;

  if (sellerCents <= 0) {
    throw new RangeError(`Gross amount ${grossAmount} leaves the seller nothing after the 8% fee`);
  }

  return {
    sellerAmount: toMajorUnits(sellerCents),
    platformFee: toMajorUnits(feeCents),
  };
}
