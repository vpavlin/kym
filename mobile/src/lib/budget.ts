// Budget-level helpers built on the shared engine: default ids, a demo seed, and
// a transaction reconstruction for the review list. All pure — they take a Clock
// (for HLC-stamped events) and produce events or read-only views.
import { ev } from "./engine";
import type { Clock, KymEvent } from "./engine";

// Deterministic ids derived from the display name — a BYTE-FOR-BYTE port of the
// desktop kym_core slug()/id scheme ("grp:"/"cat:"/"acct:" + slug). This is what
// makes a "Groceries" created on the phone and one created in Basecamp collapse
// to the SAME id on merge, instead of producing two duplicates. The separator is
// a colon (matching desktop), NOT the hyphen the old constants used.
export function slug(name: string): string {
  let s = "";
  let prevDash = false;
  for (const ch of name) {
    const l = ch.toLowerCase();
    if ((l >= "a" && l <= "z") || (l >= "0" && l <= "9")) { s += l; prevDash = false; }
    else if (s && !prevDash) { s += "-"; prevDash = true; }
  }
  while (s.endsWith("-")) s = s.slice(0, -1);
  // Desktop falls back to a random hex slug for an all-punctuation name; match it.
  return s || Math.random().toString(16).slice(2, 10);
}
export const grpId = (name: string) => "grp:" + slug(name);
export const catId = (name: string) => "cat:" + slug(name);
export const acctId = (name: string) => "acct:" + slug(name);

// Strip diacritics before slugging ("Jídlo" → "jidlo") so non-ASCII names don't all
// collapse onto the same "j-dlo"-style id. Plain-ASCII names slug exactly like
// desktop's slug(), so their ids stay identical across surfaces.
function translitSlug(name: string): string {
  let t = name;
  try { t = name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch { /* no ICU → plain slug */ }
  return slug(t);
}

/**
 * A NEW, collision-free entity id: `prefix` + transliterated slug, and — only if
 * that id was ever used in this budget (`taken`: every id created in the log, incl.
 * deleted ones, so a late delete can't hit the new entity) — a short random suffix.
 * Existing ids are never re-derived, so they keep working unchanged.
 */
export function newEntityId(prefix: "acct:" | "cat:" | "grp:", name: string, taken: Set<string>): string {
  const base = prefix + translitSlug(name);
  if (!taken.has(base)) return base;
  for (;;) {
    const id = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (!taken.has(id)) return id;
  }
}

/** Every account / category / group id ever created in `events` (for newEntityId). */
export function takenIds(events: KymEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    const p: any = e.payload;
    if (!p) continue;
    if (e.type === "account.create" && typeof p.accountId === "string") out.add(p.accountId);
    else if (e.type === "category.create" && typeof p.categoryId === "string") out.add(p.categoryId);
    else if (e.type === "group.create" && typeof p.groupId === "string") out.add(p.groupId);
  }
  return out;
}

// Local-time calendar helpers. Dates/months are the user's LOCAL day — a UTC
// toISOString() put 00:00–01:59 (CET/CEST) on the 1st into the previous month.
const pad2 = (n: number) => String(n).padStart(2, "0");
/** Local calendar day "YYYY-MM-DD" of `d` (default now). */
export function localYmd(d: Date | number = Date.now()): string {
  const x = typeof d === "number" ? new Date(d) : d;
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}
/** Local calendar month "YYYY-MM" of `d` (default now). */
export function localMonth(d: Date | number = Date.now()): string {
  return localYmd(d).slice(0, 7);
}
/**
 * A txn date as a Date for DISPLAY/SORT: a bare "YYYY-MM-DD" is that LOCAL day (JS
 * would parse it as UTC midnight and show the previous day west of Greenwich); full
 * ISO strings and epoch numbers parse as usual.
 */
export function txnDate(d: string | number | null | undefined): Date {
  if (typeof d === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  }
  return new Date(d ?? 0);
}

// Stable ids so a re-seed is deterministic and categories are referenceable. Same
// "acct:"/"grp:"/"cat:" + slug form desktop uses (new seeds only — budgets seeded
// with the old hyphen ids keep them; LEGACY_DEFAULT_ACCOUNT still resolves).
export const DEFAULT_ACCOUNT = "acct:checking";
export const LEGACY_DEFAULT_ACCOUNT = "acct-checking";
export const DEFAULT_CASH = "acct:cash";
export const DEFAULT_REVOLUT = "acct:revolut";
export const GROUP_EVERYDAY = "grp:everyday";
export const GROUP_BILLS = "grp:bills";

export interface SeedCategory {
  id: string;
  name: string;
  groupId: string;
}

export const SEED_CATEGORIES: SeedCategory[] = [
  { id: "cat:groceries", name: "Groceries", groupId: GROUP_EVERYDAY },
  { id: "cat:dining-out", name: "Dining Out", groupId: GROUP_EVERYDAY },
  { id: "cat:transport", name: "Transport", groupId: GROUP_EVERYDAY },
  { id: "cat:fun-money", name: "Fun Money", groupId: GROUP_EVERYDAY },
  { id: "cat:rent", name: "Rent", groupId: GROUP_BILLS },
  { id: "cat:utilities", name: "Utilities", groupId: GROUP_BILLS },
];

/**
 * A meaningful starter budget so balances are non-trivial on first run, using
 * CZK-realistic amounts (the budget currency): a checking + cash account funding
 * Ready to Assign, a EUR "Revolut" off-budget tracking account (shown in its own
 * currency — the CZK + foreign-account model), two groups, six categories, and a
 * few assignments this month. Money is integer milliunits (units × 1000).
 */
export function buildSeedEvents(clock: Clock): KymEvent[] {
  const month = localMonth();
  const out: KymEvent[] = [];
  const push = (e: KymEvent) => out.push(e);

  push(ev.groupCreate(clock.send(), { groupId: GROUP_EVERYDAY, name: "Everyday" }));
  push(ev.groupCreate(clock.send(), { groupId: GROUP_BILLS, name: "Bills" }));

  push(
    ev.accountCreate(clock.send(), {
      accountId: DEFAULT_ACCOUNT,
      name: "Checking",
      accountType: "checking",
      onBudget: true,
      startingBalance: 45_000_000, // 45 000 Kč (a month's salary) → Ready to Assign
      startDate: localYmd(), // YYYY-MM-DD string, like every other surface
      currency: "CZK",
    })
  );
  push(
    ev.accountCreate(clock.send(), {
      accountId: DEFAULT_CASH,
      name: "Cash",
      accountType: "cash",
      onBudget: true,
      startingBalance: 2_000_000, // 2 000 Kč
      startDate: localYmd(), // YYYY-MM-DD string, like every other surface
      currency: "CZK",
    })
  );
  // A foreign account is off-budget tracking, shown in its own currency (no
  // in-budget FX). This makes the UI demonstrate the CZK + EUR model.
  push(
    ev.accountCreate(clock.send(), {
      accountId: DEFAULT_REVOLUT,
      name: "Revolut",
      accountType: "tracking",
      onBudget: false,
      startingBalance: 500_000, // 500,00 €
      startDate: localYmd(), // YYYY-MM-DD string, like every other surface
      currency: "EUR",
    })
  );

  for (const c of SEED_CATEGORIES) {
    push(ev.categoryCreate(clock.send(), { categoryId: c.id, groupId: c.groupId, name: c.name }));
  }

  // Give some koruna a job so envelopes have Available to spend against.
  const assigns: Array<[string, number]> = [
    ["cat:rent", 18_000_000], // 18 000 Kč
    ["cat:groceries", 8_000_000], // 8 000 Kč
    ["cat:dining-out", 4_000_000], // 4 000 Kč
    ["cat:utilities", 3_000_000], // 3 000 Kč
    ["cat:transport", 3_000_000], // 3 000 Kč
    ["cat:fun-money", 2_000_000], // 2 000 Kč
  ];
  for (const [categoryId, amount] of assigns) {
    push(ev.assign(clock.send(), { categoryId, month, amount, mode: "delta" }));
  }

  return out;
}

export interface TxnView {
  txnId: string;
  accountId: string;
  amount: number;
  date: string | number;
  categoryId?: string | null;
  cleared: "uncleared" | "cleared" | "reconciled";
  memo?: string;
}

/**
 * Reconstruct the current view of every (non-deleted) transaction from the log —
 * same create→edit→delete supersede rules the engine uses, but returning the
 * txn list the review inbox renders. Sorted newest first.
 */
export function listTransactions(events: KymEvent[]): TxnView[] {
  const byId = new Map<string, { view: any; deleted: boolean }>();
  // Events in the log are append-order; that is HLC order for a single device.
  const order = new Map<string, number>();   // txnId -> first-seen position (newest-first tiebreak)
  for (const e of events) {
    if (!e?.payload) continue;
    const p = e.payload;
    if (e.type === "txn.create") {
      const cur = byId.get(p.txnId);
      if (cur) cur.view = { ...cur.view, ...p };
      else { byId.set(p.txnId, { view: { ...p }, deleted: false }); order.set(p.txnId, order.size); }
    } else if (e.type === "txn.edit") {
      const cur = byId.get(p.txnId);
      if (!cur) continue;
      const { txnId, ...fields } = p;
      cur.view = { ...cur.view, ...fields };
    } else if (e.type === "txn.delete") {
      const cur = byId.get(p.txnId);
      if (cur) cur.deleted = true;
    }
  }
  return [...byId.values()]
    .filter((t) => !t.deleted)
    .map((t) => t.view as TxnView)
    // Newest first; same-day txns (dates are local "YYYY-MM-DD" days) newest-entered first.
    .sort((a, b) => (txnDate(b.date).getTime() - txnDate(a.date).getTime()) || ((order.get(b.txnId) ?? 0) - (order.get(a.txnId) ?? 0)));
}
