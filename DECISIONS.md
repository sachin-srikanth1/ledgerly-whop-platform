# Design decisions

Six choices in this repo that were not obvious, why they went the way they did,
and what the alternative would have cost. Several were settled by testing Whop's
sandbox rather than by reading its documentation, and those are marked.

---

## 1. Onboarding idempotency lives in our store, not in Whop

`onboardSeller` is idempotent on `externalId` because a durable
`externalId -> account id` map says so, not because Whop enforces anything.

**Why.** Whop has no "find account by metadata" endpoint. Its `accounts.list`
free-text `query` filter matches `title` and nothing else, so searching it for an
external id returns nothing for any account a human has named.

**Verified.** Against the live sandbox, `query: "seller_us_001"` returns zero
matches for the account whose `metadata.external_id` is exactly that string,
because its title is "Ledgerly US Seller". An earlier version of this code
treated `query` as a metadata search and would have created a duplicate
connected account for every seller whenever the store was lost.

**So lookup and recovery are separate.** On a store miss, onboarding makes one
`query` call before creating. Accounts this SDK creates are titled with their
external id, so that call finds them, and it costs the same at any platform size.
Recovering accounts titled by hand, or a lost store, is `rebuildStore`: one pass
over every connected account that writes all the mappings.

An earlier version did the full scan inside onboarding whenever the store missed.
A store miss is the normal case for a brand-new seller, so every signup paid one
API call per 50 existing sellers, and past a 1,000-account safety cap onboarding
a new seller threw outright. Recovery is a rare event and is now paid for once,
not on every signup.

**The limit, stated plainly.** Two concurrent calls for the same unmapped
`externalId` will both find nothing and both create. No amount of client-side
care closes that; it needs a `UNIQUE` key column and a reservation before the
call. `KeyValueStore` is an interface precisely so a database can provide it.

---

## 2. The 8% fee needed a negative test, because acceptance proves nothing

`checkoutConfigurations.create` accepts `application_fee_amount` and returns
success. That is not evidence the fee was applied.

**Why.** `checkoutConfigurations.retrieve` does not echo the field back. A fee
that was stored and a fee that was silently discarded produce identical
responses, so reading it back cannot tell them apart.

**Verified.** Sending `application_fee_amount: 30` on a `initial_price: 25` plan
is rejected with a fee-specific error:

> Application fee amount must be less than the total payment amount ($25.00)

Whop parses and validates the field, which means it receives it. That same rule
is now enforced client-side, so the error arrives before the round trip instead
of after it.

---

## 3. Reconciliation throws on API errors instead of returning empty

A failed fetch propagates out of `reconcileSeller`.

**Why.** The tempting alternative, `catch` and return `[]`, produces the worst
possible output. An empty Whop side makes every local row look
`missing_in_whop`, and an empty local ledger against a failed fetch reports zero
discrepancies, which reads as "everything reconciles". A reconciliation job that
reports success when it could not reach the API is worse than one that crashes,
because nobody investigates a green run.

**Consequence.** The caller must handle the throw and retry. That is the correct
place for the decision, since only the caller knows whether this is a scheduled
sweep that can retry in an hour or an on-demand check with someone waiting.

---

## 4. A webhook message is recorded as processed only after its handler succeeds

The write to the idempotency store happens after `await handler(...)`, not
before.

**Why.** The ordering picks which failure mode you get. Recording first gives
at-most-once: a crash mid-handler means the event is marked done and Whop's
retry is suppressed, so the payment silently never lands in the ledger.
Recording last gives at-least-once: the same crash leaves the message
unrecorded, and the retry runs the handler again.

For money, a duplicate you can detect beats a loss you cannot. So: at-least-once,
and **handlers must be idempotent themselves**, keyed on `event.id` or on the
payment id inside `event.data`. That obligation is documented on the class rather
than left implicit.

---

## 5. Money is integer cents everywhere except the API boundary

Fees are computed in cents. Amounts from Whop are parsed from decimal strings
without passing through a float.

**Why.** `100.1 * 0.08` is `8.008000000000001`. A fee computed that way fails an
equality check against the same fee computed elsewhere, which surfaces as a
support ticket rather than an exception. Whop sends money as
`{ amount: "25.00", decimals: 2 }`, an exact decimal string, specifically so
nothing rounds in transit; `Number("0.1") * 100` is `10.000000000000002` and
reintroduces exactly the error the string representation exists to avoid.

**Consequence.** `validateApplicationFee` is exact to the cent with no tolerance.
An earlier version allowed a one-cent slack, which would have accepted a fee
computed by something other than this code. That is the case worth catching.

**Consequence.** A price too small to carry a positive 8% fee is rejected rather
than rounded to zero, because Whop requires the fee to be positive. A $0.05 sale
cannot carry this fee at all, and failing loudly beats charging nothing.

---

## 6. The file-backed store is a development default, not the design

`FileStore` exists so the examples run with no infrastructure. `KeyValueStore` is
the actual contract.

**Why.** Both idempotency guarantees in this SDK, onboarding and webhooks, rest
on durable state. A JSON file provides that for one process. It does not provide
it for two: each holds the whole map in memory and rewrites all of it, so
concurrent writers clobber each other. It also rewrites the entire file on every
webhook, which is O(n) per event.

**What is genuinely handled.** Writes are atomic (write to a temp file, then
rename), so a crash mid-write leaves the previous snapshot rather than a
truncated file. A corrupt store refuses to load instead of starting empty, since
starting empty would silently re-process every webhook already handled.

**What to do in production.** Implement `KeyValueStore` against a table with a
unique constraint on the key. Both guarantees then follow the database's
durability, and decision 1's race closes as a side effect.

---

## Verified against a live sandbox

Every read path and two write paths were exercised against a real Whop platform
account. `accounts.create` and `transfers.create` remain unverified: the first
needs a deliverable email domain (Whop rejects `example.com`), the second a
settled balance. Two API limits were found this way and are now guarded in code:
a plan title caps at 30 characters, and `transfers.list` returns 400 without
`origin_id` or `destination_id`.
