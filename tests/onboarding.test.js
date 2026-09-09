"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  onboardSeller,
  getOnboardingStatus,
  findAccountByExternalId,
} = require("../dist/onboarding");
const { FileStore, MemoryStore } = require("../dist/store");

const INPUT = {
  externalId: "seller_us_001",
  email: "seller@example.com",
  country: "US",
  returnUrl: "https://ledgerly.example.com/onboarding/complete",
  refreshUrl: "https://ledgerly.example.com/onboarding/refresh",
};

/** A Whop stub that records calls and hands back plausible accounts. */
function stubClient({ existing = [] } = {}) {
  const calls = { create: 0, list: 0, retrieve: 0, link: 0 };
  const accounts = new Map(existing.map((account) => [account.id, account]));
  let nextId = 1;

  return {
    calls,
    accounts,
    client: {
      accounts: {
        create: async (request) => {
          calls.create += 1;
          const account = {
            id: `biz_generated_${nextId++}`,
            email: request.email,
            country: request.country,
            title: request.title,
            metadata: request.metadata,
            status: "active",
          };
          accounts.set(account.id, account);
          return account;
        },
        // Whop's `query` filter matches `title` only — never metadata. The
        // stub mirrors that, so a test cannot pass on behaviour the API
        // does not have.
        list: async (request) => {
          calls.list += 1;
          return [...accounts.values()].filter(
            (account) => !request.query || account.title === request.query
          );
        },
        retrieve: async ({ id }) => {
          calls.retrieve += 1;
          const account = accounts.get(id);
          if (!account) {
            throw Object.assign(new Error("Not found"), { statusCode: 404 });
          }
          return account;
        },
      },
      accountLinks: {
        create: async (request) => {
          calls.link += 1;
          return { url: `https://whop.com/onboarding/${request.account_id}` };
        },
      },
    },
  };
}

const tempStorePath = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledgerly-")), "sellers.json");

test("a first call creates the account and returns a link", async () => {
  const { client, calls } = stubClient();

  const result = await onboardSeller(client, INPUT, { store: new MemoryStore() });

  assert.equal(result.created, true);
  assert.equal(result.externalId, "seller_us_001");
  assert.match(result.accountId, /^biz_/);
  assert.match(result.onboardingUrl, /^https:\/\/whop\.com\/onboarding\//);
  assert.equal(calls.create, 1);
});

test("calling again returns the same account and creates nothing", async () => {
  const { client, calls } = stubClient();
  const store = new MemoryStore();

  const first = await onboardSeller(client, INPUT, { store });
  const second = await onboardSeller(client, INPUT, { store });

  assert.equal(second.created, false);
  assert.equal(second.accountId, first.accountId);
  assert.equal(calls.create, 1, "a second account must never be created");
});

test("a fresh onboarding link is minted every call, since links expire", async () => {
  const { client, calls } = stubClient();
  const store = new MemoryStore();

  await onboardSeller(client, INPUT, { store });
  await onboardSeller(client, INPUT, { store });

  assert.equal(calls.link, 2);
});

test("idempotency survives a restart", async () => {
  const { client, calls } = stubClient();
  const storePath = tempStorePath();

  const first = await onboardSeller(client, INPUT, { store: new FileStore(storePath) });
  // New store instance over the same file: a process restart.
  const second = await onboardSeller(client, INPUT, { store: new FileStore(storePath) });

  assert.equal(second.accountId, first.accountId);
  assert.equal(calls.create, 1);
});

test("a lost store recovers the account from Whop instead of duplicating it", async () => {
  const { client, calls } = stubClient();

  const first = await onboardSeller(client, INPUT, { store: new MemoryStore() });
  // The store is gone entirely — a rebuilt machine, a dropped table.
  const second = await onboardSeller(client, INPUT, { store: new MemoryStore() });

  assert.equal(second.accountId, first.accountId);
  assert.equal(second.created, false);
  assert.equal(calls.create, 1);
});

test("recovery can be turned off", async () => {
  const { client, calls } = stubClient();

  await onboardSeller(client, INPUT, { store: new MemoryStore() });
  await onboardSeller(client, INPUT, {
    store: new MemoryStore(),
    recoverFromWhop: false,
  });

  assert.equal(calls.create, 2, "without recovery, a lost store does duplicate");
});

test("a store pointing at an account Whop lost is an error, not a silent re-create", async () => {
  const { client } = stubClient();
  const store = new MemoryStore();
  await store.set("seller:seller_us_001", "biz_vanished");

  await assert.rejects(
    () => onboardSeller(client, INPUT, { store }),
    /does not return that account/
  );
});

test("required inputs are checked", async () => {
  const { client } = stubClient();
  const store = new MemoryStore();

  for (const field of ["externalId", "email", "country", "returnUrl", "refreshUrl"]) {
    await assert.rejects(
      () => onboardSeller(client, { ...INPUT, [field]: "" }, { store }),
      new RegExp(`${field} is required`)
    );
  }
});

test("onboarding status reads verification and capabilities", async () => {
  const { client, accounts } = stubClient();
  accounts.set("biz_ready", {
    id: "biz_ready",
    status: "active",
    verification: { individual: { status: "approved" }, business: null },
    capabilities: { accept_card_payments: "active" },
    required_actions: [],
  });

  const status = await getOnboardingStatus(client, "biz_ready");

  assert.equal(status.individualVerification, "approved");
  assert.equal(status.businessVerification, "not_started");
  assert.equal(status.canAcceptPayments, true);
});

test("onboarding writes the reverse mapping the webhook consumer routes with", async () => {
  const { client } = stubClient();
  const store = new MemoryStore();

  const seller = await onboardSeller(client, INPUT, { store });

  assert.equal(await store.get(`account:${seller.accountId}`), "seller_us_001");
});

test("recovery finds an account whose title is not its external id", async () => {
  const { client, accounts, calls } = stubClient();

  // How a real connected account looks: a human title, the identity in
  // metadata. `query: "seller_us_001"` matches nothing here.
  accounts.set("biz_preexisting", {
    id: "biz_preexisting",
    email: "seller@example.com",
    country: "US",
    title: "Ledgerly US Seller",
    metadata: { external_id: "seller_us_001" },
    status: "active",
  });

  const result = await onboardSeller(client, INPUT, { store: new MemoryStore() });

  assert.equal(result.accountId, "biz_preexisting");
  assert.equal(result.created, false);
  assert.equal(calls.create, 0, "must not duplicate an account it failed to find");
});

test("a scan that hits its ceiling throws instead of duplicating", async () => {
  const { client, accounts } = stubClient();

  for (let i = 0; i < 10; i += 1) {
    accounts.set(`biz_other_${i}`, {
      id: `biz_other_${i}`,
      title: `Some Other Seller ${i}`,
      metadata: { external_id: `someone_else_${i}` },
    });
  }

  // Returning undefined here would read as "no such account" and create a
  // second one — the outcome recovery exists to prevent.
  await assert.rejects(
    () => findAccountByExternalId(client, "seller_us_001", 5),
    /without finding external id/
  );
});

test("a genuinely absent external id returns undefined, not an error", async () => {
  const { client, accounts } = stubClient();
  accounts.set("biz_other", { id: "biz_other", title: "Other", metadata: {} });

  assert.equal(await findAccountByExternalId(client, "never_onboarded"), undefined);
});
