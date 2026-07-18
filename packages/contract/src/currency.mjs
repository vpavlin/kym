// Currency formatting. Money is stored as currency-agnostic integer milliunits;
// this is the DISPLAY edge only. KYM's model: one budget currency (default CZK)
// plus foreign accounts as off-budget tracking shown in their own currency — no
// in-budget FX conversion. See docs/data-model.md + memory kym-currency.

export const CURRENCIES = {
  // decimals = shown fraction digits; CZK drops haléře (whole koruna).
  CZK: { code: "CZK", symbol: "Kč", decimals: 0, symbolAfter: true, thousands: " ", decimal: "," },
  EUR: { code: "EUR", symbol: "€",  decimals: 2, symbolAfter: true, thousands: " ", decimal: "," },
  USD: { code: "USD", symbol: "$",  decimals: 2, symbolAfter: false, thousands: ",", decimal: "." },
};

export const DEFAULT_CURRENCY = "CZK";

/**
 * Format integer milliunits for display in the given currency.
 * @param {number} milli integer milliunits
 * @param {string} code  currency code (CZK|EUR|USD), default CZK
 * @param {{sign?:boolean}} [opts] show a leading + for positives
 */
export function formatMoney(milli, code = DEFAULT_CURRENCY, { sign = false } = {}) {
  const c = CURRENCIES[code] || CURRENCIES[DEFAULT_CURRENCY];
  const neg = milli < 0;
  const factor = Math.pow(10, 3 - c.decimals);          // milliunits carry 3 fraction digits
  const units = Math.round(Math.abs(milli) / factor);   // integer in the display's smallest unit
  const scale = Math.pow(10, c.decimals);
  const whole = Math.floor(units / scale);
  const frac = c.decimals ? String(units % scale).padStart(c.decimals, "0") : "";
  const ws = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, c.thousands);
  const numeric = c.decimals ? `${ws}${c.decimal}${frac}` : ws;
  const lead = neg ? "-" : sign ? "+" : "";
  return c.symbolAfter ? `${lead}${numeric} ${c.symbol}` : `${lead}${c.symbol}${numeric}`;
}
