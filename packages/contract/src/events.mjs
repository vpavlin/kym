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
  CATEGORY_TARGET: "category.target",
  TXN_CREATE: "txn.create",
  TXN_EDIT: "txn.edit",
  TXN_DELETE: "txn.delete",
  ASSIGN: "assign",
  MOVE: "move",
};

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
};
