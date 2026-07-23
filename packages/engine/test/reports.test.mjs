// netWorth + spendingReport — the shared, surface-agnostic report builders that
// replace the CLI's inline console logic so mobile/desktop/CLI render one source
// of truth. Both are pure functions of a folded BudgetState.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ev, Clock, AccountType } from "@kym/contract";
import { computeState, netWorth, spendingReport } from "@kym/engine";

const M = "2026-07";
const clk = () => new Clock("dev-test");

function budget() {
  const c = clk();
  return [
    ev.groupCreate(c.send(), { groupId: "grp:e", name: "Everyday" }),
    ev.categoryCreate(c.send(), { categoryId: "cat:groc", groupId: "grp:e", name: "Groceries" }),
    ev.categoryCreate(c.send(), { categoryId: "cat:dine", groupId: "grp:e", name: "Dining" }),
    // On-budget CZK checking + an off-budget EUR tracking account.
    ev.accountCreate(c.send(), { accountId: "acct:chk", name: "Checking", accountType: AccountType.CHECKING, onBudget: true, startingBalance: 50_000_000, startDate: "2026-07-01", currency: "CZK" }),
    ev.accountCreate(c.send(), { accountId: "acct:eur", name: "Revolut", accountType: AccountType.TRACKING, onBudget: false, startingBalance: 1_000_000, startDate: "2026-07-01", currency: "EUR" }),
    // Spend: 2 000 groceries, 3 500 dining.
    ev.txnCreate(c.send(), { txnId: "t1", accountId: "acct:chk", amount: -2_000_000, date: "2026-07-04", categoryId: "cat:groc" }),
    ev.txnCreate(c.send(), { txnId: "t2", accountId: "acct:chk", amount: -3_500_000, date: "2026-07-06", categoryId: "cat:dine" }),
  ];
}

test("netWorth: groups balances by currency, never converts", () => {
  const st = computeState(budget());
  const nw = netWorth(st, "CZK");
  assert.deepEqual(nw.currencies.sort(), ["CZK", "EUR"]);
  assert.equal(nw.byCurrency.CZK.net, 50_000_000 - 2_000_000 - 3_500_000, "CZK net = start minus spend");
  assert.equal(nw.byCurrency.EUR.net, 1_000_000, "EUR reported separately, untouched");
  assert.equal(nw.byCurrency.CZK.rows.length, 1);
  assert.equal(nw.byCurrency.EUR.rows[0].onBudget, false, "tracking account carries its off-budget flag");
});

test("spendingReport: per-category outflow, largest first, with a total", () => {
  const st = computeState(budget());
  const rep = spendingReport(st, M);
  assert.equal(rep.month, M);
  assert.deepEqual(rep.rows.map((r) => r.name), ["Dining", "Groceries"], "sorted by spend desc");
  assert.equal(rep.rows[0].spent, 3_500_000);
  assert.equal(rep.rows[1].spent, 2_000_000);
  assert.equal(rep.total, 5_500_000, "total spend for the month");
});

test("spendingReport: a month with no spending is empty", () => {
  const st = computeState(budget());
  const rep = spendingReport(st, "2026-08");
  assert.deepEqual(rep.rows, []);
  assert.equal(rep.total, 0);
});
