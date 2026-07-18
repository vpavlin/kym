// Bank-export importers: parse a CSV export (Air Bank / Revolut / generic) into
// normalized rows { date, amount(milliunits), payee, memo }. No third party —
// this reads a file the user exported from their bank. The CLI turns each new
// row into a txn.create event, deduped on a fingerprint. See docs (issue #8).

/** Minimal RFC-4180-ish CSV parser (handles quotes, embedded delimiters/newlines). */
export function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && r.some((x) => x.trim() !== ""));
}

/** Parse a money string to integer milliunits. Handles "1 234,50", "-1.234,50", "1234.56", "123,-". */
export function parseAmount(s) {
  let t = String(s).trim().replace(/[\s ]/g, "");        // drop spaces/NBSP (thousands)
  if (t === "") return null;
  const neg = /^-/.test(t) || /-$/.test(t);                   // leading or trailing minus
  t = t.replace(/^[-+]/, "").replace(/-$/, "").replace(/[^0-9.,]/g, "");
  const hasDot = t.includes("."), hasCom = t.includes(",");
  if (hasDot && hasCom) {
    // the LAST separator is the decimal point; the other groups thousands
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (hasCom) {
    t = t.replace(",", ".");                                  // Czech decimal comma
  }
  if (t === "" || t === ".") return null;
  const v = Math.round(parseFloat(t) * 1000);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

/** Parse a date cell to an ISO datetime string (noon UTC). Accepts DD.MM.YYYY, YYYY-MM-DD, and with time. */
export function parseDate(s) {
  const t = String(s).trim();
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);                 // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}T12:00:00Z`;
  m = t.match(/(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{2,4})/); // Czech DD.MM.YYYY
  if (m) {
    let [_, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T12:00:00Z`;
  }
  return null;
}

// column resolver: find a header index by any of several candidate names (case/accent-insensitive)
const fold = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
function col(header, candidates) {
  const H = header.map(fold);
  for (const cand of candidates) {
    const i = H.indexOf(fold(cand));
    if (i >= 0) return i;
  }
  // fuzzy contains
  for (const cand of candidates) {
    const i = H.findIndex((h) => h.includes(fold(cand)));
    if (i >= 0) return i;
  }
  return -1;
}

const FORMATS = {
  // Air Bank CZ export (semicolon, Czech). Column names vary by export version.
  airbank: {
    delimiter: ";",
    map(header) {
      return {
        date: col(header, ["Datum provedení", "Datum zaúčtování", "Datum"]),
        amount: col(header, ["Částka v měně účtu", "Částka", "Zaúčtovaná částka"]),
        payee: col(header, ["Název protistrany", "Protistrana", "Název účtu protistrany"]),
        memo: col(header, ["Zpráva pro příjemce", "Poznámka", "Zpráva"]),
      };
    },
  },
  // Revolut export (comma). Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
  revolut: {
    delimiter: ",",
    map(header) {
      return {
        date: col(header, ["Completed Date", "Started Date", "Date"]),
        amount: col(header, ["Amount"]),
        payee: col(header, ["Description"]),
        memo: col(header, ["Type"]),
      };
    },
  },
};

/**
 * Parse a bank export into normalized rows.
 * @param {string} text file contents
 * @param {{format?:string, delimiter?:string, dateCol?:number, amountCol?:number, payeeCol?:number, memoCol?:number}} opts
 * @returns {{rows: Array<{date,amount,payee,memo}>, skipped: number, format: string}}
 */
export function parseExport(text, opts = {}) {
  const fmt = opts.format || (text.includes(";") && !text.split("\n")[0].includes(",") ? "airbank" : "revolut");
  const spec = FORMATS[fmt];
  const delimiter = opts.delimiter || (spec ? spec.delimiter : ",");
  const table = parseCsv(text, delimiter);
  if (!table.length) return { rows: [], skipped: 0, format: fmt };
  const header = table[0];
  const idx = spec
    ? spec.map(header)
    : { date: opts.dateCol ?? 0, amount: opts.amountCol ?? 1, payee: opts.payeeCol ?? 2, memo: opts.memoCol ?? -1 };

  const rows = [];
  let skipped = 0;
  for (const r of table.slice(1)) {
    const date = parseDate(r[idx.date] ?? "");
    const amount = parseAmount(r[idx.amount] ?? "");
    if (date == null || amount == null) { skipped++; continue; }
    const payee = (idx.payee >= 0 ? r[idx.payee] : "")?.trim() || "";
    const memo = (idx.memo >= 0 ? r[idx.memo] : "")?.trim() || "";
    rows.push({ date, amount, payee, memo });
  }
  return { rows, skipped, format: fmt };
}

/** Deterministic dedup fingerprint for an imported row. */
export function fingerprint(row, accountId) {
  return `${row.date.slice(0, 10)}|${row.amount}|${row.payee}|${accountId}`;
}
