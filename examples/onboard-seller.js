"use strict";

/**
 * Onboard a seller, idempotently.
 *
 * Run it twice. The second run finds the account the first one created and
 * reports `created: false`, but still mints a fresh onboarding link, because those
 * expire, so there is nothing to reuse.
 */

const path = require("node:path");
const { onboardSeller, getOnboardingStatus, FileStore } = require("../dist");
const { platformClient } = require("./client");

async function main() {
  const client = platformClient();

  // In production this is your database, not a file. See src/store.ts.
  const store = new FileStore(path.join(process.cwd(), "seller-accounts.json"));

  const seller = await onboardSeller(
    client,
    {
      externalId: "seller_us_001",
      email: "seller@example.com",
      country: "US",
      returnUrl: "https://ledgerly.example.com/onboarding/complete",
      refreshUrl: "https://ledgerly.example.com/onboarding/refresh",
    },
    { store }
  );

  console.log(seller.created ? "Created a new account" : "Found the existing account");
  console.log(`  account:    ${seller.accountId}`);
  console.log(`  externalId: ${seller.externalId}`);
  console.log(`  status:     ${seller.status}`);
  console.log(`  onboarding: ${seller.onboardingUrl}`);

  const status = await getOnboardingStatus(client, seller.accountId);

  console.log("\nVerification");
  console.log(`  individual:      ${status.individualVerification}`);
  console.log(`  business:        ${status.businessVerification}`);
  console.log(`  accepts cards:   ${status.canAcceptPayments}`);
  console.log(`  required actions: ${status.requiredActions.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
