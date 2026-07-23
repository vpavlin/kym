// Validates the budgeting ops the mobile app gained (assign / move / setTarget /
// reconcile) by replaying the exact event sequences BudgetContext builds and
// folding them through the shared engine — the same path the desktop/CLI use.
// If these pass, the phone produces the same budget as every other surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ev, Clock, AccountType, RTA_INFLOW } from "@kym/contract";
import { computeState, checkInvariant, listTransactions } from "@kym/engine";

const M = "2026-07";
const clk = () => new Clock("dev-test");

// A small starting budget: one on-budget account seeded with 10 000, and two
// categories under one group. Seeding a positive starting balance funds RTA.
function seed() {
  const c = clk();
  return [
    ev.groupCreate(c.send(), { groupId: "grp:bills", name: "Bills" }),
    ev.categoryCreate(c.send(), { categoryId: "cat:rent", groupId: "grp:bills", name: "Rent" }),
    ev.categoryCreate(c.send(), { categoryId: "cat:fun", groupId: "grp:bills", name: "Fun" }),
    ev.accountCreate(c.send(), {
      accountId: "acct:checking", name: "Checking", accountType: AccountType.CHECKING,
      onBudget: true, startingBalance: 10_000_000, startDate: "2026-07-01", currency: "CZK",
    }),
  ];
}
// Raw-state readers (computeState output, not the folded ui JSON).
const assignedOf = (st, id, month = M) => (st.categoryMonths.find((r) => r.categoryId === id && r.month === month) || {}).assigned ?? 0;
const availOf = (st, id) => st.categoryAvailable?.[id] ?? 0;

test("assign: delta then set adjusts a category's assigned total", () => {
  const c = clk();
  const events = [
    ...seed(),
    ev.assign(c.send(), { categoryId: "cat:rent", month: M, amount: 3_000_000, mode: "delta" }),
    ev.assign(c.send(), { categoryId: "cat:rent", month: M, amount: 1_000_000, mode: "delta" }),
  ];
  let st = computeState(events);
  assert.equal(assignedOf(st, "cat:rent"), 4_000_000, "two deltas accumulate");
  // "set" makes the total equal the amount (not add)
  events.push(ev.assign(c.send(), { categoryId: "cat:rent", month: M, amount: 5_000_000, mode: "set" }));
  st = computeState(events);
  assert.equal(assignedOf(st, "cat:rent"), 5_000_000, "set overrides the running total");
  assert.ok(checkInvariant(st).ok, "invariant holds after assign");
});

test("moveMoney: net-zero transfer between two categories", () => {
  const c = clk();
  const events = [
    ...seed(),
    ev.assign(c.send(), { categoryId: "cat:rent", month: M, amount: 4_000_000, mode: "set" }),
    ev.move(c.send(), { fromCategoryId: "cat:rent", toCategoryId: "cat:fun", month: M, amount: 1_500_000 }),
  ];
  const st = computeState(events);
  assert.equal(availOf(st, "cat:rent"), 2_500_000, "source loses the moved amount");
  assert.equal(availOf(st, "cat:fun"), 1_500_000, "dest gains it");
  assert.ok(checkInvariant(st).ok, "move preserves the invariant (net zero)");
});

test("setTarget: a monthly target drives targetProgress; amount 0 clears it", () => {
  const c = clk();
  const events = [
    ...seed(),
    ev.assign(c.send(), { categoryId: "cat:rent", month: M, amount: 2_000_000, mode: "set" }),
    ev.categoryTarget(c.send(), { categoryId: "cat:rent", targetType: "monthly", amount: 6_000_000, targetMonth: null }),
  ];
  let st = computeState(events);
  assert.ok(st.targetProgress?.["cat:rent"], "a target produces targetProgress");
  assert.equal(st.targetProgress["cat:rent"].needed, 4_000_000, "needs 6000 - 2000 assigned");
  // amount 0 clears the target
  events.push(ev.categoryTarget(c.send(), { categoryId: "cat:rent", targetType: "monthly", amount: 0, targetMonth: null }));
  st = computeState(events);
  assert.ok(!st.targetProgress?.["cat:rent"], "amount 0 clears the target");
});

test("addIncome: a positive inflow to RTA_INFLOW feeds Ready to Assign", () => {
  const c = clk();
  // Account seeded at 0, then income of 20 000 booked to Ready to Assign.
  const events = [
    ev.groupCreate(c.send(), { groupId: "grp:bills", name: "Bills" }),
    ev.accountCreate(c.send(), { accountId: "acct:checking", name: "Checking", accountType: AccountType.CHECKING, onBudget: true, startingBalance: 0, startDate: "2026-07-01", currency: "CZK" }),
    ev.txnCreate(c.send(), { txnId: "txn-inc", accountId: "acct:checking", amount: 20_000_000, date: "2026-07-03", categoryId: RTA_INFLOW, cleared: "uncleared", approved: true }),
  ];
  const st = computeState(events);
  assert.equal(st.readyToAssign, 20_000_000, "income lands in Ready to Assign");
  assert.equal(st.balances["acct:checking"], 20_000_000, "and raises the account balance");
  assert.ok(checkInvariant(st).ok, "invariant holds after income");
});

test("reconcile: books the diff to match actual and locks the account's txns", () => {
  const c = clk();
  // Spend 2 500 from checking (balance 10 000 -> 7 500), uncleared.
  const events = [
    ...seed(),
    ev.txnCreate(c.send(), { txnId: "txn-1", accountId: "acct:checking", amount: -2_500_000, date: "2026-07-05", categoryId: "cat:rent", cleared: "uncleared", approved: true }),
  ];
  let st = computeState(events);
  assert.equal(st.balances["acct:checking"], 7_500_000, "balance after the spend");

  // The mobile reconcile(accountId, actual): diff = actual - balance; book an
  // uncategorized reconciled adjustment for the diff, then lock all not-yet-
  // reconciled txns for the account. Reconcile to a bank balance of 7 000.
  const actual = 7_000_000;
  const bal = st.balances["acct:checking"];
  const diff = actual - bal; // -500 000
  const out = [];
  if (diff !== 0) {
    out.push(ev.txnCreate(c.send(), {
      txnId: "txn-adj", accountId: "acct:checking", amount: diff, date: Date.now(),
      categoryId: null, payeeId: "Reconciliation adjustment", cleared: "reconciled", approved: true,
    }));
  }
  for (const t of listTransactions(events).filter((t) => t.accountId === "acct:checking" && t.cleared !== "reconciled")) {
    out.push(ev.txnEdit(c.send(), { txnId: t.txnId, cleared: "reconciled" }));
  }
  st = computeState([...events, ...out]);

  assert.equal(st.balances["acct:checking"], actual, "balance now equals the bank actual");
  assert.ok(checkInvariant(st).ok, "invariant still holds (adjustment flows to RTA)");
  const locked = listTransactions([...events, ...out]).filter((t) => t.accountId === "acct:checking");
  assert.ok(locked.every((t) => t.cleared === "reconciled"), "every account txn is locked");
});
