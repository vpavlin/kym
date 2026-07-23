import { test } from "node:test";
import assert from "node:assert/strict";
import { ev, Role, AccountType } from "@kym/contract";
import { computeState, admitEvents, mergeEvents } from "@kym/engine";

// Shared monotonic tick so events are HLC-ordered by creation order (as real
// HLC would be after receipt), while dev = the authoring member id.
let TICK = 0;
const mk = (dev) => () => ({ wall: 1_000_000 + TICK++, ctr: 0, dev });

const M = "2026-07";
const dateIn = (m) => `${m}-15T12:00:00Z`;

test("without group.init every author is admitted (backward compatible)", () => {
  const a = mk("alice"), b = mk("bob");
  const events = [
    ev.accountCreate(a(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(a(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.assign(b(), { categoryId: "groc", month: M, amount: 30000 }), // bob, a stranger, still counts
  ];
  const s = computeState(events);
  assert.equal(s.isGroup, false);
  assert.equal(s.categoryAvailable.groc, 30000);
});

test("founder is admin; an added editor may change the budget", () => {
  const a = mk("alice"), b = mk("bob");
  const events = [
    ev.groupInit(a(), { name: "Household", founderName: "Alice" }),
    ev.memberAdd(a(), { memberId: "bob", name: "Bob", role: Role.EDITOR }),
    ev.accountCreate(a(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(a(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.assign(b(), { categoryId: "groc", month: M, amount: 30000 }), // bob is an editor → counts
  ];
  const s = computeState(events);
  assert.equal(s.isGroup, true);
  assert.equal(s.categoryAvailable.groc, 30000);
  const roles = Object.fromEntries(s.members.map((m) => [m.id, m.role]));
  assert.equal(roles.alice, Role.ADMIN);
  assert.equal(roles.bob, Role.EDITOR);
});

test("a viewer's budget edits are ignored on merge", () => {
  const a = mk("alice"), c = mk("carol");
  const events = [
    ev.groupInit(a(), { name: "Household" }),
    ev.memberAdd(a(), { memberId: "carol", name: "Carol", role: Role.VIEWER }),
    ev.accountCreate(a(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) }),
    ev.categoryCreate(a(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.assign(c(), { categoryId: "groc", month: M, amount: 30000 }), // carol is a viewer → ignored
    ev.txnCreate(c(), { txnId: "t1", accountId: "chk", amount: -5000, date: dateIn(M), categoryId: "groc" }), // ignored too
  ];
  const s = computeState(events);
  assert.equal(s.categoryAvailable.groc, 0);          // viewer's assign dropped
  assert.equal(s.balances.chk, 100000);               // viewer's txn dropped
});

test("a non-member's events never count", () => {
  const a = mk("alice"), e = mk("eve");
  const events = [
    ev.groupInit(a(), { name: "Household" }),
    ev.categoryCreate(a(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
    ev.assign(e(), { categoryId: "groc", month: M, amount: 99000 }), // eve was never added
  ];
  const s = computeState(events);
  assert.equal(s.categoryAvailable.groc, 0);
});

test("only an admin can manage members; an editor's member.add is ignored", () => {
  const a = mk("alice"), b = mk("bob");
  const events = [
    ev.groupInit(a(), { name: "Household" }),
    ev.memberAdd(a(), { memberId: "bob", name: "Bob", role: Role.EDITOR }),
    ev.memberAdd(b(), { memberId: "mallory", name: "Mallory", role: Role.EDITOR }), // bob is editor, not admin
  ];
  const { members } = admitEvents(events);
  const ids = members.map((m) => m.id).sort();
  assert.deepEqual(ids, ["alice", "bob"]); // mallory never admitted
});

test("promotion then demotion takes effect in HLC order", () => {
  const a = mk("alice"), b = mk("bob");
  // bob starts viewer, gets promoted to editor, assigns, then is demoted back to viewer and assigns again
  const e1 = ev.groupInit(a(), { name: "H" });
  const e2 = ev.memberAdd(a(), { memberId: "bob", role: Role.VIEWER });
  const acct = ev.accountCreate(a(), { accountId: "chk", name: "C", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: dateIn(M) });
  const cat = ev.categoryCreate(a(), { categoryId: "groc", groupId: "g1", name: "Groc" });
  const promote = ev.memberRole(a(), { memberId: "bob", role: Role.EDITOR });
  const asg1 = ev.assign(b(), { categoryId: "groc", month: M, amount: 10000 }); // editor → counts
  const demote = ev.memberRole(a(), { memberId: "bob", role: Role.VIEWER });
  const asg2 = ev.assign(b(), { categoryId: "groc", month: M, amount: 5000 });  // viewer → ignored
  const s = computeState([e1, e2, acct, cat, promote, asg1, demote, asg2]);
  assert.equal(s.categoryAvailable.groc, 10000);
});

test("removing a member drops their subsequent events", () => {
  const a = mk("alice"), b = mk("bob");
  const e1 = ev.groupInit(a(), { name: "H" });
  const e2 = ev.memberAdd(a(), { memberId: "bob", role: Role.EDITOR });
  const cat = ev.categoryCreate(a(), { categoryId: "groc", groupId: "g1", name: "Groc" });
  const asg1 = ev.assign(b(), { categoryId: "groc", month: M, amount: 10000 }); // counts
  const remove = ev.memberRemove(a(), { memberId: "bob" });
  const asg2 = ev.assign(b(), { categoryId: "groc", month: M, amount: 5000 });  // dropped
  const s = computeState([e1, e2, cat, asg1, remove, asg2]);
  assert.equal(s.categoryAvailable.groc, 10000);
  assert.equal(s.members.find((m) => m.id === "bob").active, false);
});

test("admission is order-independent (converges regardless of arrival order)", () => {
  const a = mk("alice"), b = mk("bob");
  const events = [
    ev.groupInit(a(), { name: "H" }),
    ev.memberAdd(a(), { memberId: "bob", role: Role.EDITOR }),
    ev.categoryCreate(a(), { categoryId: "groc", groupId: "g1", name: "Groc" }),
    ev.assign(b(), { categoryId: "groc", month: M, amount: 30000 }),
  ];
  const forward = computeState(events).categoryAvailable.groc;
  const reversed = computeState([...events].reverse()).categoryAvailable.groc;
  assert.equal(forward, reversed);
  assert.equal(forward, 30000);
});
