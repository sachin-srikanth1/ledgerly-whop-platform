"use strict";

/**
 * Read-only smoke test against a real Whop account.
 *
 *   cp .env.example .env    # then put your key in it
 *   node --env-file=.env examples/smoke-test.js [biz_seller_account_id]
 *
 * This is the check the hermetic test suite cannot make: that Whop actually
 * accepts the request shapes this SDK sends. The unit tests verify our logic
 * against stubs built from @whop/sdk's types; only a real call proves the
 * parameter names, filters and pagination are right.
 *
 * It CREATES NOTHING. Every call below is a list or a retrieve, so it is safe
 * to run against production credentials, though sandbox is the better habit.
 */

const { platformClient } = require("./client");

const results = [];

/** Run one read-only call, recording whether Whop accepted it. */
async function check(description, detail, run) {
  process.stdout.write(`  ${description} ... `);

  try {
    const value = await run();
    console.log("ok");
    results.push({ description, ok: true });
    return value;
  } catch (error) {
    const status = error?.statusCode ? ` [HTTP ${error.statusCode}]` : "";
    console.log(`FAILED${status}`);
    console.log(`      ${error?.message ?? error}`);
    console.log(`      sends: ${detail}`);
    results.push({ description, ok: false, error });
    return undefined;
  }
}

/** Drain an async-iterable Page into an array, capped so this stays cheap. */
async function take(page, limit) {
  const items = [];
  for await (const item of page) {
    items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}

async function main() {
  const client = platformClient();
  const window = {
    since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    until: new Date(new Date().setUTCHours(0, 0, 0, 0)),
  };

  console.log("Authentication");
  const me = await check("accounts.retrieve({ id: 'me' })", "id: 'me'", () =>
    client.accounts.retrieve({ id: "me" })
  );

  if (me) {
    console.log(`      authenticated as ${me.id} (${me.title ?? "untitled"})`);
  }

  console.log("\nOnboarding read paths");
  const accountsPage = await check(
    "accounts.list({ first })",
    "first: 5 (cursor pagination, not `limit`)",
    () => client.accounts.list({ first: 5 })
  );

  let connectedAccounts = [];
  if (accountsPage) {
    connectedAccounts = await take(accountsPage, 5);
    console.log(`      returned ${connectedAccounts.length} account(s)`);
  }

  // The filter findAccountByExternalId relies on when a store is lost.
  await check(
    "accounts.list({ query, first })",
    "query: '<external id>' (free-text filter on title)",
    () => client.accounts.list({ query: "ledgerly-smoke-test-no-match", first: 5 })
  );

  const sellerAccountId = process.argv[2] ?? connectedAccounts[0]?.id;

  if (!sellerAccountId) {
    console.log("\nNo connected account to reconcile against.");
    console.log("Pass one explicitly to check the reconciliation read paths:");
    console.log("  node --env-file=.env examples/smoke-test.js biz_xxxxxxxx");
  } else {
    console.log(`\nReconciliation read paths (against ${sellerAccountId})`);

    const paymentsPage = await check(
      "payments.list({ account_id, created_after, created_before, first })",
      "account_id (not `company_id`); dates as ISO 8601",
      () =>
        client.payments.list({
          account_id: sellerAccountId,
          created_after: window.since.toISOString(),
          created_before: window.until.toISOString(),
          first: 5,
        })
    );

    if (paymentsPage) {
      const payments = await take(paymentsPage, 5);
      console.log(`      returned ${payments.length} payment(s) in the last 30 days`);

      // The shape reconciliation.ts parses: Money as an exact decimal string.
      const [payment] = payments;
      if (payment) {
        const money = payment.total ?? payment.amount_after_fees;
        console.log(
          `      first payment total: ${JSON.stringify(money)}; ` +
            `expects { amount: string, decimals: number }`
        );
      }
    }

    const transfersPage = await check(
      "transfers.list({ destination_id, created_after, first })",
      "destination_id (not `to_company_id`)",
      () =>
        client.transfers.list({
          destination_id: sellerAccountId,
          created_after: window.since.toISOString(),
          first: 5,
        })
    );

    if (transfersPage) {
      const transfers = await take(transfersPage, 5);
      console.log(`      returned ${transfers.length} transfer(s) in the last 30 days`);

      const [transfer] = transfers;
      if (transfer) {
        console.log(
          `      first transfer amount: ${JSON.stringify(transfer.amount)}; ` +
            `expects a plain number, unlike Payment's Money object`
        );
      }
    }
  }

  const failed = results.filter((result) => !result.ok);

  console.log(`\n${results.length - failed.length}/${results.length} calls accepted.`);

  if (failed.length > 0) {
    console.log("\nA rejected call means this SDK sends a shape Whop does not accept.");
    console.log("A 401/403 means the key lacks the scope, which is a different problem.");
    process.exit(1);
  }

  console.log("Every read path this SDK uses is accepted by Whop.");
  console.log("Not covered: the write paths (create account, checkout, transfer).");
}

main().catch((error) => {
  console.error("\nSmoke test could not run:", error?.message ?? error);
  process.exit(1);
});
