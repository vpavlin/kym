// Golden-vector generator for the KYM engine drift guard.
//
// Regenerates packages/engine/test/fixtures/golden.json — the committed set of
// (event log -> expected budget state) vectors that lock the engine fold so any
// accidental change to computeState/checkInvariant is a failing test (and, since
// the C++ module mirrors the same fold, a drift signal for the port too).
//
// The `expect` values are NOT hand-written: each scenario builds its events with
// the @kym/contract `ev.*` constructors under a deterministic clock (stable ids
// + HLCs, so the file is reproducible byte-for-byte) and then GENERATES `expect`
// by actually running computeState/checkInvariant. So the fixture always reflects
// the engine's real current output. When the engine legitimately changes, rerun:
//
//     node packages/engine/test/golden.gen.mjs
//
// then review the diff and commit it. See the regen note in golden.test.mjs.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ev, Clock, RTA_INFLOW, ccpCategoryId, AccountType } from "@kym/contract";
import { computeState, checkInvariant } from "@kym/engine";

const M = "2026-07";
const M2 = "2026-08";
const dateIn = (m) => `${m}-15T12:00:00Z`;

// A deterministic clock+id factory per scenario so events (HLCs + ids) are stable
// across regenerations. `dev` seeds both the HLC device and the id prefix.
function device(dev, start = 1_000_000) {
  let t = start;
  const clock = new Clock(dev, () => t++);
  let n = 0;
  return {
    clock,
    id: () => `${dev}-e${n++}`,
    hlc: () => clock.send(),
  };
}

// Build the four (or five) expect fields by folding the events for real.
function expectOf(events, extra = []) {
  const s = computeState(events);
  const exp = {
    balances: s.balances,
    categoryAvailable: s.categoryAvailable,
    readyToAssign: s.readyToAssign,
    invariantOk: checkInvariant(s).ok,
  };
  // Some scenarios lock extra derived projections (e.g. credit-card payments).
  for (const k of extra) exp[k] = s[k];
  return exp;
}

const scenarios = [];
function add(name, events, extra) {
  scenarios.push({ name, events, expect: expectOf(events, extra) });
}

// 1) Clean single-category budget.
{
  const A = device("cln");
  add("clean single-category budget", [
    ev.accountCreate(A.hlc(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }, A.id()),
    ev.groupCreate(A.hlc(), { groupId: "g1", name: "Everyday" }, A.id()),
    ev.categoryCreate(A.hlc(), { categoryId: "groc", groupId: "g1", name: "Groceries" }, A.id()),
    ev.assign(A.hlc(), { categoryId: "groc", month: M, amount: 30000 }, A.id()),
    ev.txnCreate(A.hlc(), { txnId: "t1", accountId: "chk", amount: -25000, date: dateIn(M), categoryId: "groc" }, A.id()),
  ]);
}

// 2) The §9 two-device convergence scenario (both offline, then merged).
{
  // A shared base both devices already agree on.
  const S = device("seed");
  const base = [
    ev.accountCreate(S.hlc(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }, S.id()),
    ev.groupCreate(S.hlc(), { groupId: "g1", name: "Everyday" }, S.id()),
    ev.categoryCreate(S.hlc(), { categoryId: "groc", groupId: "g1", name: "Groceries" }, S.id()),
    ev.categoryCreate(S.hlc(), { categoryId: "dine", groupId: "g1", name: "Dining" }, S.id()),
  ];
  // Two devices author offline; each primes its clock from the shared base.
  const A = device("A", 2_000_000);
  const B = device("B", 3_000_000);
  for (const e of base) { A.clock.receive(e.hlc); B.clock.receive(e.hlc); }
  const aStream = [
    ev.assign(A.hlc(), { categoryId: "groc", month: M, amount: 60000 }, A.id()),
    ev.txnCreate(A.hlc(), { txnId: "A1", accountId: "chk", amount: -25000, date: dateIn(M), categoryId: "groc" }, A.id()),
  ];
  const bStream = [
    ev.assign(B.hlc(), { categoryId: "dine", month: M, amount: 40000 }, B.id()),
    ev.txnCreate(B.hlc(), { txnId: "B1", accountId: "chk", amount: -30000, date: dateIn(M), categoryId: "dine" }, B.id()),
    ev.move(B.hlc(), { fromCategoryId: "groc", toCategoryId: "dine", month: M, amount: 10000 }, B.id()),
  ];
  // The merged union of all six events — the fold is order-independent.
  add("two-device convergence (data-model.md §9)", [...base, ...aStream, ...bStream]);
}

// 3) Funded credit-card purchase — money relocates into the card's ccp: category.
{
  const A = device("cc");
  add("funded credit-card purchase relocates into ccp payment category", [
    ev.accountCreate(A.hlc(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }, A.id()),
    ev.accountCreate(A.hlc(), { accountId: "visa", name: "Visa", accountType: AccountType.CREDIT_CARD, startingBalance: 0, startDate: dateIn(M) }, A.id()),
    ev.groupCreate(A.hlc(), { groupId: "g1", name: "Everyday" }, A.id()),
    ev.categoryCreate(A.hlc(), { categoryId: "groc", groupId: "g1", name: "Groceries" }, A.id()),
    ev.assign(A.hlc(), { categoryId: "groc", month: M, amount: 30000 }, A.id()),
    // Charge $25 of groceries to the card — activity on groc, debt on visa, and
    // $25 relocated into ccp:visa (see the § payment category id).
    ev.txnCreate(A.hlc(), { txnId: "t1", accountId: "visa", amount: -25000, date: dateIn(M), categoryId: "groc" }, A.id()),
  ], ["creditCardPayments"]);
  // sanity: the ccp id we intend to lock exists as a key.
  if (ccpCategoryId("visa") !== "ccp:visa") throw new Error("ccpCategoryId drift");
}

// 4) Split transaction fanning out across two categories.
{
  const A = device("spl");
  add("split transaction fans out to two categories", [
    ev.accountCreate(A.hlc(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }, A.id()),
    ev.groupCreate(A.hlc(), { groupId: "g1", name: "Everyday" }, A.id()),
    ev.categoryCreate(A.hlc(), { categoryId: "groc", groupId: "g1", name: "Groceries" }, A.id()),
    ev.categoryCreate(A.hlc(), { categoryId: "home", groupId: "g1", name: "Household" }, A.id()),
    ev.assign(A.hlc(), { categoryId: "groc", month: M, amount: 40000 }, A.id()),
    ev.assign(A.hlc(), { categoryId: "home", month: M, amount: 40000 }, A.id()),
    ev.txnCreate(A.hlc(), { txnId: "t1", accountId: "chk", amount: -30000, date: dateIn(M),
      splits: [{ categoryId: "groc", amount: -18000 }, { categoryId: "home", amount: -12000 }] }, A.id()),
  ]);
}

// 5) Cash overspend rolls off to next month's Ready-to-Assign.
{
  const A = device("ovr");
  // July: assign 20000, spend 45000 cash -> -25000. A zero-assign in August makes
  // August the current month, so the -25000 rolls off (category resets toward 0)
  // and the overspend is charged to Ready to Assign.
  add("cash overspend rolls off to next month RTA", [
    ev.accountCreate(A.hlc(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }, A.id()),
    ev.groupCreate(A.hlc(), { groupId: "g1", name: "Everyday" }, A.id()),
    ev.categoryCreate(A.hlc(), { categoryId: "groc", groupId: "g1", name: "Groceries" }, A.id()),
    ev.assign(A.hlc(), { categoryId: "groc", month: M, amount: 20000 }, A.id()),
    ev.txnCreate(A.hlc(), { txnId: "t1", accountId: "chk", amount: -45000, date: dateIn(M), categoryId: "groc" }, A.id()),
    ev.assign(A.hlc(), { categoryId: "groc", month: M2, amount: 0 }, A.id()),
  ]);
}

// 6) Income posted to rta-inflow feeds the Ready-to-Assign pool.
{
  const A = device("inc");
  add("income to rta-inflow feeds Ready to Assign", [
    ev.accountCreate(A.hlc(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 0, startDate: dateIn(M) }, A.id()),
    ev.txnCreate(A.hlc(), { txnId: "pay", accountId: "chk", amount: 500000, date: dateIn(M), categoryId: RTA_INFLOW }, A.id()),
  ]);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "fixtures");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "golden.json");
writeFileSync(outFile, JSON.stringify(scenarios, null, 2) + "\n");
console.log(`wrote ${scenarios.length} golden scenarios -> ${outFile}`);
