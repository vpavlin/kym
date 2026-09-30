// Phone-shaped events must fold identically on every surface. The phone writes
// `categoryId: null` for "uncategorized", `targetMonth: null`, and older builds
// wrote a numeric `date` (epoch ms) on reconcile adjustments. kym_engine.hpp reads
// null / wrong-typed fields as their default (jget/jdate); this fold must agree.
// The SAME fixture is folded by kym_core/test/parity.cpp against the same `expect`.
//
// Hand-computed expectation:
//   checking 100000 −10000 (t1, uncategorized → RTA) −5000 (t2, epoch date → 2026-07)
//            +7000 (t4 income) −1000 (t5, null date → month "") + 0 (t6, null amount) = 91000
//   visa −2000 (t3, category cleared by a null edit → no leg, no CCP move)
//   groceries: month "" −1000 (rolls off → cash overspending 1000), 2026-07: 30000 −5000 = 25000
//   income 100000 −10000 +7000 = 97000; RTA = 97000 − 30000 − 1000 = 66000
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeState, checkInvariant, listTransactions } from "@kym/engine";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures", "phone-shaped.json"), "utf8"));

test("phone-shaped events fold without throwing and match the C++ expectation", () => {
  const st = computeState(fx.events);
  const x = fx.expect;
  assert.equal(st.currentMonth, x.currentMonth);
  assert.deepEqual(st.balances, x.balances);
  assert.deepEqual(st.categoryAvailable, x.categoryAvailable);
  assert.deepEqual(st.creditCardPayments, x.creditCardPayments);
  for (const [k, want] of Object.entries(x.activity)) {
    const [cat, month] = k.split("|");
    const row = st.categoryMonths.find((r) => r.categoryId === cat && r.month === month);
    assert.equal(row?.activity, want, `activity ${k}`);
  }
  assert.equal(st.income, x.income);
  assert.equal(st.totalAssigned, x.totalAssigned);
  assert.equal(st.cashOverspending, x.cashOverspending);
  assert.equal(st.readyToAssign, x.readyToAssign);
  for (const [cat, want] of Object.entries(x.targetNeeded)) assert.equal(st.targetProgress[cat].needed, want);
  assert.equal(checkInvariant(st).ok, x.invariantOk);
});

test("categoryId: null clears the category (edit) and means uncategorized (create)", () => {
  const t3 = listTransactions(fx.events).find((t) => t.txnId === "t3");
  assert.equal(t3.categoryId, null);
  // Order independence: the fold is the same whichever order the events arrive in.
  const rev = computeState([...fx.events].reverse());
  assert.deepEqual(rev.balances, fx.expect.balances);
  assert.equal(rev.readyToAssign, fx.expect.readyToAssign);
});

test("categoriesWithHistory counts txn.edit re-categorization and splits (delete guard)", async () => {
  const { categoriesWithHistory } = await import("@kym/engine");
  const h = { wall: 1, ctr: 0, dev: "d" };
  const log = [
    { id: "a", type: "category.create", hlc: h, payload: { categoryId: "cat:empty", groupId: "g", name: "Empty" } },
    { id: "b", type: "txn.create", hlc: h, payload: { txnId: "t", accountId: "x", amount: -1, date: "2026-07-01", categoryId: null } },
    { id: "c", type: "txn.edit", hlc: h, payload: { txnId: "t", categoryId: "cat:edited" } },
    { id: "d", type: "txn.edit", hlc: h, payload: { txnId: "t", splits: [{ categoryId: "cat:split", amount: -1 }] } },
    { id: "e", type: "move", hlc: h, payload: { fromCategoryId: "cat:from", toCategoryId: "cat:to", month: "2026-07", amount: 1 } },
  ];
  const got = [...categoriesWithHistory(log)].sort();
  // Same set kym_core/test/parity.cpp case 8 expects from categoryHistory().
  assert.deepEqual(got, ["cat:edited", "cat:from", "cat:split", "cat:to"]);
});
