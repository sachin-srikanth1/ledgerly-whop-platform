import type { WhopClient } from "@whop/sdk";
import type { KeyValueStore } from "./store";

/** Metadata key holding the platform's own seller id on the connected account. */
export const EXTERNAL_ID_METADATA_KEY = "external_id";

export interface OnboardSellerInput {
  /** Ledgerly's own id for this seller. The idempotency key for onboarding. */
  externalId: string;
  email: string;
  /** ISO 3166-1 alpha-2, e.g. "US". */
  country: string;
  /** Display name for the account. Defaults to `externalId`. */
  title?: string;
  /** Where Whop returns the seller after they finish onboarding. */
  returnUrl: string;
  /** Where Whop sends the seller if the onboarding link expires. */
  refreshUrl: string;
}

export interface OnboardSellerResult {
  accountId: string;
  externalId: string;
  email: string | null;
  country: string | null;
  /** `active` or `suspended`. */
  status: string | null;
  /** False when an existing account was found for this `externalId`. */
  created: boolean;
  /**
   * A short-lived hosted KYC URL. Minted fresh on every call — including calls
   * that returned an existing account — because these links expire. Never cache
   * one; call again for a new one.
   */
  onboardingUrl: string;
}

export interface OnboardSellerOptions {
  /**
   * Durable `externalId` -> account id map. This, not the Whop API, is what
   * makes onboarding idempotent: Whop has no "find account by metadata"
   * endpoint, so the mapping has to live on our side.
   */
  store: KeyValueStore;
  /**
   * When the store has no mapping, scan the platform's connected accounts for
   * one already carrying this `externalId` before creating another. Defaults to
   * true. See {@link findAccountByExternalId} for the cost.
   */
  recoverFromWhop?: boolean;
}

const storeKey = (externalId: string) => `seller:${externalId}`;

/**
 * Reverse of {@link storeKey}: connected account -> Ledgerly seller id.
 *
 * Written alongside the forward mapping so a webhook arriving for an account
 * can name the seller it belongs to. `WebhookConsumer` reads this key, so a
 * consumer sharing this store routes correctly with no extra wiring.
 */
const reverseKey = (accountId: string) => `account:${accountId}`;

/**
 * Create or fetch a seller's connected account, and mint an onboarding link.
 *
 * Idempotent on `externalId`: calling it repeatedly yields the same connected
 * account, and a fresh onboarding link each time.
 *
 * ## How idempotency actually holds
 *
 * The durable `externalId` -> account id mapping in `options.store` is the
 * source of truth. Whop's `accounts.list` has no metadata filter, so there is
 * no server-side unique key we can lean on the way `transfers.create` lets us
 * lean on `idempotence_key`.
 *
 * That leaves one race this function cannot close on its own: two concurrent
 * calls for the same unmapped `externalId` will both find nothing and both
 * create an account. Whop will hold two accounts and the store will keep
 * whichever mapping landed second.
 *
 * To close it, back {@link KeyValueStore} with a table whose key column is
 * UNIQUE, and reserve the key before calling this function — let the loser of
 * the insert wait for the winner's account id rather than calling through. A
 * local file store cannot express that constraint.
 *
 * @param client Whop client authenticated with the *platform* API key.
 * @throws {Error} when the store maps `externalId` to an account Whop no longer
 * returns — a real inconsistency that silently creating a second account would
 * paper over.
 */
export async function onboardSeller(
  client: WhopClient,
  input: OnboardSellerInput,
  options: OnboardSellerOptions
): Promise<OnboardSellerResult> {
  const { externalId, email, country, title, returnUrl, refreshUrl } = input;
  const { store, recoverFromWhop = true } = options;

  if (!externalId) throw new Error("externalId is required");
  if (!email) throw new Error("email is required");
  if (!country) throw new Error("country is required");
  if (!returnUrl) throw new Error("returnUrl is required");
  if (!refreshUrl) throw new Error("refreshUrl is required");

  const mappedAccountId = await store.get(storeKey(externalId));

  let account: any;
  let created = false;

  if (mappedAccountId) {
    account = await retrieveAccount(client, mappedAccountId);

    if (!account) {
      throw new Error(
        `Store maps externalId "${externalId}" to account ${mappedAccountId}, ` +
          `but Whop does not return that account. Resolve this by hand — creating ` +
          `a replacement would strand any payments already made to it.`
      );
    }
  } else {
    if (recoverFromWhop) {
      account = await findAccountByExternalId(client, externalId);
    }

    if (!account) {
      account = await (client.accounts.create as any)({
        email,
        country,
        // Defaulting the title to externalId is deliberate: `accounts.list`
        // can free-text search `title`, so it gives findAccountByExternalId a
        // narrow server-side filter instead of a full scan.
        title: title || externalId,
        metadata: { [EXTERNAL_ID_METADATA_KEY]: externalId },
      });
      created = true;
    }

    // Persist before minting the link. A crash between the two costs a wasted
    // link; a crash before this write costs a duplicate account.
    await store.set(storeKey(externalId), account.id);
    await store.set(reverseKey(account.id), externalId);
  }

  const accountLink: any = await (client.accountLinks.create as any)({
    account_id: account.id,
    use_case: "account_onboarding",
    return_url: returnUrl,
    refresh_url: refreshUrl,
  });

  return {
    accountId: account.id,
    externalId,
    email: account.email ?? null,
    country: account.country ?? null,
    status: account.status ?? null,
    created,
    onboardingUrl: accountLink.url,
  };
}

/**
 * Default ceiling on the accounts {@link findAccountByExternalId} will scan.
 *
 * Recovery walks the platform's connected accounts 50 at a time. The cap keeps
 * a lost store on a large platform from turning one onboarding call into
 * thousands of API requests.
 */
export const DEFAULT_MAX_ACCOUNTS_SCANNED = 1000;

/**
 * Find a connected account previously created with this `externalId`.
 *
 * A recovery path for a lost or rebuilt store, not a hot path.
 *
 * Whop cannot filter accounts by metadata, and its free-text `query` filter
 * matches `title` **only** — passing an external id there returns nothing
 * unless the account happens to be titled with it. (Verified against a live
 * platform account: `query: "seller_us_001"` returns 0 matches for an account
 * carrying exactly that `metadata.external_id` under the title "Ledgerly US
 * Seller".) So `query` is a fast path, not the mechanism: when it misses, this
 * falls back to paging every connected account and matching on
 * `metadata.external_id`, the field that actually carries the identity.
 *
 * @param maxAccountsScanned Ceiling on the fallback scan. Defaults to
 * {@link DEFAULT_MAX_ACCOUNTS_SCANNED}.
 * @returns the account, or undefined when the platform has none carrying this
 * external id.
 * @throws {Error} when the scan hits `maxAccountsScanned` without a match.
 * Returning undefined there would be indistinguishable from "no such account",
 * and the caller would create a duplicate — the exact outcome recovery exists
 * to prevent.
 */
export async function findAccountByExternalId(
  client: WhopClient,
  externalId: string,
  maxAccountsScanned: number = DEFAULT_MAX_ACCOUNTS_SCANNED
): Promise<any | undefined> {
  const matches = (account: any) =>
    account?.metadata?.[EXTERNAL_ID_METADATA_KEY] === externalId;

  // Fast path: cheap when the account was created by this SDK, whose default
  // title is the external id.
  const titleMatches = await (client.accounts.list as any)({
    query: externalId,
    first: 50,
  });

  for await (const account of titleMatches) {
    if (matches(account)) return account;
  }

  // Fallback: the title did not carry the external id, so scan on metadata.
  // The SDK's Page is async-iterable and fetches further pages on demand.
  const allAccounts = await (client.accounts.list as any)({ first: 50 });

  let scanned = 0;

  for await (const account of allAccounts) {
    if (matches(account)) return account;

    if (++scanned >= maxAccountsScanned) {
      throw new Error(
        `Scanned ${scanned} connected accounts without finding external id ` +
          `"${externalId}". Raise maxAccountsScanned, or seed the store with ` +
          `the mapping directly — continuing would create a duplicate account.`
      );
    }
  }

  return undefined;
}

async function retrieveAccount(client: WhopClient, accountId: string): Promise<any | undefined> {
  try {
    return await (client.accounts.retrieve as any)({ id: accountId });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) {
      return undefined;
    }
    throw error;
  }
}

export interface OnboardingStatus {
  accountId: string;
  /** `active` or `suspended`. */
  status: string | null;
  /** `not_started`, `pending`, `manual_review`, `approved`, or `rejected`. */
  individualVerification: string;
  businessVerification: string;
  /** True once the account can actually accept card payments. */
  canAcceptPayments: boolean;
  /** Outstanding items blocking the account. Empty once onboarding completes. */
  requiredActions: unknown[];
}

/**
 * Read a connected account's KYC progress.
 *
 * `capabilities` and `verification` are only computed on `retrieve` (not on
 * `list`) and only for callers holding `company:balance:read` on the account —
 * without that scope Whop returns them as null and `canAcceptPayments` reads
 * false for a perfectly healthy account.
 */
export async function getOnboardingStatus(
  client: WhopClient,
  accountId: string
): Promise<OnboardingStatus> {
  const account: any = await (client.accounts.retrieve as any)({ id: accountId });

  return {
    accountId: account.id,
    status: account.status ?? null,
    individualVerification: account.verification?.individual?.status ?? "not_started",
    businessVerification: account.verification?.business?.status ?? "not_started",
    canAcceptPayments: account.capabilities?.accept_card_payments === "active",
    requiredActions: account.required_actions ?? [],
  };
}
