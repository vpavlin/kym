// Budget-level helpers built on the shared engine: default ids, a demo seed, and
// a transaction reconstruction for the review list. All pure — they take a Clock
// (for HLC-stamped events) and produce events or read-only views.
import { ev, monthOf } from "./engine";
import type { Clock, KymEvent } from "./engine";

// Stable ids so a re-seed is deterministic and categories are referenceable.
export const DEFAULT_ACCOUNT = "acct-checking";
export const DEFAULT_CASH = "acct-cash";
export const GROUP_EVERYDAY = "grp-everyday";
export const GROUP_BILLS = "grp-bills";

export interface SeedCategory {
  id: string;
  name: string;
  groupId: string;
}

export const SEED_CATEGORIES: SeedCategory[] = [
  { id: "cat-groceries", name: "Groceries", groupId: GROUP_EVERYDAY },
  { id: "cat-dining", name: "Dining Out", groupId: GROUP_EVERYDAY },
  { id: "cat-transport", name: "Transport", groupId: GROUP_EVERYDAY },
  { id: "cat-fun", name: "Fun Money", groupId: GROUP_EVERYDAY },
  { id: "cat-rent", name: "Rent", groupId: GROUP_BILLS },
  { id: "cat-utilities", name: "Utilities", groupId: GROUP_BILLS },
];

/**
 * A meaningful starter budget so balances are non-trivial on first run:
 * a checking + cash account with a starting balance (income → Ready to Assign),
 * two groups, six categories, and a few assignments this month.
 */
export function buildSeedEvents(clock: Clock): KymEvent[] {
  const month = monthOf(Date.now());
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
      startingBalance: 250000, // $250.00 → Ready to Assign
      startDate: Date.now(),
    })
  );
  push(
    ev.accountCreate(clock.send(), {
      accountId: DEFAULT_CASH,
      name: "Cash",
      accountType: "cash",
      onBudget: true,
      startingBalance: 40000, // $40.00
      startDate: Date.now(),
    })
  );

  for (const c of SEED_CATEGORIES) {
    push(ev.categoryCreate(clock.send(), { categoryId: c.id, groupId: c.groupId, name: c.name }));
  }

  // Give some dollars a job so envelopes have Available to spend against.
  const assigns: Array<[string, number]> = [
    ["cat-groceries", 80000],
    ["cat-dining", 40000],
    ["cat-transport", 30000],
    ["cat-fun", 20000],
    ["cat-rent", 90000],
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
  for (const e of events) {
    const p = e.payload;
    if (e.type === "txn.create") {
      const cur = byId.get(p.txnId);
      if (cur) cur.view = { ...cur.view, ...p };
      else byId.set(p.txnId, { view: { ...p }, deleted: false });
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
    .sort((a, b) => Number(new Date(b.date as any)) - Number(new Date(a.date as any)));
}
