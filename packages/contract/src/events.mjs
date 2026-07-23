// KYM event log. Every change is an immutable event. Edits are superseding
// events; deletes are tombstones. Merging = union by `id`. See docs/data-model.md.
import { randomUUID } from "node:crypto";

/** @typedef {import('./hlc.mjs').HLC} HLC */

export const EventType = {
  GROUP_CREATE: "group.create",
  ACCOUNT_CREATE: "account.create",
  ACCOUNT_EDIT: "account.edit",
  CATEGORY_CREATE: "category.create",
  CATEGORY_EDIT: "category.edit",
  CATEGORY_DELETE: "category.delete",       // remove an empty category (no assignments/txns)
  CATEGORY_ARCHIVE: "category.archive",     // hide a category with history (kept, must be emptied first)
  CATEGORY_UNARCHIVE: "category.unarchive", // restore an archived category
  CATEGORY_TARGET: "category.target",
  GROUP_DELETE: "group.delete",             // remove an empty group (no categories)
  TXN_CREATE: "txn.create",
  TXN_EDIT: "txn.edit",
  TXN_DELETE: "txn.delete",
  ASSIGN: "assign",
  MOVE: "move",
  // --- group budgets (opt-in): membership + roles ---
  GROUP_INIT: "group.init",     // turns a budget into a group; author = founding admin
  MEMBER_ADD: "member.add",     // admin adds a member with a role
  MEMBER_ROLE: "member.role",   // admin changes a member's role
  MEMBER_REMOVE: "member.remove", // admin removes a member (soft; MLS rekey is later)
};

/** Group roles, most→least privileged. editor+ may change the budget; admin also manages members. */
export const Role = { ADMIN: "admin", EDITOR: "editor", VIEWER: "viewer" };

export const AccountType = {
  CHECKING: "checking",
  SAVINGS: "savings",
  CASH: "cash",
  CREDIT_CARD: "creditCard",
  LINE_OF_CREDIT: "lineOfCredit",
  TRACKING: "tracking",
};

export const ASSET_TYPES = new Set([AccountType.CHECKING, AccountType.SAVINGS, AccountType.CASH]);
export const CREDIT_TYPES = new Set([AccountType.CREDIT_CARD, AccountType.LINE_OF_CREDIT]);

/** The system pseudo-category that income flows into (feeds Ready to Assign). */
export const RTA_INFLOW = "rta-inflow";
/** Per-credit-card payment category id. */
export const ccpCategoryId = (accountId) => `ccp:${accountId}`;
export const isCcp = (categoryId) => typeof categoryId === "string" && categoryId.startsWith("ccp:");

/** `YYYY-MM` bucket for a date (ISO string or epoch ms). */
export function monthOf(date) {
  const d = typeof date === "number" ? new Date(date) : new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Build an event. `hlc` and `dev` come from the authoring device's Clock.
 * `id` is auto-generated (UUIDv4) unless supplied (tests pass stable ids).
 * @param {string} type @param {HLC} hlc @param {object} payload
 */
export function makeEvent(type, hlc, payload, id = randomUUID()) {
  if (!hlc || typeof hlc.dev !== "string") throw new Error("event requires an HLC with a dev");
  return { v: 1, id, type, hlc, dev: hlc.dev, payload };
}

// Typed constructors — thin sugar over makeEvent, documenting each payload shape.
export const ev = {
  groupCreate: (hlc, { groupId, name }, id) =>
    makeEvent(EventType.GROUP_CREATE, hlc, { groupId, name }, id),

  accountCreate: (hlc, { accountId, name, accountType, onBudget = true, startingBalance = 0, startDate, currency }, id) =>
    makeEvent(EventType.ACCOUNT_CREATE, hlc, { accountId, name, accountType, onBudget, startingBalance, startDate, currency }, id),

  accountEdit: (hlc, { accountId, name, closed }, id) =>
    makeEvent(EventType.ACCOUNT_EDIT, hlc, { accountId, name, closed }, id),

  categoryCreate: (hlc, { categoryId, groupId, name }, id) =>
    makeEvent(EventType.CATEGORY_CREATE, hlc, { categoryId, groupId, name }, id),

  categoryEdit: (hlc, { categoryId, groupId, name, hidden }, id) =>
    makeEvent(EventType.CATEGORY_EDIT, hlc, { categoryId, groupId, name, hidden }, id),

  // Remove an EMPTY category (kym_core only emits this when it has no assignments
  // or transactions, so no money is orphaned). Wire-compatible with the C++ core.
  categoryDelete: (hlc, { categoryId }, id) =>
    makeEvent(EventType.CATEGORY_DELETE, hlc, { categoryId }, id),

  // Archive / restore a category WITH history: hidden from the active list but every
  // transaction/assignment is kept. kym_core requires its Available to be 0 first.
  categoryArchive: (hlc, { categoryId }, id) =>
    makeEvent(EventType.CATEGORY_ARCHIVE, hlc, { categoryId }, id),
  categoryUnarchive: (hlc, { categoryId }, id) =>
    makeEvent(EventType.CATEGORY_UNARCHIVE, hlc, { categoryId }, id),

  // Remove an EMPTY group (no categories left in it).
  groupDelete: (hlc, { groupId }, id) =>
    makeEvent(EventType.GROUP_DELETE, hlc, { groupId }, id),

  // A funding target for a category. targetType ∈ 'monthly' (fund `amount` each
  // month) | 'balance' (reach `amount` available) | 'balanceByDate' (reach
  // `amount` available by `targetMonth`). amount=0 clears the target.
  categoryTarget: (hlc, { categoryId, targetType, amount, targetMonth }, id) =>
    makeEvent(EventType.CATEGORY_TARGET, hlc, { categoryId, targetType, amount, targetMonth }, id),

  // A transaction. Either `categoryId` OR `splits:[{categoryId, amount}]` (summing to amount).
  // `importId` is an import-dedup fingerprint (date+amount+payee+account) for rows
  // pulled from a bank export that lack our UUID; ignored by the fold.
  txnCreate: (hlc, { txnId, accountId, amount, date, payeeId, categoryId, splits, cleared = "uncleared", approved = true, memo, transferId, importId }, id) =>
    makeEvent(EventType.TXN_CREATE, hlc, { txnId, accountId, amount, date, payeeId, categoryId, splits, cleared, approved, memo, transferId, importId }, id),

  txnEdit: (hlc, { txnId, ...fields }, id) =>
    makeEvent(EventType.TXN_EDIT, hlc, { txnId, ...fields }, id),

  txnDelete: (hlc, { txnId }, id) =>
    makeEvent(EventType.TXN_DELETE, hlc, { txnId }, id),

  // Assign to a category-month. mode 'delta' adds (commutative); 'set' is absolute (LWW by HLC).
  assign: (hlc, { categoryId, month, amount, mode = "delta" }, id) =>
    makeEvent(EventType.ASSIGN, hlc, { categoryId, month, amount, mode }, id),

  // Net-zero move of budgeted money between two category-months.
  move: (hlc, { fromCategoryId, toCategoryId, month, amount }, id) =>
    makeEvent(EventType.MOVE, hlc, { fromCategoryId, toCategoryId, month, amount }, id),

  // --- group budgets. The event's author is hlc.dev (a member id). ---
  // Turn this budget into a group; the author (or founderId) becomes the founding admin.
  groupInit: (hlc, { name, founderId, founderName } = {}, id) =>
    makeEvent(EventType.GROUP_INIT, hlc, { name, founderId, founderName }, id),
  memberAdd: (hlc, { memberId, name, role }, id) =>
    makeEvent(EventType.MEMBER_ADD, hlc, { memberId, name, role }, id),
  memberRole: (hlc, { memberId, role }, id) =>
    makeEvent(EventType.MEMBER_ROLE, hlc, { memberId, role }, id),
  memberRemove: (hlc, { memberId }, id) =>
    makeEvent(EventType.MEMBER_REMOVE, hlc, { memberId }, id),
};
