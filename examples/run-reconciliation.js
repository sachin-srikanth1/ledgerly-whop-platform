"use strict";

/**
 * Reconcile one seller's Whop payments and transfers against a local ledger.
 *
 *   node examples/run-reconciliation.js biz_xxxxxxxxxxxx
 *
 * The ledger below is hardcoded stand-in data. Replace it with a query against
 * your own transactions table for the same window.
 */

const fs = require("node:fs");
const { reconcileSeller, formatReport } = require("../dist");
const { platformClient } = require("./client");

// Reconcile a closed window, not one ending at "now": a payment created while
// the job runs lands on one side of the diff and not the other.
const until = new Date(new Date().setUTCHours(0, 0, 0, 0));
const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);

const localLedger = [
  { id: "pay_example_1", kind: "payment", amount: "25.00", currency: "usd", status: "paid" },
  { id: "tran_example_1", kind: "transfer", amount: "23.00", currency: "usd", status: "succeeded" },
];

async function main() {
  const sellerAccountId = process.argv[2];

  if (!sellerAccountId) {
    console.error("Usage: node examples/run-reconciliation.js <biz_seller_account_id>");
    process.exit(1);
  }

  const report = await reconcileSeller(platformClient(), {
    sellerAccountId,
    localLedger,
    since,
    until,
    // Whop's status vocabulary is not Ledgerly's. Without a mapping, every row
    // reports a status mismatch.
    normalizeStatus: (status) =>
      ({ paid: "settled", succeeded: "settled", complete: "settled" })[status.toLowerCase()] ??
      status.toLowerCase(),
  });

  console.log(formatReport(report));

  const outputPath = `reconciliation-${sellerAccountId}-${until.toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\nWritten to ${outputPath}`);

  // A non-zero exit makes this usable as a scheduled check.
  process.exit(report.counts.discrepancies > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
