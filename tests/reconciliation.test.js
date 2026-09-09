"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { reconcileSeller, formatReport } = require("../dist/reconciliation");
const { fakeClient, money } = require("./helpers");

const payment = (id, amount, status = "paid") => ({
  id,
  total: money(amount),
  currency: "usd",
  status,
});

const transfer = (id, amount, status = "succeeded") => ({
  id,
  amount,
  currency: "usd",
  status,
});

const local = (id, kind, amount, status) => ({ id, kind, amount, currency: "usd", status });

test("a matching ledger reconciles clean", async () => {
  const client = fakeClient({
    payments: [payment("pay_1", "25.00")],
    transfers: [transfer("tran_1", 23)],
  });

  const report = await reconcileSeller(client, {
    sellerAccountId: "biz_a",
    localLedger: [
      local("pay_1", "payment", 25, "paid"),
      local("tran_1", "transfer", 23, "succeeded"),
    ],
  });

  assert.equal(report.counts.discrepancies, 0);
  assert.match(formatReport(report), /In sync/);
});

test("detects a payment Whop has and the ledger does not", async () => {
  const client = fakeClient({ payments: [payment("pay_missing", "25.00")] });

  const report = await reconcileSeller(client, {
    sellerAccountId: "biz_a",
    localLedger: [],
  });

  assert.equal(report.counts.discrepancies, 1);
  assert.equal(report.discrepancies[0].type, "missing_in_ledger");
  assert.equal(report.discrepancies[0].recordId, "pay_missing");
});

test("detects a ledger row Whop does not have", async () => {
  const client = fakeClient({ payments: [] });

  const report = await reconcileSeller(client, {
    sellerAccountId: "biz_a",
    localLedger: [local("pay_ghost", "payment", 25, "paid")],
  });

  assert.equal(report.discrepancies[0].type, "missing_in_whop");
});

test("detects a one-cent amount mismatch", async () => {
  const client = fakeClient({ payments: [payment("pay_1", "25.00")] });

  const report = await reconcileSeller(client, {
    sellerAccountId: "biz_a",
    localLedger: [local("pay_1", "payment", 25.01, "paid")],
  });

  assert.equal(report.discrepancies[0].type, "amount_mismatch");
  assert.match(report.discrepancies[0].detail, /USD 25\.00.*USD 25\.01/);
});

test("reports a currency mismatch instead of comparing amounts across currencies", async () => {
  const client = fakeClient({ payments: [payment("pay_1", "25.00")] });

  const report = await reconcileSeller(client, {
    sellerAccountId: "biz_a",
    localLedger: [{ id: "pay_1", kind: "payment", amount: 25, currency: "eur", status: "paid" }],
  });

  const types = report.discrepancies.map((d) => d.type);
  assert.deepEqual(types, ["currency_mismatch"]);
});

test("detects a status mismatch", async () => {
  const client = fakeClient({ payments: [payment("pay_1", "25.00", "refunded")] });

  const report = await reconcileSeller(client, {
    sellerAccountId: "biz_a",
    localLedger: [local("pay_1", "payment", 25, "paid")],
  });

  assert.equal(report.discrepancies[0].type, "status_mismatch");
});

test("normalizeStatus maps Whop's vocabulary onto the ledger's", async () => {
  const client = fakeClient({ payments: [payment("pay_1", "25.00", "paid")] });

  const report = await reconcileSeller(client, {
    sellerAccountId: "biz_a",
    localLedger: [local("pay_1", "payment", 25, "COMPLETE")],
    normalizeStatus: (status) => (["paid", "complete"].includes(status.toLowerCase()) ? "settled" : status.toLowerCase()),
  });

  assert.equal(report.counts.discrepancies, 0);
});

test("an API failure propagates instead of reporting a clean reconciliation", async () => {
  const client = {
    payments: {
      list: async () => {
        throw new Error("503 Service Unavailable");
      },
    },
    transfers: { list: async () => [] },
  };

  // The dangerous alternative: swallowing this and reporting zero
  // discrepancies against an empty ledger, i.e. "everything is fine".
  await assert.rejects(
    () => reconcileSeller(client, { sellerAccountId: "biz_a", localLedger: [] }),
    /503 Service Unavailable/
  );
});

test("the date window is pushed to the API, not filtered after the fact", async () => {
  const requests = [];
  const client = fakeClient({ onList: (resource, request) => requests.push([resource, request]) });

  const since = new Date("2026-08-01T00:00:00.000Z");
  const until = new Date("2026-09-01T00:00:00.000Z");

  await reconcileSeller(client, { sellerAccountId: "biz_a", localLedger: [], since, until });

  const [, paymentsRequest] = requests.find(([resource]) => resource === "payments");
  assert.equal(paymentsRequest.account_id, "biz_a");
  assert.equal(paymentsRequest.created_after, since.toISOString());
  assert.equal(paymentsRequest.created_before, until.toISOString());

  const [, transfersRequest] = requests.find(([resource]) => resource === "transfers");
  assert.equal(transfersRequest.destination_id, "biz_a");
  assert.equal(transfersRequest.created_after, since.toISOString());
});

test("payment amounts parse exactly, without a float round trip", async () => {
  const client = fakeClient({ payments: [payment("pay_1", "0.10")] });

  const report = await reconcileSeller(client, {
    sellerAccountId: "biz_a",
    localLedger: [local("pay_1", "payment", 0.1, "paid")],
  });

  assert.equal(report.counts.discrepancies, 0);
});
