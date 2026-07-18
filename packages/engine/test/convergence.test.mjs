import { test } from "node:test";
import assert from "node:assert/strict";
import { ev, Clock, AccountType } from "@kym/contract";
import { computeState, checkInvariant, mergeEvents } from "@kym/engine";

// Seeded PRNG (mulberry32) — deterministic, reproducible test runs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const M = "2026-07";
const dateIn = () => `${M}-15T12:00:00Z`;
const CATS = ["groc", "dine", "fun", "gas"];

// A shared, agreed base every device starts from (created by device "S").
function baseEvents() {
  let t = 1_000_000;
  const c = new Clock("S", () => t++);
  const out = [
    ev.accountCreate(c.send(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 1_000_000, startDate: dateIn() }),
    ev.groupCreate(c.send(), { groupId: "g1", name: "Everyday" }),
  ];
  for (const id of CATS) out.push(ev.categoryCreate(c.send(), { categoryId: id, groupId: "g1", name: id }));
  return out;
}

// One device authoring a random offline sequence of plan + ledger edits.
function deviceStream(dev, seed, base) {
  const rand = rng(seed);
  // each device's wall clock drifts independently (they are offline)
  let t = 2_000_000 + Math.floor(rand() * 1000);
  const clock = new Clock(dev, () => t++);
  // Prime the clock with the base so causally-later events sort after the base.
  for (const b of base) clock.receive(b.hlc);
  const events = [];
  const n = 6 + Math.floor(rand() * 8);
  let txn = 0;
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.4) {
      const cat = CATS[Math.floor(rand() * CATS.length)];
      events.push(ev.assign(clock.send(), { categoryId: cat, month: M, amount: 1000 * (1 + Math.floor(rand() * 50)) }));
    } else if (r < 0.6) {
      const from = CATS[Math.floor(rand() * CATS.length)];
      let to = CATS[Math.floor(rand() * CATS.length)];
      if (to === from) to = CATS[(CATS.indexOf(from) + 1) % CATS.length];
      events.push(ev.move(clock.send(), { fromCategoryId: from, toCategoryId: to, month: M, amount: 1000 * (1 + Math.floor(rand() * 10)) }));
    } else {
      const cat = CATS[Math.floor(rand() * CATS.length)];
      events.push(ev.txnCreate(clock.send(), { txnId: `${dev}-t${txn++}`, accountId: "chk", amount: -1000 * (1 + Math.floor(rand() * 30)), date: dateIn(), categoryId: cat }));
    }
  }
  return events;
}

test("concurrent offline edits from N devices converge to identical state + hold the invariant", () => {
  for (let trial = 0; trial < 200; trial++) {
    const base = baseEvents();
    const devices = ["A", "B", "C"].map((d, i) => deviceStream(d, trial * 13 + i * 101 + 1, base));
    const all = [base, ...devices].flat();

    // Reference fold.
    const ref = computeState(all);
    const refInv = checkInvariant(ref);
    assert.ok(refInv.ok, `trial ${trial}: invariant broke — ${JSON.stringify(refInv)}`);

    // Fold several random arrival orders (+ duplicates) — all must match the reference.
    const rand = rng(trial * 7 + 3);
    for (let k = 0; k < 3; k++) {
      const withDupes = shuffle([...all, ...shuffle(all, rand).slice(0, 5)], rand); // reorder + redeliver 5
      const s = computeState(withDupes);
      assert.equal(s.eventCount, ref.eventCount, `trial ${trial}: dedup mismatch`);
      assert.deepEqual(s.balances, ref.balances, `trial ${trial}: balances diverged`);
      assert.deepEqual(s.categoryAvailable, ref.categoryAvailable, `trial ${trial}: available diverged`);
      assert.equal(s.readyToAssign, ref.readyToAssign, `trial ${trial}: RTA diverged`);
      assert.deepEqual(s.creditCardPayments, ref.creditCardPayments, `trial ${trial}: CCP diverged`);
    }
  }
});

test("merge is idempotent — redelivering the whole log changes nothing", () => {
  const base = baseEvents();
  const a = deviceStream("A", 42, base);
  const once = computeState([base, a].flat());
  const twice = computeState(mergeEvents([base, a].flat(), [base, a].flat(), a));
  assert.deepEqual(twice.balances, once.balances);
  assert.deepEqual(twice.categoryAvailable, once.categoryAvailable);
  assert.equal(twice.readyToAssign, once.readyToAssign);
  assert.equal(twice.eventCount, once.eventCount);
});
