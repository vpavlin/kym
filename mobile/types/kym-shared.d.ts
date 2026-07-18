// Ambient types for the shared, dependency-free ESM packages (`@kym/contract`,
// `@kym/engine`). The runtime files are plain `.mjs` (JS, no types); Metro
// resolves them via metro.config.js, and these declarations give TypeScript the
// shapes it needs so `tsc --noEmit` passes without pointing the compiler at the
// .mjs sources. Kept in sync by hand — they mirror packages/*/src/*.mjs.

declare module "@kym/contract" {
  export type Money = number; // integer milliunits
  export interface HLC {
    wall: number;
    ctr: number;
    dev: string;
  }
  export type EventKind =
    | "group.create"
    | "account.create"
    | "account.edit"
    | "category.create"
    | "category.edit"
    | "txn.create"
    | "txn.edit"
    | "txn.delete"
    | "assign"
    | "move";
  export interface KymEvent {
    v: 1;
    id: string;
    type: EventKind;
    hlc: HLC;
    dev: string;
    payload: any;
  }

  export const EventType: Record<string, EventKind>;
  export const AccountType: {
    CHECKING: "checking";
    SAVINGS: "savings";
    CASH: "cash";
    CREDIT_CARD: "creditCard";
    LINE_OF_CREDIT: "lineOfCredit";
    TRACKING: "tracking";
  };
  export const ASSET_TYPES: Set<string>;
  export const CREDIT_TYPES: Set<string>;
  export const RTA_INFLOW: string;
  export function ccpCategoryId(accountId: string): string;
  export function isCcp(categoryId: string): boolean;
  export function monthOf(date: string | number): string;

  export class Clock {
    constructor(dev: string, now?: () => number);
    dev: string;
    wall: number;
    ctr: number;
    send(): HLC;
    receive(remote: HLC): HLC;
  }
  export function compareHlc(a: HLC, b: HLC): number;

  export function toMilli(amount: string | number): Money;
  export function fromMilli(milli: Money, opts?: { sign?: boolean }): string;
  export function assertMoney(m: number, ctx?: string): Money;
  export function sumMoney(list: Money[]): Money;

  export interface CurrencySpec {
    code: string;
    symbol: string;
    decimals: number;
    symbolAfter: boolean;
    thousands: string;
    decimal: string;
  }
  export const CURRENCIES: Record<string, CurrencySpec>;
  export const DEFAULT_CURRENCY: string;
  export function formatMoney(
    milli: Money,
    code?: string,
    opts?: { sign?: boolean }
  ): string;

  export function makeEvent(
    type: EventKind,
    hlc: HLC,
    payload: any,
    id?: string
  ): KymEvent;

  export const ev: {
    groupCreate(hlc: HLC, p: { groupId: string; name: string }, id?: string): KymEvent;
    accountCreate(
      hlc: HLC,
      p: {
        accountId: string;
        name: string;
        accountType: string;
        onBudget?: boolean;
        startingBalance?: Money;
        startDate?: string | number;
        currency?: string | null;
      },
      id?: string
    ): KymEvent;
    accountEdit(
      hlc: HLC,
      p: { accountId: string; name?: string; closed?: boolean },
      id?: string
    ): KymEvent;
    categoryCreate(
      hlc: HLC,
      p: { categoryId: string; groupId: string; name: string },
      id?: string
    ): KymEvent;
    categoryEdit(
      hlc: HLC,
      p: { categoryId: string; groupId?: string; name?: string; hidden?: boolean },
      id?: string
    ): KymEvent;
    txnCreate(
      hlc: HLC,
      p: {
        txnId: string;
        accountId: string;
        amount: Money;
        date: string | number;
        payeeId?: string;
        categoryId?: string | null;
        splits?: { categoryId: string; amount: Money }[];
        cleared?: "uncleared" | "cleared" | "reconciled";
        approved?: boolean;
        memo?: string;
        transferId?: string;
      },
      id?: string
    ): KymEvent;
    txnEdit(hlc: HLC, p: { txnId: string; [k: string]: any }, id?: string): KymEvent;
    txnDelete(hlc: HLC, p: { txnId: string }, id?: string): KymEvent;
    assign(
      hlc: HLC,
      p: { categoryId: string; month: string; amount: Money; mode?: "delta" | "set" },
      id?: string
    ): KymEvent;
    move(
      hlc: HLC,
      p: {
        fromCategoryId: string;
        toCategoryId: string;
        month: string;
        amount: Money;
      },
      id?: string
    ): KymEvent;
  };
}

declare module "@kym/contract/money" {
  export type Money = number;
  export function toMilli(amount: string | number): Money;
  export function fromMilli(milli: Money, opts?: { sign?: boolean }): string;
  export function assertMoney(m: number, ctx?: string): Money;
  export function sumMoney(list: Money[]): Money;
}

declare module "@kym/contract/hlc" {
  import type { HLC } from "@kym/contract";
  export function compareHlc(a: HLC, b: HLC): number;
  export class Clock {
    constructor(dev: string, now?: () => number);
    send(): HLC;
    receive(remote: HLC): HLC;
  }
}

declare module "@kym/engine" {
  import type { KymEvent, Money } from "@kym/contract";

  export interface AccountView {
    id: string;
    name: string;
    type: string;
    onBudget: boolean;
    closed: boolean;
    startingBalance: Money;
    currency: string | null;
  }
  export interface GroupView {
    id: string;
    name: string;
  }
  export interface CategoryView {
    id: string;
    groupId: string;
    name: string;
    hidden: boolean;
  }
  export interface CategoryMonth {
    categoryId: string;
    month: string;
    assigned: Money;
    activity: Money;
    available: Money;
  }
  export interface BudgetState {
    currentMonth: string | null;
    accounts: AccountView[];
    groups: GroupView[];
    categories: CategoryView[];
    balances: Record<string, Money>;
    categoryMonths: CategoryMonth[];
    categoryAvailable: Record<string, Money>;
    creditCardPayments: Record<string, Money>;
    income: Money;
    totalAssigned: Money;
    cashOverspending: Money;
    readyToAssign: Money;
    eventCount: number;
  }
  export interface Invariant {
    assets: Money;
    categoriesAvail: Money;
    readyToAssign: Money;
    rhs: Money;
    diff: Money;
    ok: boolean;
  }

  export interface CategorySuggestion {
    categoryId: string;
    name: string;
    count: number;
    basis: string;
  }

  export function computeState(
    events: KymEvent[],
    opts?: { asOf?: string }
  ): BudgetState;
  export function checkInvariant(state: BudgetState): Invariant;
  export function mergeEvents(...logs: KymEvent[][]): KymEvent[];
  /**
   * Learn a category for a new transaction from the user's own history (how they
   * categorized this payee/memo before). Returns a suggestion whose categoryId is
   * already a real budget category, or null when there is no signal.
   */
  export function suggestCategory(
    events: KymEvent[],
    hint?: { payee?: string; memo?: string }
  ): CategorySuggestion | null;
  export const AccountType: Record<string, string>;
}

declare module "react-native-qrcode-svg" {
  import { Component } from "react";
  export interface QRCodeProps {
    value: string;
    size?: number;
    color?: string;
    backgroundColor?: string;
    ecl?: "L" | "M" | "Q" | "H";
  }
  export default class QRCode extends Component<QRCodeProps> {}
}
