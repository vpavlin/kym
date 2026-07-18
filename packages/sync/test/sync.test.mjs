import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ev, Clock, AccountType } from "@kym/contract";
import { SyncNode, newSecret, deriveIdentity, topicFor, seal, encodeEvent } from "@kym/sync";

// A mock Logos Delivery bus: publish drops a {topic, sealed} message; a peer
// subscribed to that topic receives it. Store lets a late joiner replay history.
class MockDelivery {
  constructor() { this.msgs = []; this.subs = []; }
  publish(topic, sealed) {
    this.msgs.push({ topic, sealed });
    for (const s of this.subs) if (s.topic === topic) s.fn(sealed);
  }
  subscribe(topic, fn) { this.subs.push({ topic, fn }); }
  replay(topic, fn) { for (const m of this.msgs) if (m.topic === topic) fn(m.sealed); }
}

const M = "2026-07";
const d = `${M}-15T12:00:00Z`;

// A shared base both paired devices already have (checking + two categories).
function base() {
  let t = 1_000_000;
  const c = new Clock("seed", () => t++);
  return [
    ev.accountCreate(c.send(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: d, currency: "CZK" }),
    ev.categoryCreate(c.send(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.categoryCreate(c.send(), { categoryId: "dine", groupId: "g1", name: "Dining" }),
  ];
}

test("two paired peers converge through real encryption over a mock Delivery bus", () => {
  const secret = newSecret();
  const bus = new MockDelivery();
  const seed = base();

  const A = new SyncNode(secret, { device: "A", log: seed });
  const B = new SyncNode(secret, { device: "B", log: seed });
  assert.equal(A.topic, B.topic, "same household secret -> same content topic");

  // both subscribe: an inbound sealed message is ingested and re-folded
  bus.subscribe(A.topic, (s) => A.ingest(s));
  bus.subscribe(B.topic, (s) => B.ingest(s));

  // --- both edit OFFLINE (queue sealed messages, don't publish yet) ---
  const offlineA = [
    ev.assign(A.clock.send(), { categoryId: "groc", month: M, amount: 60000 }),
    ev.txnCreate(A.clock.send(), { txnId: "A1", accountId: "chk", amount: -25000, date: d, categoryId: "groc" }),
  ].map((e) => A.append(e)); // append seals + adds to A's own log

  const offlineB = [
    ev.assign(B.clock.send(), { categoryId: "dine", month: M, amount: 40000 }),
    ev.txnCreate(B.clock.send(), { txnId: "B1", accountId: "chk", amount: -30000, date: d, categoryId: "dine" }),
    ev.move(B.clock.send(), { fromCategoryId: "groc", toCategoryId: "dine", month: M, amount: 10000 }),
  ].map((e) => B.append(e));

  // before sync they disagree (each only knows its own edits)
  assert.notDeepEqual(A.state().categoryAvailable, B.state().categoryAvailable);

  // --- come online: publish each peer's sealed messages onto the bus ---
  for (const s of offlineA) bus.publish(A.topic, s);
  for (const s of offlineB) bus.publish(B.topic, s);

  // both converged to the docs/data-model §9 result — through encryption
  for (const [who, N] of [["A", A], ["B", B]]) {
    const st = N.state();
    assert.equal(st.balances.chk, 45000, `${who} checking`);
    assert.equal(st.categoryAvailable.groc, 25000, `${who} groceries`);
    assert.equal(st.categoryAvailable.dine, 20000, `${who} dining`);
    assert.equal(st.readyToAssign, 0, `${who} RTA`);
    assert.ok(N.invariant().ok, `${who} invariant`);
  }
  assert.deepEqual(A.state().balances, B.state().balances);
  assert.deepEqual(A.state().categoryAvailable, B.state().categoryAvailable);
});

test("redelivery is idempotent (Waku Store replays change nothing)", () => {
  const secret = newSecret();
  const bus = new MockDelivery();
  const A = new SyncNode(secret, { device: "A", log: base() });
  const B = new SyncNode(secret, { device: "B", log: base() });
  const msg = A.append(ev.assign(A.clock.send(), { categoryId: "groc", month: M, amount: 12345 }));
  assert.equal(B.ingest(msg), true);          // first delivery: new
  assert.equal(B.ingest(msg), false);         // redelivery: ignored
  assert.equal(B.ingest(msg), false);
  assert.equal(B.state().categoryAvailable.groc, 12345);
  assert.ok(B.invariant().ok);
});

test("a device with the wrong household secret cannot read the traffic", () => {
  const bus = new MockDelivery();
  const A = new SyncNode(newSecret(), { device: "A", log: base() });
  const outsider = new SyncNode(newSecret(), { device: "X", log: base() });
  assert.notEqual(A.topic, outsider.topic, "different secret -> different (unlinkable) topic");
  const sealed = A.append(ev.assign(A.clock.send(), { categoryId: "groc", month: M, amount: 999 }));
  // even handed A's ciphertext on A's topic, the outsider's key can't open it
  assert.throws(() => outsider.ingest(sealed), /./);
});

test("sealed payload is actually ciphertext (no plaintext leak)", () => {
  const id = deriveIdentity(newSecret());
  const topic = topicFor(id);
  const plaintext = encodeEvent(ev.assign({ wall: 1, ctr: 0, dev: "A" }, { categoryId: "groceries-secret", month: M, amount: 5000 }));
  const sealed = seal(id, plaintext, topic);
  const asText = Buffer.from(sealed).toString("latin1");
  assert.ok(!asText.includes("groceries-secret"), "category name must not appear in the ciphertext");
  assert.ok(!asText.includes("assign"), "event type must not appear in the ciphertext");
});
