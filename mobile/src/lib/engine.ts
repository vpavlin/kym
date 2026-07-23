// Single place the app touches the SHARED packages. Everything the UI needs from
// `@kym/contract` / `@kym/engine` is re-exported here so screens import from one
// typed module and the "does the phone run the same engine as desktop?" seam is
// obvious. The runtime files are ../../packages/*/src/*.mjs, resolved by Metro
// (see metro.config.js) and typed by types/kym-shared.d.ts.
export {
  computeState,
  checkInvariant,
  mergeEvents,
  suggestCategory,
  netWorth,
  spendingReport,
} from "@kym/engine";
export type {
  BudgetState,
  CategoryMonth,
  CategoryView,
  AccountView,
  Invariant,
  CategorySuggestion,
} from "@kym/engine";

export {
  Clock,
  ev,
  EventType,
  AccountType,
  RTA_INFLOW,
  ccpCategoryId,
  isCcp,
  monthOf,
  toMilli,
  fromMilli,
  formatMoney,
  CURRENCIES,
  DEFAULT_CURRENCY,
  Role,
} from "@kym/contract";
export type { KymEvent, HLC, Money } from "@kym/contract";
export type { Member } from "@kym/engine";
