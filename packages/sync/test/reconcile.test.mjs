import { test } from "node:test";
import assert from "node:assert/strict";
import { ev, Clock } from "@kym/contract";
import { computeState, checkInvariant, mergeEvents } from "@kym/engine";
import { reconcile, eventsToSend } from "@kym/sync";

// Seeded PRNG so runs are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A pool of distinct events with monotonically increasing HLCs (stable ids).
function makePool(n) {
  const c = new Clock("gen");
  const pool = [];
  for (let i = 0; i < n; i++) {
    pool.push(ev.assign(c.send(), { categoryId: "groc", month: "2026-07", amount: 1000 }, `e${i}`));
  }
  return pool;
}

// The reference: symmetric difference computed the naive way.
function symDiff(a, b) {
  const ai = new Set(a.map((e) => e.id));
  const bi = new Set(b.map((e) => e.id));
  return {
    aNeeds: b.filter((e) => !ai.has(e.id)).map((e) => e.id).sort(),
    bNeeds: a.filter((e) => !bi.has(e.id)).map((e) => e.id).sort(),
  };
}
const sorted = (xs) => [...xs].sort();

test("reconcile finds the exact symmetric difference (identical sets → nothing)", () => {
  const pool = makePool(50);
  const r = reconcile(pool, pool);
  assert.deepEqual(r.aNeeds, []);
  assert.deepEqual(r.bNeeds, []);
});

test("reconcile identifies a missing contiguous tail (the offline-device case)", () => {
  const pool = makePool(200);
  const a = pool.slice(0, 180);   // A missed the last 20 events while offline
  const b = pool;                 // the hub has everything
  const r = reconcile(a, b);
  const ref = symDiff(a, b);
  assert.deepEqual(sorted(r.aNeeds), ref.aNeeds);
  assert.deepEqual(sorted(r.bNeeds), ref.bNeeds);
  assert.equal(r.aNeeds.length, 20);
});

test("reconcile handles two-sided divergence (both hold events the other lacks)", () => {
  const pool = makePool(120);
  const a = pool.filter((_, i) => i % 3 !== 0);   // A lacks every 3rd
  const b = pool.filter((_, i) => i % 5 !== 0);   // B lacks every 5th
  const r = reconcile(a, b);
  const ref = symDiff(a, b);
  assert.deepEqual(sorted(r.aNeeds), ref.aNeeds);
  assert.deepEqual(sorted(r.bNeeds), ref.bNeeds);
});

test("after transferring only the diff, both sides converge to identical state + invariant", () => {
  // Build a real, invariant-holding budget, then split its log between two peers.
  const c = new Clock("h");
  const base = [
    ev.accountCreate(c.send(), { accountId: "chk", name: "Checking", accountType: "checking", startingBalance: 100000, startDate: "2026-07-01T00:00:00Z" }),
    ev.categoryCreate(c.send(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.categoryCreate(c.send(), { categoryId: "dine", groupId: "g1", name: "Dining" }),
    ev.assign(c.send(), { categoryId: "groc", month: "2026-07", amount: 30000 }),
    ev.txnCreate(c.send(), { txnId: "t1", accountId: "chk", amount: -12000, date: "2026-07-05T00:00:00Z", categoryId: "groc" }),
    ev.assign(c.send(), { categoryId: "dine", month: "2026-07", amount: 20000 }),
    ev.txnCreate(c.send(), { txnId: "t2", accountId: "chk", amount: -8000, date: "2026-07-06T00:00:00Z", categoryId: "dine" }),
  ];
  // A has the first 5, B has all 7 but is missing #4 (index 3). Cross-divergent.
  const a = [base[0], base[1], base[2], base[4], base[6]];
  const b = [base[0], base[1], base[2], base[3], base[5], base[6]];

  const r = reconcile(a, b);
  const aFull = mergeEvents(a, eventsToSend(b, r.aNeeds));
  const bFull = mergeEvents(b, eventsToSend(a, r.bNeeds));

  // Same id-set on both sides now.
  assert.deepEqual(sorted(aFull.map((e) => e.id)), sorted(bFull.map((e) => e.id)));
  // Identical computed budget, and it equals the full-log fold.
  const full = computeState(base);
  assert.deepEqual(computeState(aFull).categoryAvailable, full.categoryAvailable);
  assert.deepEqual(computeState(bFull).categoryAvailable, full.categoryAvailable);
  assert.ok(checkInvariant(computeState(aFull)).ok);
});

test("property: 200 random divergences → exact diff every time", () => {
  const rand = rng(1234);
  const pool = makePool(300);
  for (let trial = 0; trial < 200; trial++) {
    const a = pool.filter(() => rand() > 0.15);   // drop ~15% each side, independently
    const b = pool.filter(() => rand() > 0.15);
    const r = reconcile(a, b, { threshold: 4, buckets: 8 });
    const ref = symDiff(a, b);
    assert.deepEqual(sorted(r.aNeeds), ref.aNeeds, `trial ${trial} aNeeds`);
    assert.deepEqual(sorted(r.bNeeds), ref.bNeeds, `trial ${trial} bNeeds`);
    // And transferring the diff converges the id-sets.
    const aFull = mergeEvents(a, eventsToSend(b, r.aNeeds)).map((e) => e.id).sort();
    const bFull = mergeEvents(b, eventsToSend(a, r.bNeeds)).map((e) => e.id).sort();
    assert.deepEqual(aFull, bFull, `trial ${trial} converged`);
  }
});

test("bandwidth: near-synced peers cost far less than resend-all", () => {
  const pool = makePool(1000);
  const a = pool.slice(0, 995);   // A is missing 5 events out of 1000
  const b = pool;
  const r = reconcile(a, b);
  assert.equal(r.aNeeds.length, 5);

  // Resend-all would ship all 1000 events; reconciliation ships control bytes +
  // only the 5 missing events. Estimate wire bytes at ~150 B/event.
  const EVENT_BYTES = 150;
  const resendAll = pool.length * EVENT_BYTES;
  const reconcileCost = r.controlBytes + r.aNeeds.length * EVENT_BYTES;
  assert.ok(
    reconcileCost < resendAll / 5,
    `reconcile ${reconcileCost} should be « resend-all ${resendAll} (rounds=${r.rounds}, control=${r.controlBytes})`
  );
});
