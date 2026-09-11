"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { WebhookConsumer, WebhookVerificationError } = require("../dist/webhook-consumer");
const { FileStore, MemoryStore } = require("../dist/store");
const { signWebhook } = require("./helpers");

const SECRET = "ws_test_secret_do_not_use_in_production";

const eventBody = (overrides = {}) =>
  JSON.stringify({
    id: "msg_001",
    type: "payment.succeeded",
    account_id: "biz_seller_a",
    api_version: "v1",
    timestamp: new Date().toISOString(),
    data: { id: "pay_001", amount: "25.00" },
    ...overrides,
  });

const tempStorePath = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledgerly-")), "events.json");

test("a correctly signed webhook is accepted and routed", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  const seen = [];
  consumer.on("payment.succeeded", async (routed) => seen.push(routed));

  const payload = eventBody();
  const result = await consumer.handle(
    payload,
    signWebhook({ secret: SECRET, messageId: "msg_001", payload })
  );

  assert.equal(result.processed, true);
  assert.equal(result.eventType, "payment.succeeded");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event.data.id, "pay_001");
});

test("a tampered body is rejected", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  const payload = eventBody();
  const headers = signWebhook({ secret: SECRET, messageId: "msg_001", payload });

  const tampered = payload.replace('"25.00"', '"2500.00"');

  await assert.rejects(
    () => consumer.handle(tampered, headers),
    WebhookVerificationError
  );
});

test("an unsigned request is rejected, not processed", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  let handlerRan = false;
  consumer.on("payment.succeeded", async () => {
    handlerRan = true;
  });

  await assert.rejects(() => consumer.handle(eventBody(), {}));
  assert.equal(handlerRan, false, "handler must not see an unverified payload");
});

test("a signature from the wrong secret is rejected", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  const payload = eventBody();

  await assert.rejects(
    () =>
      consumer.handle(
        payload,
        signWebhook({ secret: "ws_a_different_secret", messageId: "msg_001", payload })
      ),
    WebhookVerificationError
  );
});

test("a stale timestamp is rejected", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  const payload = eventBody();
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);

  await assert.rejects(
    () =>
      consumer.handle(
        payload,
        signWebhook({ secret: SECRET, messageId: "msg_001", payload, timestamp: longAgo })
      ),
    WebhookVerificationError
  );
});

test("a redelivered message runs its handler exactly once", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  let calls = 0;
  consumer.on("payment.succeeded", async () => {
    calls += 1;
  });

  const payload = eventBody();
  const headers = signWebhook({ secret: SECRET, messageId: "msg_dup", payload });

  const first = await consumer.handle(payload, headers);
  const second = await consumer.handle(payload, headers);

  assert.equal(first.processed, true);
  assert.equal(second.processed, false, "second delivery must be suppressed");
  assert.equal(calls, 1);
});

test("idempotency survives a restart", async () => {
  const storePath = tempStorePath();
  const payload = eventBody();
  const headers = signWebhook({ secret: SECRET, messageId: "msg_restart", payload });

  let calls = 0;
  const handler = async () => {
    calls += 1;
  };

  const before = new WebhookConsumer({ secret: SECRET, store: new FileStore(storePath) });
  before.on("payment.succeeded", handler);
  await before.handle(payload, headers);

  // A brand-new consumer over a brand-new store reading the same file: what a
  // process restart actually looks like.
  const after = new WebhookConsumer({ secret: SECRET, store: new FileStore(storePath) });
  after.on("payment.succeeded", handler);
  const result = await after.handle(payload, headers);

  assert.equal(result.processed, false);
  assert.equal(calls, 1, "handler must not run again after a restart");
});

test("a failed handler leaves the message redeliverable", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  let attempts = 0;
  consumer.on("payment.succeeded", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("database is down");
  });

  const payload = eventBody();
  const headers = signWebhook({ secret: SECRET, messageId: "msg_retry", payload });

  await assert.rejects(() => consumer.handle(payload, headers), /database is down/);

  // Whop retries; this time the handler succeeds and the message is recorded.
  const retry = await consumer.handle(payload, headers);
  assert.equal(retry.processed, true);
  assert.equal(attempts, 2);
});

test("events route to the seller the account maps to", async () => {
  const store = new MemoryStore();
  const consumer = new WebhookConsumer({ secret: SECRET, store });
  await consumer.registerSeller("biz_seller_a", "seller_us_001");

  const routed = [];
  consumer.onAny(async (event) => routed.push(event));

  const payload = eventBody();
  await consumer.handle(
    payload,
    signWebhook({ secret: SECRET, messageId: "msg_route", payload })
  );

  assert.equal(routed[0].sellerAccountId, "biz_seller_a");
  assert.equal(routed[0].externalId, "seller_us_001");
});

test("older deliveries carrying company_id still route", async () => {
  const store = new MemoryStore();
  const consumer = new WebhookConsumer({ secret: SECRET, store });
  await consumer.registerSeller("biz_legacy", "seller_br_002");

  const routed = [];
  consumer.onAny(async (event) => routed.push(event));

  const payload = eventBody({ account_id: undefined, company_id: "biz_legacy" });
  await consumer.handle(
    payload,
    signWebhook({ secret: SECRET, messageId: "msg_legacy", payload })
  );

  assert.equal(routed[0].sellerAccountId, "biz_legacy");
  assert.equal(routed[0].externalId, "seller_br_002");
});

test("an event for an unknown account routes with a null seller, not a crash", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  const routed = [];
  consumer.onAny(async (event) => routed.push(event));

  const payload = eventBody({ account_id: "biz_never_seen" });
  const result = await consumer.handle(
    payload,
    signWebhook({ secret: SECRET, messageId: "msg_unknown", payload })
  );

  assert.equal(result.processed, true);
  assert.equal(routed[0].sellerAccountId, "biz_never_seen");
  assert.equal(routed[0].externalId, null);
});

test("an event with no registered handler is reported as unhandled", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });

  const payload = eventBody({ type: "dispute.created" });
  const result = await consumer.handle(
    payload,
    signWebhook({ secret: SECRET, messageId: "msg_unhandled", payload })
  );

  assert.equal(result.processed, true);
  assert.equal(result.unhandled, true);
});

test("a consumer cannot be built without a secret", () => {
  assert.throws(() => new WebhookConsumer({ secret: "", store: new MemoryStore() }));
});

test("a fetch Headers object verifies (Next.js, Remix, Bun, Workers)", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  const payload = eventBody();
  const signed = signWebhook({ secret: SECRET, messageId: "msg_fetch", payload });

  // What `request.headers` is in any fetch-style route handler. Object.keys()
  // on it returns [], which is what used to make every delivery fail.
  const headers = new Headers(signed);
  assert.deepEqual(Object.keys(headers), [], "precondition: entries are not own properties");

  const result = await consumer.handle(payload, headers);
  assert.equal(result.processed, true);
});

test("Node-style headers verify regardless of case", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  const payload = eventBody();
  const signed = signWebhook({ secret: SECRET, messageId: "msg_case", payload });

  const shouting = Object.fromEntries(
    Object.entries(signed).map(([key, value]) => [key.toUpperCase(), value])
  );

  const result = await consumer.handle(payload, { ...shouting, host: "example.com" });
  assert.equal(result.processed, true);
});

test("a fetch Headers delivery is still deduplicated on its webhook-id", async () => {
  const consumer = new WebhookConsumer({ secret: SECRET, store: new MemoryStore() });
  const payload = eventBody();
  const signed = signWebhook({ secret: SECRET, messageId: "msg_fetch_dup", payload });

  await consumer.handle(payload, new Headers(signed));
  const second = await consumer.handle(payload, new Headers(signed));

  assert.equal(second.processed, false);
});
