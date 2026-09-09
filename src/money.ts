/**
 * Integer-cent money helpers.
 *
 * Whop's API takes and returns amounts as decimal numbers of major units
 * ("25.00" is twenty-five dollars). Arithmetic on those as IEEE-754 doubles
 * loses cents: `100.1 * 0.08` is `8.008000000000001`, and a fee computed that
 * way fails an exact equality check against the same fee recomputed elsewhere.
 *
 * Every calculation here happens in integer cents and converts back only at the
 * API boundary.
 */

/** Cents in one major unit. Whop's supported currencies are all 2-decimal. */
const MINOR_UNITS_PER_MAJOR = 100;

/**
 * Convert a major-unit amount (dollars) to integer cents.
 *
 * @throws {RangeError} when `amount` is not a finite number, or carries
 * fractions of a cent that would be silently discarded.
 */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`Amount must be a finite number, got ${amount}`);
  }

  const cents = amount * MINOR_UNITS_PER_MAJOR;
  const rounded = Math.round(cents);

  // Reject sub-cent precision rather than rounding it away: a caller passing
  // 10.999 almost certainly has a bug, and silently charging 11.00 hides it.
  // The 1e-6 slack absorbs float representation error (12.34 * 100 is
  // 1233.9999999999998), which is not the same thing as a real sub-cent amount.
  if (Math.abs(cents - rounded) > 1e-6) {
    throw new RangeError(
      `Amount ${amount} has sub-cent precision; amounts must be whole cents`
    );
  }

  return rounded;
}

/** Convert integer cents back to a major-unit amount for the API boundary. */
export function toMajorUnits(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`Cents must be an integer, got ${cents}`);
  }
  return cents / MINOR_UNITS_PER_MAJOR;
}

/** Format an amount for logs and reports. Display only — never for arithmetic. */
export function formatMoney(amount: number, currency: string): string {
  return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
}

/**
 * Parse an exact decimal string — the form Whop's `Money.amount` takes — into
 * integer cents, without routing it through a float.
 *
 * Whop sends money amounts as strings precisely so nothing rounds them in
 * transit; `Number("0.1") * 100` reintroduces exactly the error the string
 * avoided. This parses the digits directly.
 *
 * @param amount e.g. "10.00", "-4.5", "25".
 * @param decimals How many decimal places the amount carries, from
 * `Money.decimals`. Defaults to 2.
 * @throws {RangeError} when `amount` is not a decimal numeral, or carries more
 * precision than `decimals` allows.
 */
export function decimalStringToCents(amount: string, decimals: number = 2): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());

  if (!match) {
    throw new RangeError(`Not a decimal amount: ${JSON.stringify(amount)}`);
  }

  const sign = match[1] ?? "";
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";

  if (fraction.length > decimals) {
    throw new RangeError(
      `Amount ${amount} carries ${fraction.length} decimal places, more than the ${decimals} declared`
    );
  }

  const scale = 10 ** decimals;
  const padded = fraction.padEnd(decimals, "0");
  const magnitude = BigInt(whole) * BigInt(scale) + BigInt(padded || "0");
  const signed = sign === "-" ? -magnitude : magnitude;

  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Amount ${amount} exceeds safe integer range in minor units`);
  }

  return Number(signed);
}
