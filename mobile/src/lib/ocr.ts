// On-device receipt OCR. Two layers, deliberately split:
//
//   recognizeReceipt(uri)  — the ONLY impure part: calls Google ML Kit Text
//                            Recognition v2 (native, offline). Can't run on the
//                            x86_64 emulator/CI — needs an arm64 device.
//   extractReceiptFields() — a PURE function over the recognition result. All the
//                            deterministic heuristics (amount/date/merchant) live
//                            here so the parsing can be unit-reasoned even though
//                            ML Kit itself can't be exercised in this environment.
//
// OCR output is NEVER final truth: everything returned here is an editable prefill
// the user confirms/corrects before the txn is saved. Money is integer milliunits.
import TextRecognition from "@react-native-ml-kit/text-recognition";
import type { TextRecognitionResult } from "@react-native-ml-kit/text-recognition";
import { toMilli } from "./engine";

export interface ReceiptFields {
  rawText: string;
  amount?: number; // integer milliunits (positive magnitude), via toMilli
  merchant?: string;
  date?: string; // ISO YYYY-MM-DD
}

// Lines that carry the grand total. Diacritic-folded + upper-cased before match,
// so "K ÚHRADĚ" -> "K UHRADE". CELKEM = Czech "total"; SUMA = "sum".
const TOTAL_KEYWORDS = ["CELKEM", "TOTAL", "SUMA", "K UHRADE", "KUHRADE"];
// Lines we must NOT read a total off of even if they contain a keyword-ish word
// (a VAT/subtotal line is not the amount due). Kept small on purpose.
const NEGATIVE_KEYWORDS = ["MEZISOUCET", "SUBTOTAL", "BEZ DPH", "ZAKLAD"];
// Currency markers that make a bare number "look like money" for the fallback.
const CURRENCY_RE = /(kc|kč|czk|€|eur|\$|usd)/i;
// A token that is really a date (DD.MM.YYYY / DD. MM. YYYY) — never a price.
const DATE_TOKEN_RE = /\d{1,2}\s*[.,]\s*\d{1,2}\s*[.,]\s*\d{2,4}/;
// Number-ish run: digits with internal ASCII/NBSP/thin spaces (Czech thousands),
// dots or commas.
const NUM_RE = /\d[\d   .,]*\d|\d/g;
// Whitespace that can separate thousands (ASCII space, NBSP, thin space).
const GROUP_SPACE_RE = /[\s  ]/g;
// Combining diacritical marks, stripped in fold().
const DIACRITICS_RE = /[̀-ͯ]/g;

/** Strip diacritics and upper-case for accent-insensitive keyword matching. */
function fold(s: string): string {
  return s.normalize("NFD").replace(DIACRITICS_RE, "").toUpperCase();
}

/**
 * Normalize a raw numeric token to a canonical decimal string ("1234.50"), or
 * null. Handles Czech "1 234,50" (space thousands, comma decimal), "1.234,50",
 * plain "123.45" / "123,45" / "123", and the Czech "123,-" whole-koruna form.
 * The last separator followed by 1-2 digits is treated as the decimal point;
 * everything else is a thousands separator and dropped.
 */
export function normalizeAmountToken(raw: string): string | null {
  // Keep only digits and separators; drop the "123,-" dash placeholder for ,00.
  let s = raw.replace(/[^\d.,\s  -]/g, "").trim();
  s = s.replace(/[.,]\s*-+\s*$/, ""); // "123,-" -> "123"
  s = s.replace(GROUP_SPACE_RE, ""); // spaces are thousands separators
  if (!/\d/.test(s)) return null;

  const neg = s.startsWith("-");
  s = s.replace(/-/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  let decimalSep = "";
  if (lastComma !== -1 && lastDot !== -1) {
    decimalSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma !== -1) {
    // 1-2 trailing digits => decimal; 3 (e.g. "1,234") => thousands grouping.
    decimalSep = s.length - lastComma - 1 <= 2 ? "," : "";
  } else if (lastDot !== -1) {
    decimalSep = s.length - lastDot - 1 <= 2 ? "." : "";
  }

  let whole = s;
  let frac = "";
  if (decimalSep) {
    const idx = s.lastIndexOf(decimalSep);
    whole = s.slice(0, idx);
    frac = s.slice(idx + 1);
  }
  whole = whole.replace(/[.,]/g, "");
  frac = frac.replace(/[.,]/g, "");
  if (!whole && !frac) return null;
  return `${neg ? "-" : ""}${whole || "0"}${frac ? "." + frac : ""}`;
}

interface AmountCandidate {
  milli: number;
  hadFraction: boolean;
  raw: string;
}

/** Extract every money-looking candidate from a single line of text. */
function candidatesInLine(line: string): AmountCandidate[] {
  const out: AmountCandidate[] = [];
  const matches = line.match(NUM_RE);
  if (!matches) return out;
  for (const m of matches) {
    if (DATE_TOKEN_RE.test(m)) continue; // never read a date as a price
    const canonical = normalizeAmountToken(m);
    if (canonical === null) continue;
    const milli = toMilli(canonical);
    if (milli <= 0) continue;
    out.push({ milli, hadFraction: canonical.includes("."), raw: m });
  }
  return out;
}

/** Flatten a recognition result into individual text lines (in reading order). */
function toLines(result: TextRecognitionResult): string[] {
  const lines: string[] = [];
  if (result.blocks && result.blocks.length) {
    // ML Kit returns blocks/lines in reading order; keep block order and, within
    // a block, the line order it gives us.
    for (const b of result.blocks) {
      if (b.lines && b.lines.length) {
        for (const l of b.lines) if (l.text.trim()) lines.push(l.text);
      } else if (b.text.trim()) {
        lines.push(...b.text.split(/\r?\n/).filter((x) => x.trim()));
      }
    }
  }
  if (!lines.length && result.text) {
    lines.push(...result.text.split(/\r?\n/).filter((x) => x.trim()));
  }
  return lines;
}

/**
 * Pick the total. Preference order:
 *   1. A number on (or adjacent to — next/prev line) a line whose folded text
 *      contains a TOTAL keyword and no NEGATIVE keyword. Among those, the LARGEST
 *      (the amount due dominates VAT/rounding lines near the keyword).
 *   2. Fallback: the largest number that "looks like money" — has a decimal part
 *      or sits on a line with a currency marker — excluding date tokens.
 */
function pickAmount(lines: string[]): number | undefined {
  const folded = lines.map(fold);
  const keywordCands: AmountCandidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    const f = folded[i];
    const isTotal = TOTAL_KEYWORDS.some((k) => f.includes(k));
    if (!isTotal) continue;
    if (NEGATIVE_KEYWORDS.some((k) => f.includes(k))) continue;
    // Same line first, then the following line, then the previous one.
    let cands = candidatesInLine(lines[i]);
    if (!cands.length && i + 1 < lines.length) cands = candidatesInLine(lines[i + 1]);
    if (!cands.length && i - 1 >= 0) cands = candidatesInLine(lines[i - 1]);
    keywordCands.push(...cands);
  }
  if (keywordCands.length) {
    return keywordCands.reduce((a, b) => (b.milli > a.milli ? b : a)).milli;
  }

  // Fallback: largest money-looking number anywhere.
  let best: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const lineHasCurrency = CURRENCY_RE.test(lines[i]);
    for (const c of candidatesInLine(lines[i])) {
      if (!c.hadFraction && !lineHasCurrency) continue; // avoid IČO / phone / year
      if (best === undefined || c.milli > best) best = c.milli;
    }
  }
  return best;
}

/** Find a date and return it ISO (YYYY-MM-DD). Czech DD.MM.YYYY / DD. MM. YYYY
 * and ISO YYYY-MM-DD are both recognized; the earliest valid match wins. */
export function pickDate(text: string): string | undefined {
  const found: Array<{ index: number; iso: string }> = [];

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  for (let m; (m = iso.exec(text)); ) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (validYmd(y, mo, d)) found.push({ index: m.index, iso: fmtIso(y, mo, d) });
  }

  const cz = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})\b/g;
  for (let m; (m = cz.exec(text)); ) {
    const d = +m[1];
    const mo = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000; // "26" -> 2026
    if (validYmd(y, mo, d)) found.push({ index: m.index, iso: fmtIso(y, mo, d) });
  }

  if (!found.length) return undefined;
  found.sort((a, b) => a.index - b.index);
  return found[0].iso;
}

function validYmd(y: number, mo: number, d: number): boolean {
  return y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}
function fmtIso(y: number, mo: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}`;
}

/** First "substantial" line (has a letter, not just digits/symbols) of the
 * top-most block — the merchant name usually leads the receipt header. */
function pickMerchant(
  result: TextRecognitionResult,
  lines: string[]
): string | undefined {
  const blocks = result.blocks ?? [];
  if (blocks.length) {
    // Sort by vertical position when frames are present; ML Kit's own order
    // otherwise. Take the top block and scan its lines.
    const sorted = [...blocks].sort(
      (a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0)
    );
    const top = sorted[0];
    const topLines = top.lines?.length
      ? top.lines.map((l) => l.text)
      : top.text.split(/\r?\n/);
    const hit = topLines.find(isSubstantial);
    if (hit) return hit.trim();
  }
  return lines.find(isSubstantial)?.trim();
}

function isSubstantial(s: string): boolean {
  const t = s.trim();
  return t.length >= 2 && /\p{L}/u.test(t);
}

/**
 * PURE heuristic extractor over an ML Kit recognition result. Deterministic:
 * same input -> same output, no I/O. This is the testable core.
 */
export function extractReceiptFields(result: TextRecognitionResult): ReceiptFields {
  const safe: TextRecognitionResult = result ?? { text: "", blocks: [] };
  const rawText = safe.text ?? "";
  const lines = toLines(safe);
  return {
    rawText,
    amount: pickAmount(lines),
    merchant: pickMerchant(safe, lines),
    date: pickDate(rawText || lines.join("\n")),
  };
}

/**
 * Snap -> recognize -> extract. The impure entry point: runs Google ML Kit Text
 * Recognition v2 on-device (offline). Throws if the native module is unavailable
 * (e.g. the emulator with no arm64 libs) — callers degrade to manual entry.
 */
export async function recognizeReceipt(imageUri: string): Promise<ReceiptFields> {
  const result = await TextRecognition.recognize(imageUri);
  return extractReceiptFields(result);
}
