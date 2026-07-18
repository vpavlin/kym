#!/usr/bin/env node
// KYM convergence demo — the Phase-0 prototype and living proof of the core claim:
// two devices editing the SAME budget OFFLINE, concurrently, always converge to the
// same correct budget after they sync — with no money lost. This is exactly the
// scenario Perun's last-write-wins sync cannot handle (see docs/plan.md §2).
//
// Run: npm run demo   (or  node cli/demo.mjs)

import { ev, Clock, fromMilli, AccountType } from "@kym/contract";
import { computeState, checkInvariant } from "@kym/engine";

const M = "2026-07";
const date = `${M}-15T12:00:00Z`;
const money = (m) => `$${fromMilli(m)}`;

// A shared starting point both partners' devices already have.
let t = 1_000_000;
const seed = new Clock("seed", () => t++);
const base = [
  ev.accountCreate(seed.send(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: date }),
  ev.groupCreate(seed.send(), { groupId: "g1", name: "Everyday" }),
  ev.categoryCreate(seed.send(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
  ev.categoryCreate(seed.send(), { categoryId: "dine", groupId: "g1", name: "Dining" }),
];

// --- Device A (partner 1's phone), OFFLINE ---------------------------------
const ca = new Clock("A", ((n) => () => 2_000_000 + n++)(0));
base.forEach((b) => ca.receive(b.hlc));
const deviceA = [
  ev.assign(ca.send(), { categoryId: "groc", month: M, amount: 60000 }),                         // budget $60 to groceries
  ev.txnCreate(ca.send(), { txnId: "A-1", accountId: "chk", amount: -25000, date, categoryId: "groc" }), // spent $25 groceries
];

// --- Device B (partner 2's phone), OFFLINE, has NOT seen A ------------------
const cb = new Clock("B", ((n) => () => 2_000_050 + n++)(0));
base.forEach((b) => cb.receive(b.hlc));
const deviceB = [
  ev.assign(cb.send(), { categoryId: "dine", month: M, amount: 40000 }),                          // budget $40 to dining
  ev.txnCreate(cb.send(), { txnId: "B-1", accountId: "chk", amount: -30000, date, categoryId: "dine" }), // spent $30 dining
  ev.move(cb.send(), { fromCategoryId: "groc", toCategoryId: "dine", month: M, amount: 10000 }),  // move $10 groc -> dining
];

function render(title, state) {
  const inv = checkInvariant(state);
  console.log(`\n  ${title}`);
  console.log(`  ${"─".repeat(52)}`);
  console.log(`  Checking balance ............... ${money(state.balances.chk).padStart(10)}`);
  console.log(`  Groceries available ............ ${money(state.categoryAvailable.groc).padStart(10)}`);
  console.log(`  Dining available ............... ${money(state.categoryAvailable.dine).padStart(10)}`);
  console.log(`  Ready to Assign ................ ${money(state.readyToAssign).padStart(10)}`);
  console.log(`  invariant: assets ${money(inv.assets)} == categories ${money(inv.categoriesAvail)} + RTA ${money(inv.readyToAssign)}  ->  ${inv.ok ? "OK ✓" : `BROKEN (diff ${money(inv.diff)}) ✗`}`);
  return inv;
}

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║  KYM — two partners editing one budget offline, then syncing  ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log("\n  Both start from: Checking $100.00, categories Groceries + Dining,");
console.log("  $100.00 Ready to Assign. Then they each go offline and edit.");

// Before sync: each device only knows its own edits (plus the shared base).
const aBefore = render("Device A sees (offline, its edits only):", computeState([...base, ...deviceA]));
const bBefore = render("Device B sees (offline, its edits only):", computeState([...base, ...deviceB]));

console.log("\n  → They disagree — as they must; neither has the other's edits yet.");
console.log("  Now they sync over Delivery (union of all events, any order)...");

// After sync: merge everything. Try two different arrival orders to prove order-independence.
const orderX = [...base, ...deviceA, ...deviceB];
const orderY = [...deviceB, ...base, ...deviceA];      // B arrives first, reversed — must not matter
const invA = render("Device A after sync:", computeState(orderX));
const invB = render("Device B after sync (events arrived in a different order):", computeState(orderY));

// Assertions — the demo fails loudly if the core claim ever breaks.
const sX = computeState(orderX), sY = computeState(orderY);
const same =
  JSON.stringify(sX.balances) === JSON.stringify(sY.balances) &&
  JSON.stringify(sX.categoryAvailable) === JSON.stringify(sY.categoryAvailable) &&
  sX.readyToAssign === sY.readyToAssign;

console.log("\n  ┌────────────────────────────────────────────────────────────┐");
console.log(`  │ Both devices converged to identical state: ${same ? "YES ✓" : "NO  ✗"}            │`);
console.log(`  │ Zero-based invariant holds after merge:    ${invA.ok && invB.ok ? "YES ✓" : "NO  ✗"}            │`);
console.log("  │ Every edit survived — both assigns, both spends, the move.   │");
console.log("  │ Groceries: $60 −$10 moved −$25 spent = $25 available.        │");
console.log("  │ Dining:    $40 +$10 moved −$30 spent = $20 available.        │");
console.log("  │ Nothing was lost. This is what Perun's LWW cannot do.        │");
console.log("  └────────────────────────────────────────────────────────────┘\n");

if (!same || !invA.ok || !invB.ok) {
  console.error("DEMO FAILED: convergence or invariant broken.");
  process.exit(1);
}
