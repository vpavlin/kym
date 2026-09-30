// KYM money — integer milliunits (currency × 1000). $10.50 === 10500.
// Outflows are negative, inflows positive. Money NEVER touches floating point
// in storage, transport, or arithmetic. These helpers exist only at the UI edge.

/** @typedef {number} Money integer milliunits */

const MILLI = 1000;

/**
 * Normalize the separators of a human amount to a single "." decimal point.
 * Spaces / NBSP / apostrophes are thousands separators and are dropped (everything
 * but digits, ".", "," and "-" is). Then:
 *   - both "." and "," present → the LAST one is the decimal point ("1.500,50", "1,500.50");
 *   - exactly one "," → decimal comma ("1500,50" → 1500.50);
 *   - several of the same separator → thousands ("1,500,000", "1.500.000").
 * kym_core toMilli() (kym_core_impl.cpp) applies the same rules.
 */
function normalizeDecimal(raw) {
  let s = String(raw).trim().replace(/[^0-9.,\-]/g, "");
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  if (dots && commas) {
    const dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    s = s.replace(dec === "." ? /,/g : /\./g, "").replace(",", ".");
  } else if (commas) {
    s = commas === 1 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (dots > 1) {
    s = s.replace(/\./g, "");
  }
  return s;
}

/** Parse a human amount (e.g. "10.50", "10,50", "1 500,50", 10.5) to integer milliunits. UI-edge only. */
export function toMilli(amount) {
  if (typeof amount === "number") return Math.round(amount * MILLI);
  const s = normalizeDecimal(amount);
  if (s === "" || s === "-" || s === ".") return 0;
  // Split on the decimal point and build milliunits with integer math to avoid
  // float drift (e.g. 0.1 * 1000 !== 100 reliably).
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace(/-/g, "").split(".");
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
