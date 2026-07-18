import { test } from "node:test";
import assert from "node:assert/strict";
import { ev, Clock, AccountType } from "@kym/contract";
import { budget_summary, category_status, spending, can_i_afford, net_worth, target_progress, ready_to_assign } from "@kym/mcp/tools";

const M = "2026-07";
const d = `${M}-15T12:00:00Z`;
function fixture() {
  let t = 1000;
  const c = new Clock("A", () => t++);
  return [
    ev.accountCreate(c.send(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 30000000, startDate: d, currency: "CZK" }),
    ev.accountCreate(c.send(), { accountId: "rev", name: "Revolut", accountType: AccountType.TRACKING, onBudget: false, startingBalance: 420000, startDate: d, currency: "EUR" }),
    ev.categoryCreate(c.send(), { categoryId: "groc", groupId: "g", name: "Groceries" }),
    ev.categoryCreate(c.send(), { categoryId: "dine", groupId: "g", name: "Dining" }),
    ev.txnCreate(c.send(), { txnId: "i", accountId: "chk", amount: 45000000, date: d, categoryId: "rta-inflow" }),
    ev.assign(c.send(), { categoryId: "groc", month: M, amount: 8000000 }),
    ev.categoryTarget(c.send(), { categoryId: "groc", targetType: "monthly", amount: 8000000 }),
    ev.txnCreate(c.send(), { txnId: "t1", accountId: "chk", amount: -1240500, date: d, categoryId: "groc", payeeId: "Albert" }),
    ev.txnCreate(c.send(), { txnId: "t2", accountId: "chk", amount: -320000, date: d, categoryId: "dine", payeeId: "Kavárna" }),
  ];
}
const CZK = "CZK";

test("budget_summary reports RTA + invariant", () => {
  const r = budget_summary(fixture(), CZK, {});
  assert.equal(r.invariantOk, true);
  assert.match(r.text, /Ready to Assign/);
  assert.equal(r.categories, 2);
});

const norm = (s) => s.replace(/\s+/g, "");

test("category_status returns engine-computed available + target", () => {
  const r = category_status(fixture(), CZK, { name: "Groceries" });
  assert.equal(norm(r.available), "6760Kč");  // 8000 assigned - 1240.50 spent -> 6759.50 -> 6 760 Kč
  assert.equal(r.target.onTrack, true);       // monthly 8000, assigned 8000
});

test("spending groups by category", () => {
  const r = spending(fixture(), CZK, {});
  assert.equal(norm(r.total), "1561Kč");      // 1240.50 + 320 -> 1560.50 -> 1 561 Kč
  assert.equal(r.breakdown[0].category, "Groceries");
});

test("can_i_afford checks Ready to Assign", () => {
  const yes = can_i_afford(fixture(), CZK, { amount: 10000 });
  assert.equal(yes.affordable, true);
  const no = can_i_afford(fixture(), CZK, { amount: 999999 });
  assert.equal(no.affordable, false);
});

test("can_i_afford against a category's available", () => {
  const r = can_i_afford(fixture(), CZK, { amount: 5000, category: "Groceries" });
  assert.equal(r.affordable, true);        // 6759.50 available
  const r2 = can_i_afford(fixture(), CZK, { amount: 8000, category: "Groceries" });
  assert.equal(r2.affordable, false);
});

test("net_worth separates currencies (no FX)", () => {
  const r = net_worth(fixture(), CZK);
  const codes = r.byCurrency.map((x) => x.currency).sort();
  assert.deepEqual(codes, ["CZK", "EUR"]);
  assert.match(r.text, /not converted/);
});

test("target_progress + ready_to_assign summarize", () => {
  assert.match(target_progress(fixture(), CZK).text, /Groceries: funded/);
  assert.match(ready_to_assign(fixture(), CZK).text, /Ready to Assign/);
});
