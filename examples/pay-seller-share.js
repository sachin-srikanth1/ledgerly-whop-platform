"use strict";

/**
 * The transfer flow: Ledgerly collected the charge, and now sends the seller
 * their 92% while keeping the 8% fee.
 *
 *   node examples/pay-seller-share.js biz_seller_account pay_the_payment_id 25.00
 *
 * The transfer draws on the platform's *available* balance, so a charge from
 * moments ago cannot fund one. Drive this from `ledger_account.funds_available`
 * or a scheduled sweep rather than inline on `payment.succeeded`.
 */

const { paySellerShare, splitSellerShare } = require("../dist");
const { platformClient } = require("./client");

async function main() {
  const [sellerAccountId, paymentId, amount] = process.argv.slice(2);

  if (!sellerAccountId || !paymentId || !amount) {
    console.error(
      "Usage: node examples/pay-seller-share.js <biz_seller> <pay_id> <gross_amount>"
    );
    process.exit(1);
  }

  const platformAccountId = process.env.LEDGERLY_PLATFORM_ACCOUNT_ID;

  if (!platformAccountId) {
    console.error("LEDGERLY_PLATFORM_ACCOUNT_ID is not set.");
    process.exit(1);
  }

  const gross = Number(amount);
  const split = splitSellerShare(gross);
  console.log(`Splitting ${gross}: seller ${split.sellerAmount}, Ledgerly ${split.platformFee}`);

  const transfer = await paySellerShare(platformClient(), {
    platformAccountId,
    sellerAccountId,
    grossAmount: gross,
    currency: "usd",
    // Derived from the payment, so a retry attaches to the original transfer
    // instead of paying the seller twice. Never a timestamp or a random value.
    idempotenceKey: `payout:${paymentId}`,
    notes: `Seller share of ${paymentId}`,
    metadata: { payment_id: paymentId },
  });

  console.log(`\nTransfer ${transfer.transferId} is ${transfer.status}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
