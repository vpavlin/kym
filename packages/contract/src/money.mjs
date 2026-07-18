// KYM money — integer milliunits (currency × 1000). $10.50 === 10500.
// Outflows are negative, inflows positive. Money NEVER touches floating point
// in storage, transport, or arithmetic. These helpers exist only at the UI edge.

/** @typedef {number} Money integer milliunits */

const MILLI = 1000;

/** Parse a human amount (e.g. "10.50", 10.5) to integer milliunits. UI-edge only. */
export function toMilli(amount) {
  if (typeof amount === "number") return Math.round(amount * MILLI);
  const s = String(amount).trim().replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === ".") return 0;
  // Split on the decimal point and build milliunits with integer math to avoid
  // float drift (e.g. 0.1 * 1000 !== 100 reliably).
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace(/^-/, "").split(".");
  const fracMilli = Number((frac + "000").slice(0, 3));
  const value = Number(whole || "0") * MILLI + fracMilli;
  return neg ? -value : value;
}

/** Format integer milliunits as a decimal string. Display only. */
export function fromMilli(milli, { sign = false } = {}) {
  const neg = milli < 0;
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / MILLI);
  const frac = String(abs % MILLI).padStart(3, "0").replace(/0+$/, "").padEnd(2, "0");
  const body = `${whole}.${frac}`;
  if (neg) return `-${body}`;
  return sign ? `+${body}` : body;
}

/** Assert a value is a valid Money (safe integer). Throws otherwise. */
export function assertMoney(m, ctx = "money") {
  if (!Number.isSafeInteger(m)) {
    throw new TypeError(`${ctx} must be an integer milliunit value, got ${m}`);
  }
  return m;
}

/** Sum a list of Money with integer safety. */
export function sumMoney(list) {
  let total = 0;
  for (const m of list) total += assertMoney(m, "sumMoney element");
  return total;
}
