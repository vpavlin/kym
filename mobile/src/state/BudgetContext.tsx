// The app's single state hub: owns the local event log, re-folds it through the
// SHARED engine on every change, and exposes the tiny set of mutations the UI
// needs. Saving is instant and offline — an append + an in-memory re-fold, never
// a network call.
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Clock,
  computeState,
  checkInvariant,
  ev,
} from "../lib/engine";
import type { BudgetState, Invariant, KymEvent } from "../lib/engine";
import { AccountType, DEFAULT_CURRENCY } from "../lib/engine";
import { getDeviceId } from "../lib/device";
import { appendEvents, clearLog, loadLog } from "../lib/eventLog";
import { buildSeedEvents, listTransactions } from "../lib/budget";
import type { TxnView } from "../lib/budget";
import { loadSettings, saveSettings } from "../lib/settings";

export interface AddExpenseInput {
  amountMilli: number; // POSITIVE magnitude in milliunits; stored negated (outflow)
  accountId: string;
  categoryId?: string | null;
  cleared?: "uncleared" | "cleared" | "reconciled";
  memo?: string;
  date?: number;
}

interface BudgetContextValue {
  ready: boolean;
  deviceId: string;
  events: KymEvent[];
  state: BudgetState;
  invariant: Invariant;
  txns: TxnView[];
  budgetCurrency: string;
  setBudgetCurrency: (code: string) => Promise<void>;
  addExpense: (input: AddExpenseInput) => Promise<void>;
  setTxnCategory: (txnId: string, categoryId: string | null) => Promise<void>;
  setTxnCleared: (txnId: string, cleared: TxnView["cleared"]) => Promise<void>;
  addAccount: (
    name: string,
    accountType: string,
    startingBalanceMilli: number,
    currency?: string
  ) => Promise<void>;
  addCategory: (name: string, groupId: string) => Promise<void>;
  seedDemo: () => Promise<void>;
  resetAll: () => Promise<void>;
}

const BudgetContext = createContext<BudgetContextValue | null>(null);

const EMPTY_STATE = computeState([]);

export function BudgetProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [deviceId, setDeviceId] = useState("dev-loading");
  const [events, setEvents] = useState<KymEvent[]>([]);
  const [budgetCurrency, setBudgetCurrencyState] = useState<string>(DEFAULT_CURRENCY);
  const clockRef = useRef<Clock | null>(null);

  // Boot: resolve device id, build the HLC clock, load the persisted log + settings.
  useEffect(() => {
    let alive = true;
    (async () => {
      const dev = await getDeviceId();
      const log = await loadLog();
      const settings = await loadSettings();
      if (!alive) return;
      clockRef.current = new Clock(dev);
      setDeviceId(dev);
      setEvents(log);
      setBudgetCurrencyState(settings.budgetCurrency);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setBudgetCurrency = useCallback(async (code: string) => {
    setBudgetCurrencyState(code);
    await saveSettings({ budgetCurrency: code });
  }, []);

  // Re-fold whenever the log changes. This is the whole point: balances are a
  // pure projection of the log via the same engine the desktop module runs.
  const state = useMemo(
    () => (events.length ? computeState(events) : EMPTY_STATE),
    [events]
  );
  const invariant = useMemo(() => checkInvariant(state), [state]);
  const txns = useMemo(() => listTransactions(events), [events]);

  const commit = useCallback(
    async (newEvents: KymEvent[]) => {
      const next = await appendEvents(events, newEvents);
      setEvents(next);
    },
    [events]
  );

  const clock = () => {
    if (!clockRef.current) throw new Error("clock not ready");
    return clockRef.current;
  };

  const newTxnId = () =>
    "txn-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  const addExpense = useCallback(
    async (input: AddExpenseInput) => {
      const c = clock();
      const amount = -Math.abs(input.amountMilli); // outflow is negative, always
      const event = ev.txnCreate(c.send(), {
        txnId: newTxnId(),
        accountId: input.accountId,
        amount,
        date: input.date ?? Date.now(),
        categoryId: input.categoryId ?? null,
        cleared: input.cleared ?? "uncleared",
        approved: true,
        memo: input.memo,
      });
      await commit([event]);
    },
    [commit]
  );

  const setTxnCategory = useCallback(
    async (txnId: string, categoryId: string | null) => {
      const event = ev.txnEdit(clock().send(), { txnId, categoryId });
      await commit([event]);
    },
    [commit]
  );

  const setTxnCleared = useCallback(
    async (txnId: string, cleared: TxnView["cleared"]) => {
      const event = ev.txnEdit(clock().send(), { txnId, cleared });
      await commit([event]);
    },
    [commit]
  );

  const addAccount = useCallback(
    async (
      name: string,
      accountType: string,
      startingBalanceMilli: number,
      currency?: string
    ) => {
      // Foreign accounts must be off-budget tracking — one budget currency, no
      // in-budget FX (mirrors the CLI rule in cli/kym.mjs).
      const onBudget = accountType !== AccountType.TRACKING;
      const ccy = (currency || budgetCurrency).toUpperCase();
      if (onBudget && ccy !== budgetCurrency) {
        throw new Error(
          `on-budget accounts must be in the budget currency (${budgetCurrency}); use a tracking account for a ${ccy} account`
        );
      }
      const event = ev.accountCreate(clock().send(), {
        accountId: "acct-" + Math.random().toString(36).slice(2, 9),
        name,
        accountType,
        onBudget,
        startingBalance: startingBalanceMilli,
        startDate: Date.now(),
        currency: ccy,
      });
      await commit([event]);
    },
    [commit, budgetCurrency]
  );

  const addCategory = useCallback(
    async (name: string, groupId: string) => {
      const event = ev.categoryCreate(clock().send(), {
        categoryId: "cat-" + Math.random().toString(36).slice(2, 9),
        groupId,
        name,
      });
      await commit([event]);
    },
    [commit]
  );

  const seedDemo = useCallback(async () => {
    const seed = buildSeedEvents(clock());
    await commit(seed);
  }, [commit]);

  const resetAll = useCallback(async () => {
    await clearLog();
    setEvents([]);
    // Fresh clock so HLCs restart cleanly for the new (empty) log.
    clockRef.current = new Clock(deviceId);
  }, [deviceId]);

  const value: BudgetContextValue = {
    ready,
    deviceId,
    events,
    state,
    invariant,
    txns,
    budgetCurrency,
    setBudgetCurrency,
    addExpense,
    setTxnCategory,
    setTxnCleared,
    addAccount,
    addCategory,
    seedDemo,
    resetAll,
  };

  return <BudgetContext.Provider value={value}>{children}</BudgetContext.Provider>;
}

export function useBudget(): BudgetContextValue {
  const ctx = useContext(BudgetContext);
  if (!ctx) throw new Error("useBudget must be used within BudgetProvider");
  return ctx;
}
