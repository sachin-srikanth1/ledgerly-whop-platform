import type { WhopClient } from "@whop/sdk";
import { formatMoney, toCents, toMajorUnits } from "./money";

/** Ledgerly's platform fee, in basis points. 800 bp = 8%. */
export const LEDGERLY_FEE_BASIS_POINTS = 800;

const BASIS_POINTS_PER_UNIT = 10_000;

export interface CreateCheckoutInput {
  /** The seller's connected account, prefixed `biz_`. */
  sellerAccountId: string;
  productTitle: string;
  /** Price in major units, e.g. 25.00. Must be a whole number of cents. */
  price: number;
  /** ISO 4217, e.g. "usd". */
  currency: string;
  redirectUrl: string;
  /** `one_time` (default) or `renewal` for a subscription. */
  planType?: "one_time" | "renewal";
  /** Days between charges. Required by Whop when `planType` is `renewal`. */
  billingPeriodDays?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateCheckoutResult {
  checkoutId: string;
  checkoutUrl: string;
  price: number;
  /** Ledgerly's 8% cut, in major units. */
  applicationFee: number;
  currency: string;
}

/**
 * Create a checkout on a seller's connected account, taking Ledgerly's 8% fee.
 *
 * The charge is created directly on the connected account: the buyer pays the
 * seller, Whop routes `application_fee_amount` to the platform, and the seller
 * bears Whop's own processing fees, refunds and disputes out of the remainder.
 *
 * What the seller nets is therefore not something this function can state — it
 * depends on Whop's fee schedule for that account, the buyer's card, and any
 * currency conversion. Read it from `payments.listFees` on the resulting
 * payment rather than estimating it here.
 *
 * @param client Whop client authenticated with the *platform* API key.
 */
export async function createCheckout(
  client: WhopClient,
  input: CreateCheckoutInput
): Promise<CreateCheckoutResult> {
  const {
    sellerAccountId,
    productTitle,
    price,
    currency,
    redirectUrl,
    planType = "one_time",
    billingPeriodDays,
    metadata,
  } = input;

  if (!sellerAccountId) throw new Error("sellerAccountId is required");
  if (!productTitle) throw new Error("productTitle is required");
  if (!currency) throw new Error("currency is required");
  if (!redirectUrl) throw new Error("redirectUrl is required");

  if (planType === "renewal" && !billingPeriodDays) {
    throw new Error("billingPeriodDays is required when planType is 'renewal'");
  }

  const applicationFee = calculateApplicationFee(price);

  const checkout: any = await (client.checkoutConfigurations.create as any)({
    account_id: sellerAccountId,
    redirect_url: redirectUrl,
    ...(metadata ? { metadata } : {}),
    plan: {
      title: productTitle,
      plan_type: planType,
      initial_price: price,
      currency: currency.toLowerCase(),
      // Whop takes this in major units, matching initial_price — not cents.
      application_fee_amount: applicationFee,
      ...(planType === "renewal"
        ? { renewal_price: price, billing_period: billingPeriodDays }
        : {}),
    },
  });

  return {
    checkoutId: checkout.id,
    checkoutUrl: checkout.purchase_url ?? checkout.url ?? "",
    price,
    applicationFee,
    currency: currency.toLowerCase(),
  };
}

/**
 * Ledgerly's 8% fee on `price`, in major units.
 *
 * Computed in integer cents and rounded half-up, so the result is always a
 * whole number of cents and always exactly 8% of the price to within the
 * rounding a cent-denominated currency forces.
 *
 * @throws {RangeError} when `price` is not a positive whole-cent amount, or is
 * small enough that 8% rounds to nothing. Whop rejects a zero or negative
 * `application_fee_amount`, so a $0.05 sale cannot carry this fee at all.
 */
export function calculateApplicationFee(price: number): number {
  const priceCents = toCents(price);

  if (priceCents <= 0) {
    throw new RangeError(`Price must be greater than 0, got ${price}`);
  }

  const feeCents = Math.round((priceCents * LEDGERLY_FEE_BASIS_POINTS) / BASIS_POINTS_PER_UNIT);

  if (feeCents <= 0) {
    throw new RangeError(
      `Price ${price} is too small to carry an 8% fee: it rounds to 0. ` +
        `Whop requires a positive application_fee_amount.`
    );
  }

  if (feeCents >= priceCents) {
    throw new RangeError(
      `Computed fee ${toMajorUnits(feeCents)} is not less than price ${price}`
    );
  }

  return toMajorUnits(feeCents);
}

/**
 * Assert that `fee` is exactly Ledgerly's 8% of `price`.
 *
 * Exact to the cent — no tolerance. A fee that is a cent off is a fee that was
 * computed by something other than {@link calculateApplicationFee}, which is
 * the thing worth catching.
 *
 * @throws {RangeError} when the fee does not match.
 */
export function validateApplicationFee(price: number, fee: number): void {
  const expected = calculateApplicationFee(price);

  if (toCents(fee) !== toCents(expected)) {
    throw new RangeError(
      `Invalid application fee: expected ${expected} (8% of ${price}), got ${fee}`
    );
  }
}

/**
 * Fee breakdown for display.
 *
 * Reports only what Ledgerly controls. Whop's processing fees are deducted from
 * the seller's share and vary by account, card and currency, so the seller's
 * net is knowable only after the payment settles — see `payments.listFees`.
 */
export function getFeeBreakdown(price: number, currency: string = "usd") {
  const applicationFee = calculateApplicationFee(price);
  const beforeWhopFees = toMajorUnits(toCents(price) - toCents(applicationFee));

  return {
    price: formatMoney(price, currency),
    ledgerlyFee: formatMoney(applicationFee, currency),
    ledgerlyFeePercentage: `${LEDGERLY_FEE_BASIS_POINTS / 100}%`,
    sellerGross: formatMoney(beforeWhopFees, currency),
    note: "sellerGross is before Whop's processing fees, which the seller pays.",
  };
}
