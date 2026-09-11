# Ledgerly Platform SDK

Connected-accounts plumbing for a Whop platform, in TypeScript. Fork it, point it
at your own store, and it does four things:

- **Idempotent onboarding**: create-or-fetch a seller's connected account from
  your own seller id, plus a hosted KYC link.
- **Checkout with an 8% application fee**: computed in integer cents, validated
  exactly, applied by Whop at charge time.
- **A webhook consumer**: verifies Standard Webhooks signatures, deduplicates on
  the message id across restarts, and routes each event to the seller it belongs to.
- **A reconciliation job**: diffs one seller's Whop payments and transfers against
  your ledger and reports what disagrees.

Requires Node 20+ and a Whop platform API key. The platforms API is invite-only, so
contact Whop if you don't have access yet.

```bash
npm install
npm test
```

## Money flows

Whop supports two ways for a platform to take its cut. They differ in who holds
the money and when, which changes what you reconcile and what you owe a seller
if something goes wrong.

### Direct charge: the buyer pays the seller

The charge is created on the seller's connected account. Whop routes Ledgerly's
`application_fee_amount` to the platform and the rest to the seller, who bears
Whop's processing fees, refunds and disputes out of their share.

```mermaid
sequenceDiagram
    autonumber
    actor Buyer
    participant Checkout as Whop Checkout
    participant Ledgerly
    participant Whop as Whop Ledger
    participant Seller as Seller account (biz_)

    Ledgerly->>Checkout: create checkout configuration<br/>account_id = seller, application_fee_amount = 8%
    Checkout-->>Ledgerly: checkout URL
    Buyer->>Checkout: pay $25.00
    Checkout->>Whop: charge on the seller's account

    Note over Whop: Whop splits the $25.00
    Whop->>Ledgerly: $2.00 application fee
    Whop->>Seller: remainder, less Whop's processing fees

    Whop--)Ledgerly: payment.succeeded (account_id = seller)
    Ledgerly->>Ledgerly: credit the seller's ledger
    Checkout-->>Buyer: redirect to thank-you page
```

Ledgerly's $2.00 is fixed and knowable up front. **The seller's net is not.** It
depends on Whop's fee schedule for that account, the buyer's card, and any
currency conversion. Read it from `payments.listFees` once the payment exists
rather than estimating it.

### Transfer: the buyer pays Ledgerly

Ledgerly takes the whole charge and moves the seller's 92% afterwards. Useful
when the split isn't known at checkout time, or when the seller can't be charged
on directly.

```mermaid
sequenceDiagram
    autonumber
    actor Buyer
    participant Checkout as Whop Checkout
    participant Platform as Ledgerly account (biz_)
    participant Ledgerly
    participant Seller as Seller account (biz_)

    Buyer->>Checkout: pay $25.00
    Checkout->>Platform: charge on Ledgerly's own account
    Checkout--)Ledgerly: payment.succeeded

    Note over Platform: Balance is pending until settlement.<br/>A transfer cannot draw on it yet.
    Platform--)Ledgerly: ledger_account.funds_available

    Ledgerly->>Ledgerly: split $25.00 → seller $23.00, fee $2.00
    Ledgerly->>Seller: transfers.create<br/>idempotence_key = payout:pay_abc123
    Seller--)Ledgerly: transfer.completed
    Ledgerly->>Ledgerly: record the payout against the payment
```

The pending-balance step is the one that bites. `transfers.create` draws on the
platform's *available* balance and fails when the amount exceeds it, so calling
it inline on `payment.succeeded` fails for a charge that hasn't settled. Drive it
from `ledger_account.funds_available` or a scheduled sweep. (Some platform
accounts may transfer pending balance to their children;
`can_transfer_pending_balance_to_children` on the account says whether yours can.)

**Refunds.** Whop's docs split responsibility by flow: on a direct charge the
connected account bears refunds and disputes, and on a transfer the platform
does. They do not say what happens to the application fee, and the refund call
(`payments.refund`) has no option for it: it takes a payment id and an optional
partial amount, nothing else. So Ledgerly cannot choose per refund whether Whop
reverses its 8%. What it can choose is policy: if Ledgerly gives its fee back on
a refund, do it explicitly with a transfer to the seller from the
`refund.created` handler, keyed on the refund id so a redelivered webhook cannot
pay it twice. Check a refunded sandbox payment's fee lines
(`payments.listFees`) to see Whop's default before deciding.

## Usage

### Onboarding

```typescript
import { onboardSeller, FileStore } from "ledgerly-whop-platform";

const store = new FileStore("./seller-accounts.json"); // your database in production

// External id, email and country are all a seller needs.
const seller = await onboardSeller(
  client,
  { externalId: "seller_us_001", email: "seller@example.com", country: "US" },
  { store, returnUrl, refreshUrl } // set the URLs once for the platform
);

seller.accountId;     // biz_xxx, the same one on every call for this externalId
seller.created;       // false once the account exists
seller.onboardingUrl; // fresh every call: these links expire
```

Whop has no "find account by metadata" endpoint, so the `externalId → account id`
map in your store is what makes this idempotent: there is no server-side unique
key to lean on.

On a store miss, onboarding makes one `accounts.list` call filtered by title
before creating. That finds any account this SDK created, because it titles
accounts with their external id, and it costs the same whether the platform has
ten sellers or ten thousand.

It does not find accounts someone titled by hand. Whop's free-text `query` filter
matches `title` **only**, never metadata. Verified against a live platform:
`query: "seller_us_001"` returns zero matches for the account carrying exactly
that `metadata.external_id` under the title "Ledgerly US Seller". For those, and
whenever a store is lost, migrated or newly adopted, run `rebuildStore` once:

```typescript
import { rebuildStore } from "ledgerly-whop-platform";

await rebuildStore(client, store); // { scanned, mapped, skipped }
```

It pages through every connected account a single time and writes both
directions of the mapping, so onboarding finds existing sellers and webhooks
route to them. Recovery is kept out of the onboarding call on purpose: scanning
every account per onboarding would cost one API call per 50 sellers each time a
new seller signed up.

The one race this cannot close on its own: two concurrent calls for the same
unmapped `externalId` both find nothing and both create. Back `KeyValueStore`
with a table whose key column is `UNIQUE` and reserve the key before calling, and
the database closes it. A file cannot express that constraint.

### Checkout

```typescript
import { createCheckout } from "ledgerly-whop-platform";

const checkout = await createCheckout(client, {
  sellerAccountId: seller.accountId,
  productTitle: "Premium Course",
  price: 25.0,
  currency: "usd",
  redirectUrl: "https://ledgerly.example.com/thanks",
});

checkout.applicationFee; // 2, exactly 8% to the cent
```

Fees are computed in integer cents and converted back only at the API boundary,
because `100.1 * 0.08` is `8.008000000000001` and a fee that fails an equality
check against itself is a support ticket. `validateApplicationFee` is exact, with no
tolerance, since a fee a cent off is a fee something else computed.

A price small enough that 8% rounds to zero throws: Whop requires a positive
`application_fee_amount`, so a $0.05 sale cannot carry this fee at all.

### Webhooks

```typescript
import { WebhookConsumer, FileStore, WebhookVerificationError } from "ledgerly-whop-platform";

const consumer = new WebhookConsumer({
  secret: process.env.WHOP_WEBHOOK_SECRET!, // verbatim, `ws_` prefix included
  store: new FileStore("./seller-accounts.json"),
});

consumer.on("payment.succeeded", async ({ event, sellerAccountId, externalId }) => {
  // externalId is your seller id, resolved through the same store onboarding wrote.
});

// Next.js route handler (or Remix, Bun, Workers): pass request.headers as is.
export async function POST(request: Request) {
  const result = await consumer.handle(await request.text(), request.headers);
  return Response.json(result);
}
```

`handle` takes the raw body, never a re-serialized one: the signature covers the
exact bytes Whop sent. It accepts headers in either shape a server hands you, a
fetch `Headers` object or Node's plain object. That matters more than it sounds.
`standardwebhooks` reads headers with `Object.keys()`, which returns nothing for a
`Headers` object, so passing one straight to the library rejects every real
delivery with "Missing required headers". `examples/webhook-server.js` shows the
Node `http` version.

Verification goes through the SDK's own `unwrapWebhook`, which handles a detail
that is easy to get wrong by hand: Whop HMACs with the literal bytes of the `ws_`
secret, while the `standardwebhooks` library base64-decodes whatever key it is
given, so the secret has to be base64-encoded first to cancel that out. Pass the
secret exactly as Whop displays it and the helper does the rest.

**Answer 400 on `WebhookVerificationError`**: a bad signature never becomes good,
so there is nothing to retry. **Answer 5xx when a handler throws**, so Whop
redelivers.

Delivery is at-least-once. A message id is recorded only after its handler
resolves, so a crash mid-handler means the retry runs it again. That is the safe
direction to fail, but it does mean **your handlers must be idempotent too**. Key
your writes on `event.id` or on the payment id inside `event.data`.

Register the webhook with `child_resource_events` enabled, or the platform only
receives its own events and never its sellers'.

### Reconciliation

```typescript
import { reconcileSeller, formatReport } from "ledgerly-whop-platform";

const report = await reconcileSeller(client, {
  sellerAccountId: "biz_xxx",
  localLedger: rows, // [{ id, kind, amount, currency, status }]
  since,
  until,
  normalizeStatus: (status) => statusMap[status] ?? status,
});

report.discrepancies; // missing_in_ledger | missing_in_whop | amount_mismatch |
                      // currency_mismatch | status_mismatch
```

Two things worth knowing:

**It throws on API errors, deliberately.** Catching them and returning an empty
result set makes every local row look `missing_in_whop`, and an empty ledger
against a failed fetch reports a clean reconciliation. An outage you can see beats
a green report that means nothing.

**Reconcile closed windows.** A record created while the job runs can land on one
side of the diff and not the other. `until` should be in the past.

Payment amounts arrive as exact decimal strings and are parsed straight to cents;
`Number("0.1") * 100` is `10.000000000000002`, which is the error the string
representation exists to avoid.

## Why it is built this way

[DECISIONS.md](DECISIONS.md) covers the six choices that were not obvious:
where onboarding idempotency actually lives, why the 8% fee needed a negative
test, why reconciliation throws instead of returning empty, why a webhook is
recorded only after its handler succeeds, why money is integer cents, and why
the file store is a development default rather than the design.

## Layout

```
src/
  money.ts              integer-cent arithmetic and exact decimal parsing
  store.ts              KeyValueStore interface, file and memory implementations
  onboarding.ts         create-or-fetch a connected account + onboarding link
  checkout.ts           8% fee calculation and checkout creation
  webhook-consumer.ts   signature verification, deduplication, seller routing
  reconciliation.ts     Whop vs. local ledger diff
  transfers.ts          the transfer flow's 92/8 split
tests/                  node:test; signatures are really signed and verified
examples/               runnable scripts for each flow
```

`FileStore` is the default because it makes the examples runnable with no
infrastructure. It is single-process only (two processes rewriting the same file
clobber each other) and rewrites the whole file per key. Implement
`KeyValueStore` against your own database before production; both idempotency
guarantees then rest on your database's constraints rather than a local file's.

## Configuration

Copy `.env.example` to `.env`. The platform API key needs `company:create`,
`company:read`, `checkout:create`, `payment:read`, `transfer:create`,
`transfer:read` and `account_link:create`.

## Testing

```bash
npm test
```

53 tests, no network. Webhook signatures are genuinely signed with
`standardwebhooks` and verified through the real path, so the suite fails if the
secret encoding, header names or timestamp tolerance drift. Whop API calls run
against stubs that mirror the shapes in `@whop/sdk`'s types.

### Verified against a live sandbox

Every call this SDK makes has been run against a real Whop platform account, not
just against the SDK's types. What that run established:

| Call | Result |
|---|---|
| `accounts.retrieve` / `list` (incl. `query`, cursor `first`) | accepted |
| `accountLinks.create` | accepted, real hosted KYC link returned |
| `checkoutConfigurations.create` with `application_fee_amount` | accepted |
| `payments.list` (`account_id`, `created_after`/`_before`) | accepted |
| `transfers.list` (`destination_id`) | accepted |
| `onboardSeller` idempotency, incl. recovery from an empty store | same account, no duplicate |
| Reconciliation against a real payment | clean match, and correct diffs when perturbed |

**The 8% fee is really applied.** `application_fee_amount` is not echoed back by
`checkoutConfigurations.retrieve`, so acceptance alone proves nothing. Sending a
fee larger than the price settles it. Whop rejects it specifically:

> `Application fee amount must be less than the total payment amount ($25.00)`

Whop reads and validates the field. It is stored, merely not returned. That
constraint is also enforced client-side, so the error surfaces before the round
trip.

Two API limits found this way and now guarded in code rather than discovered in
production: a plan `title` is capped at **30 characters** (Whop reports it as
"Failed to create dynamic plan", which does not name the field), and
`transfers.list` **400s** without `origin_id` or `destination_id`.

Not verified: `accounts.create` (needs a real, deliverable email address; Whop
rejects `example.com`), `transfers.create` (needs a settled balance), and a
webhook delivered by Whop itself rather than signed locally. `rebuildStore` uses
only the `accounts.list` call verified above, but has not itself been run against
the sandbox.

What the suite does **not** cover: any real call to Whop. For that, put a key in
`.env` and run the read-only smoke test, which lists and retrieves but creates
nothing:

```bash
cp .env.example .env   # then add your key
npm run smoke          # optionally: npm run smoke -- biz_a_seller_account
```

It exercises every read path this SDK uses: `accounts.list` pagination, the
free-text `query` filter onboarding recovery depends on, and the `account_id` /
`destination_id` filters and date windows reconciliation sends. It reports
which shapes Whop accepted. The write paths (create account, checkout, transfer)
are still only covered by the examples.

## License

MIT. See [LICENSE](LICENSE).
