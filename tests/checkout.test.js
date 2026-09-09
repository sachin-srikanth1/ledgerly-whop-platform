"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateApplicationFee,
  validateApplicationFee,
  getFeeBreakdown,
} = require("../dist/checkout");
const { splitSellerShare } = require("../dist/transfers");

test("fee is exactly 8%", () => {
  assert.equal(calculateApplicationFee(100), 8);
  assert.equal(calculateApplicationFee(25), 2);
  assert.equal(calculateApplicationFee(12.5), 1);
});

test("fee rounds half-up to a whole cent", () => {
  // 99.99 * 0.08 = 7.9992 -> 8.00
  assert.equal(calculateApplicationFee(99.99), 8);
  // 0.94 * 0.08 = 0.0752 -> 0.08
  assert.equal(calculateApplicationFee(0.94), 0.08);
  // 0.31 * 0.08 = 0.0248 -> 0.02
  assert.equal(calculateApplicationFee(0.31), 0.02);
});

test("fee is never zero, negative, or the whole price", () => {
  // 8% of $0.05 rounds to nothing, and Whop rejects a zero application fee.
  assert.throws(() => calculateApplicationFee(0.05), RangeError);
  assert.throws(() => calculateApplicationFee(0), RangeError);
  assert.throws(() => calculateApplicationFee(-100), RangeError);
});

test("validateApplicationFee is exact to the cent", () => {
  assert.doesNotThrow(() => validateApplicationFee(100, 8));
  // A cent off is a fee some other code computed. That is the thing to catch.
  assert.throws(() => validateApplicationFee(100, 8.01), RangeError);
  assert.throws(() => validateApplicationFee(100, 7.99), RangeError);
  assert.throws(() => validateApplicationFee(100, 10), RangeError);
});

test("fee breakdown reports only what Ledgerly controls", () => {
  const breakdown = getFeeBreakdown(100, "usd");

  assert.equal(breakdown.price, "USD 100.00");
  assert.equal(breakdown.ledgerlyFee, "USD 8.00");
  assert.equal(breakdown.ledgerlyFeePercentage, "8%");
  assert.equal(breakdown.sellerGross, "USD 92.00");
});

test("transfer split always sums back to the gross", () => {
  for (const gross of [25, 100, 99.99, 0.31, 12.34, 1234.56]) {
    const { sellerAmount, platformFee } = splitSellerShare(gross);
    assert.equal(
      Math.round((sellerAmount + platformFee) * 100),
      Math.round(gross * 100),
      `split of ${gross} lost or created a cent`
    );
  }
});

test("transfer split keeps 8% and gives the seller the remainder", () => {
  assert.deepEqual(splitSellerShare(25), { sellerAmount: 23, platformFee: 2 });
  // 8% of 0.31 is 0.0248 -> 0.02, seller gets the other 0.29.
  assert.deepEqual(splitSellerShare(0.31), { sellerAmount: 0.29, platformFee: 0.02 });
});

test("a product title over Whop's 30-character cap is rejected before the round trip", async () => {
  const { createCheckout, MAX_PRODUCT_TITLE_LENGTH } = require("../dist");

  assert.equal(MAX_PRODUCT_TITLE_LENGTH, 30);

  // Whop reports this as "Failed to create dynamic plan", which does not name
  // the offending field. Fail here instead, naming it.
  await assert.rejects(
    () =>
      createCheckout({}, {
        sellerAccountId: "biz_x",
        productTitle: "Ledgerly Verification — Premium Course",
        price: 25,
        currency: "usd",
        redirectUrl: "https://example.com/thanks",
      }),
    /Whop caps a plan title at 30/
  );
});

test("createCheckout validates the fee before sending it to Whop", async () => {
  const { createCheckout } = require("../dist");
  const sent = [];
  const client = {
    checkoutConfigurations: {
      create: async (request) => {
        sent.push(request);
        return { id: "ch_test", purchase_url: "https://whop.com/checkout/ch_test" };
      },
    },
  };

  await createCheckout(client, {
    sellerAccountId: "biz_x",
    productTitle: "Course",
    price: 25,
    currency: "usd",
    redirectUrl: "https://example.com/thanks",
  });

  // The value that actually leaves for Whop is the validated 8%.
  assert.equal(sent[0].plan.application_fee_amount, 2);
  assert.equal(sent[0].plan.initial_price, 25);
  assert.equal(sent[0].account_id, "biz_x");
});
