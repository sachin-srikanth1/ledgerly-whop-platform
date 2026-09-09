"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { toCents, toMajorUnits, decimalStringToCents } = require("../dist/money");

test("toCents converts major units to integer cents", () => {
  assert.equal(toCents(25), 2500);
  assert.equal(toCents(0.01), 1);
  assert.equal(toCents(99.99), 9999);
});

test("toCents absorbs float representation error", () => {
  // 12.34 * 100 is 1233.9999999999998 in IEEE-754.
  assert.equal(toCents(12.34), 1234);
  assert.equal(toCents(0.1 + 0.2), 30);
});

test("toCents rejects sub-cent precision rather than silently rounding", () => {
  assert.throws(() => toCents(10.999), RangeError);
  assert.throws(() => toCents(Number.NaN), RangeError);
  assert.throws(() => toCents(Number.POSITIVE_INFINITY), RangeError);
});

test("toMajorUnits round-trips", () => {
  for (const amount of [0.01, 1, 25, 99.99, 1234.56]) {
    assert.equal(toMajorUnits(toCents(amount)), amount);
  }
});

test("decimalStringToCents parses Whop's exact decimal strings", () => {
  assert.equal(decimalStringToCents("10.00"), 1000);
  assert.equal(decimalStringToCents("0.07"), 7);
  assert.equal(decimalStringToCents("25"), 2500);
  assert.equal(decimalStringToCents("-4.5"), -450);
});

test("decimalStringToCents does not route through a float", () => {
  // Number("0.1") * 100 is 10.000000000000002; the string parse is exact.
  assert.equal(decimalStringToCents("0.1"), 10);
  assert.equal(decimalStringToCents("0.29"), 29);
});

test("decimalStringToCents rejects malformed and over-precise amounts", () => {
  assert.throws(() => decimalStringToCents("abc"), RangeError);
  assert.throws(() => decimalStringToCents(""), RangeError);
  assert.throws(() => decimalStringToCents("1.234", 2), RangeError);
});
