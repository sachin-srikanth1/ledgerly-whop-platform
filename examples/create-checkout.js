"use strict";

/**
 * Create a checkout on a seller's account, carrying Ledgerly's 8% fee.
 *
 * Pass the seller's connected account id as the first argument:
 *   node examples/create-checkout.js biz_xxxxxxxxxxxx
 */

const { createCheckout, getFeeBreakdown } = require("../dist");
const { platformClient } = require("./client");

async function main() {
  const sellerAccountId = process.argv[2];

  if (!sellerAccountId) {
    console.error("Usage: node examples/create-checkout.js <biz_seller_account_id>");
    process.exit(1);
  }

  const price = 25.0;

  console.log("Fee breakdown");
  for (const [key, value] of Object.entries(getFeeBreakdown(price, "usd"))) {
    console.log(`  ${key}: ${value}`);
  }

  const checkout = await createCheckout(platformClient(), {
    sellerAccountId,
    productTitle: "Premium Course",
    price,
    currency: "usd",
    redirectUrl: "https://ledgerly.example.com/thanks",
  });

  console.log("\nCheckout");
  console.log(`  id:   ${checkout.checkoutId}`);
  console.log(`  url:  ${checkout.checkoutUrl}`);
  console.log(`  fee:  ${checkout.applicationFee} ${checkout.currency.toUpperCase()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
