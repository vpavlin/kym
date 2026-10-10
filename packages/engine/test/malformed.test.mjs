// Malformed events another member could write must fold identically on every surface — and must
// never throw (in the C++ core an exception kills the Basecamp module for everyone holding the
// budget). The SAME fixture is folded by kym_core/test/parity.cpp (section 9) against `expect`.
//
// Rules (engine.mjs wellFormed / kym_engine.hpp wellFormed): a payload that isn't an object, or an
// id field that isn't a string, skips the event; a split txn whose legs don't sum is skipped whole;
// an unparseable targetMonth turns off the by-date target maths; a non-array `splits` clears the
// splits; a non-string transferId is no transfer; a missing onBudget is on-budget.
//
// Hand-computed expectation:
//   checking 100000 −5000 (t1 groc) −2000 (t2: splits edited to a string → uncategorized → RTA) = 93000
//   visa +2000 (t3: numeric transferId → not a transfer, no CCP move); savings 1000 (no onBudget → on)
//   skipped: m07–m13 (non-object payload / non-string ids), m14 (splits −2000 ≠ −3000), m21–m23
//   income 100000 + 1000 − 2000 = 99000; RTA = 99000 − 30000 = 69000; groc 30000 − 5000 = 25000
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeState, checkInvariant, listTransactions, categoriesWithHistory, wellFormed } from "@kym/engine";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures", "malformed.json"), "utf8"));

test("malformed events fold without throwing and match the C++ expectation", () => {
  const st = computeState(fx.events);
  const x = fx.expect;
  assert.equal(st.currentMonth, x.currentMonth);
  assert.deepEqual(st.balances, x.balances);
  assert.deepEqual(st.accounts.map((a) => a.id), x.accountIds);
  assert.deepEqual(st.categories.map((c) => c.id), x.categoryIds);
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
  const rev = computeState([...fx.events].reverse());
  assert.equal(rev.readyToAssign, x.readyToAssign);
});

test("listTransactions / categoriesWithHistory don't throw on malformed events", () => {
  const ids = listTransactions(fx.events).map((t) => t.txnId).sort();
  assert.deepEqual(ids, ["t1", "t2", "t3", "t:badsplit"]);
  assert.ok(categoriesWithHistory(fx.events).has("cat:groc"));
});

test("wellFormed: non-object payloads and non-string ids are rejected", () => {
  const h = { wall: 1, ctr: 0, dev: "d" };
  assert.equal(wellFormed({ type: "txn.create", hlc: h, payload: null }), false);
  assert.equal(wellFormed({ type: "txn.create", hlc: h, payload: [] }), false);
  assert.equal(wellFormed({ type: "txn.create", hlc: h, payload: { txnId: 1 } }), false);
  assert.equal(wellFormed({ type: "txn.create", hlc: h, payload: { txnId: "t" } }), true);
  assert.equal(wellFormed({ type: "some.future.type", hlc: h, payload: {} }), true);
});
