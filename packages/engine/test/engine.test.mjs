import { test } from "node:test";
import assert from "node:assert/strict";
import { ev, RTA_INFLOW, ccpCategoryId, AccountType } from "@kym/contract";
import { computeState, checkInvariant, listTransactions } from "@kym/engine";

// A tiny deterministic HLC factory so tests don't depend on the wall clock.
function clock(dev) {
  let n = 0;
  return () => ({ wall: 1_000_000 + n, ctr: 0, dev, _t: n++ });
}
// bump helper: each call advances the fake clock
const mk = (dev) => {
  const c = clock(dev);
  return () => c();
};

const M = "2026-07";
const dateIn = (m) => `${m}-15T12:00:00Z`;

test("clean single-category budget satisfies the invariant", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.groupCreate(h(), { groupId: "g1", name: "Everyday" }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.assign(h(), { categoryId: "groc", month: M, amount: 30000 }),
    ev.txnCreate(h(), { txnId: "t1", accountId: "chk", amount: -25000, date: dateIn(M), categoryId: "groc" }),
  ];
  const s = computeState(events);
  assert.equal(s.balances.chk, 75000);
  assert.equal(s.categoryAvailable.groc, 5000);
  assert.equal(s.readyToAssign, 70000);
  assert.ok(checkInvariant(s).ok, JSON.stringify(checkInvariant(s)));
});

test("positive available rolls forward; negative (cash overspend) hits next month's RTA", () => {
  const h = mk("A");
  const M2 = "2026-08";
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    // July: assign 20000, spend 45000 cash → -25000 (cash overspend)
    ev.assign(h(), { categoryId: "groc", month: M, amount: 20000 }),
    ev.txnCreate(h(), { txnId: "t1", accountId: "chk", amount: -45000, date: dateIn(M), categoryId: "groc" }),
  ];
  // As of July, the negative is still shown in the category (not yet rolled off).
  const july = computeState(events, { asOf: M });
  assert.equal(july.categoryAvailable.groc, -25000);
  assert.ok(checkInvariant(july).ok);

  // As of August, the -25000 rolled off the category (resets toward 0) and reduced RTA.
  const aug = computeState([...events, ev.assign(h(), { categoryId: "groc", month: M2, amount: 0 })], { asOf: M2 });
  assert.equal(aug.categoryAvailable.groc, 0);
  assert.equal(aug.cashOverspending, 25000);
  assert.equal(aug.readyToAssign, 100000 - 20000 - 25000); // 55000
  assert.ok(checkInvariant(aug).ok, JSON.stringify(checkInvariant(aug)));
});

test("funded credit-card purchase relocates money into the card payment category", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.accountCreate(h(), { accountId: "visa", name: "Visa", accountType: AccountType.CREDIT_CARD, startingBalance: 0, startDate: dateIn(M) }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.assign(h(), { categoryId: "groc", month: M, amount: 30000 }),
    ev.txnCreate(h(), { txnId: "t1", accountId: "visa", amount: -25000, date: dateIn(M), categoryId: "groc" }),
  ];
  const s = computeState(events);
  assert.equal(s.balances.visa, -25000);            // debt
  assert.equal(s.categoryAvailable.groc, 5000);     // groceries drained by 25000
  assert.equal(s.creditCardPayments.visa, 25000);   // relocated, ready to pay the card
  assert.equal(s.readyToAssign, 70000);
  const inv = checkInvariant(s);
  assert.ok(inv.ok, JSON.stringify(inv));           // checking(100000) == (5000+25000)+70000
});

test("paying the credit card reduces its payment category and its debt", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.accountCreate(h(), { accountId: "visa", name: "Visa", accountType: AccountType.CREDIT_CARD, startingBalance: 0, startDate: dateIn(M) }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.assign(h(), { categoryId: "groc", month: M, amount: 30000 }),
    ev.txnCreate(h(), { txnId: "t1", accountId: "visa", amount: -25000, date: dateIn(M), categoryId: "groc" }),
    // Pay $20 to the card: transfer checking -> visa (two mirrored legs, uncategorized)
    ev.txnCreate(h(), { txnId: "pay-out", accountId: "chk", amount: -20000, date: dateIn(M), transferId: "xfer1" }),
    ev.txnCreate(h(), { txnId: "pay-in", accountId: "visa", amount: 20000, date: dateIn(M), transferId: "xfer1" }),
  ];
  const s = computeState(events);
  assert.equal(s.balances.chk, 80000);
  assert.equal(s.balances.visa, -5000);             // 25000 debt - 20000 paid
  assert.equal(s.creditCardPayments.visa, 5000);    // earmark reduced by the payment
  const inv = checkInvariant(s);
  assert.ok(inv.ok, JSON.stringify(inv));
});

test("splits must sum to the parent amount and fan out to categories", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.categoryCreate(h(), { categoryId: "home", groupId: "g1", name: "Household" }),
    ev.assign(h(), { categoryId: "groc", month: M, amount: 40000 }),
    ev.assign(h(), { categoryId: "home", month: M, amount: 40000 }),
    ev.txnCreate(h(), { txnId: "t1", accountId: "chk", amount: -30000, date: dateIn(M),
      splits: [{ categoryId: "groc", amount: -18000 }, { categoryId: "home", amount: -12000 }] }),
  ];
  const s = computeState(events);
  assert.equal(s.categoryAvailable.groc, 22000);
  assert.equal(s.categoryAvailable.home, 28000);
  assert.ok(checkInvariant(s).ok);

  const bad = [...events.slice(0, -1), ev.txnCreate(h(), { txnId: "t2", accountId: "chk", amount: -30000, date: dateIn(M),
    splits: [{ categoryId: "groc", amount: -18000 }, { categoryId: "home", amount: -5000 }] })];
  assert.throws(() => computeState(bad), /must sum to txn amount/);
});

test("a txn edit is a superseding event (recategorize), not a mutation", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.categoryCreate(h(), { categoryId: "dine", groupId: "g1", name: "Dining" }),
    ev.assign(h(), { categoryId: "groc", month: M, amount: 30000 }),
    ev.assign(h(), { categoryId: "dine", month: M, amount: 30000 }),
    ev.txnCreate(h(), { txnId: "t1", accountId: "chk", amount: -25000, date: dateIn(M), categoryId: "groc" }),
    ev.txnEdit(h(), { txnId: "t1", categoryId: "dine" }), // moved to Dining
  ];
  const s = computeState(events);
  assert.equal(s.categoryAvailable.groc, 30000);  // no longer charged
  assert.equal(s.categoryAvailable.dine, 5000);   // now charged
  assert.ok(checkInvariant(s).ok);
});

test("a deleted txn is tombstoned and never resurrected", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.assign(h(), { categoryId: "groc", month: M, amount: 30000 }),
    ev.txnCreate(h(), { txnId: "t1", accountId: "chk", amount: -25000, date: dateIn(M), categoryId: "groc" }),
    ev.txnDelete(h(), { txnId: "t1" }),
    ev.txnEdit(h(), { txnId: "t1", memo: "late edit after delete" }), // must NOT resurrect
  ];
  const s = computeState(events);
  assert.equal(s.balances.chk, 100000);
  assert.equal(s.categoryAvailable.groc, 30000);
  assert.ok(checkInvariant(s).ok);
});

test("uncategorized asset activity flows to/from Ready to Assign (imported txns)", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    // an imported bank expense, not yet categorized (no categoryId)
    ev.txnCreate(h(), { txnId: "imp1", accountId: "chk", amount: -25000, date: dateIn(M), payeeId: "Albert", importId: "2026-07-15|-25000|Albert|chk" }),
  ];
  const s = computeState(events);
  assert.equal(s.balances.chk, 75000);
  assert.equal(s.readyToAssign, 75000);        // 100000 start - 25000 unassigned spend
  assert.ok(checkInvariant(s).ok, JSON.stringify(checkInvariant(s)));
});

test("category targets compute funding need (monthly / balance)", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.categoryCreate(h(), { categoryId: "save", groupId: "g1", name: "Emergency Fund" }),
    ev.categoryTarget(h(), { categoryId: "groc", targetType: "monthly", amount: 50000 }),   // fund 500/mo
    ev.categoryTarget(h(), { categoryId: "save", targetType: "balance", amount: 300000 }),   // reach 3000 available
    ev.assign(h(), { categoryId: "groc", month: M, amount: 30000 }),  // funded 300 of 500
    ev.assign(h(), { categoryId: "save", month: M, amount: 100000 }), // available 1000 of 3000
  ];
  const s = computeState(events);
  assert.equal(s.targetProgress.groc.needed, 20000);   // 500 - 300
  assert.equal(s.targetProgress.groc.onTrack, false);
  assert.equal(s.targetProgress.save.needed, 200000);  // 3000 - 1000
  assert.ok(checkInvariant(s).ok);
  // fully fund groceries -> on track
  const s2 = computeState([...events, ev.assign(h(), { categoryId: "groc", month: M, amount: 20000 })]);
  assert.equal(s2.targetProgress.groc.needed, 0);
  assert.equal(s2.targetProgress.groc.onTrack, true);
});

test("suggestCategory learns merchant->category from the user's history", async () => {
  const { suggestCategory } = await import("@kym/engine");
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.categoryCreate(h(), { categoryId: "dine", groupId: "g1", name: "Dining" }),
    ev.txnCreate(h(), { txnId: "a1", accountId: "chk", amount: -25000, date: dateIn(M), categoryId: "groc", payeeId: "Albert" }),
    ev.txnCreate(h(), { txnId: "a2", accountId: "chk", amount: -18000, date: dateIn(M), categoryId: "groc", payeeId: "Albert Praha" }),
    ev.txnCreate(h(), { txnId: "k1", accountId: "chk", amount: -8000, date: dateIn(M), categoryId: "dine", payeeId: "Kavárna" }),
  ];
  assert.equal(suggestCategory(events, { payee: "Albert" })?.name, "Groceries");
  assert.equal(suggestCategory(events, { payee: "Kavárna Praha" })?.name, "Dining"); // either-contains match
  assert.equal(suggestCategory(events, { payee: "Unknown Shop" }), null);
});

test("income to Ready-to-Assign inflow feeds the pool", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 0, startDate: dateIn(M) }),
    ev.txnCreate(h(), { txnId: "pay", accountId: "chk", amount: 500000, date: dateIn(M), categoryId: RTA_INFLOW }),
  ];
  const s = computeState(events);
  assert.equal(s.readyToAssign, 500000);
  assert.equal(s.balances.chk, 500000);
  assert.ok(checkInvariant(s).ok);
});

// --- category / group lifecycle (parity with kym_core: delete / archive) -----

test("category.delete removes an empty category and its plan entries", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.groupCreate(h(), { groupId: "g1", name: "Everyday" }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.categoryCreate(h(), { categoryId: "oops", groupId: "g1", name: "Oops" }),
    ev.categoryDelete(h(), { categoryId: "oops" }),
  ];
  const s = computeState(events);
  assert.equal(s.categories.find((c) => c.id === "oops"), undefined, "deleted category is gone");
  assert.ok(s.categories.find((c) => c.id === "groc"), "sibling survives");
  assert.ok(checkInvariant(s).ok, JSON.stringify(checkInvariant(s)));
});

test("category.archive hides but keeps history; unarchive restores; balances unaffected", () => {
  const h = mk("A");
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(h(), { categoryId: "sub", groupId: "g1", name: "Old subscription" }),
    ev.assign(h(), { categoryId: "sub", month: M, amount: 5000 }),
    ev.txnCreate(h(), { txnId: "t1", accountId: "chk", amount: -5000, date: dateIn(M), categoryId: "sub" }),
    ev.categoryArchive(h(), { categoryId: "sub" }),
  ];
  const s = computeState(events);
  assert.deepEqual(s.archivedCategories, ["sub"]);
  assert.equal(s.categories.find((c) => c.id === "sub").archived, true, "flagged archived");
  assert.equal(s.categoryAvailable.sub, 0, "history kept — available still 0");
  assert.ok(checkInvariant(s).ok, JSON.stringify(checkInvariant(s)));

  const s2 = computeState([...events, ev.categoryUnarchive(h(), { categoryId: "sub" })]);
  assert.deepEqual(s2.archivedCategories, [], "unarchive restores");
  assert.equal(s2.categories.find((c) => c.id === "sub").archived, false);
});

test("group.delete removes an empty group", () => {
  const h = mk("A");
  const events = [
    ev.groupCreate(h(), { groupId: "g1", name: "Everyday" }),
    ev.groupCreate(h(), { groupId: "g2", name: "Stale" }),
    ev.groupDelete(h(), { groupId: "g2" }),
  ];
  const s = computeState(events);
  assert.ok(s.groups.find((g) => g.id === "g1"));
  assert.equal(s.groups.find((g) => g.id === "g2"), undefined);
});

test("an author payload key stamped at commit rides through the fold onto the transaction", () => {
  const h = mk("A");
  const txn = ev.txnCreate(h(), { txnId: "t1", accountId: "chk", amount: -5000, date: dateIn(M), categoryId: "groc" });
  // Attribution is stamped at the commit/append boundary into the payload — exactly
  // how kym_core's pushEvent sets e.s["author"] — NOT via the typed constructor
  // (which drops unknown keys). It then rides the wire + fold as a passthrough key.
  txn.payload.author = "Vašek";
  const events = [
    ev.accountCreate(h(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(h(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    txn,
  ];
  const s = computeState(events);
  const txns = listTransactions(events);
  assert.equal(txns.find((t) => t.txnId === "t1").author, "Vašek");
  assert.ok(checkInvariant(s).ok);
});
