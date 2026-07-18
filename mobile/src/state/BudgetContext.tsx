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
import { deliveryAvailable, ensureNode, sendEnvelope, startReceiving } from "../lib/delivery";
import { loadIdentity } from "../lib/identityStore";

// UI-facing sync state. "offline" covers the emulator/web (no native .so) and any
// node bring-up failure; "not paired" means there is no household secret yet.
export type SyncStatus = "offline" | "not paired" | "connecting" | "syncing";

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
  syncStatus: SyncStatus;
}

const BudgetContext = createContext<BudgetContextValue | null>(null);

const EMPTY_STATE = computeState([]);

export function BudgetProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [deviceId, setDeviceId] = useState("dev-loading");
  const [events, setEvents] = useState<KymEvent[]>([]);
  const [budgetCurrency, setBudgetCurrencyState] = useState<string>(DEFAULT_CURRENCY);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("offline");
  const clockRef = useRef<Clock | null>(null);
  // Always-current view of the log for the receive callback (which is registered
  // once and otherwise would capture a stale `events`) and for best-effort sends.
  const eventsRef = useRef<KymEvent[]>([]);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  // True once we've decided this build+device can sync (native module present and
  // paired). Gates best-effort sends so we don't retry node bring-up on capture
  // when we're on the emulator/web or unpaired.
  const syncActiveRef = useRef(false);

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

  // Append events (local or remote) through the deduping log. Uses eventsRef so it
  // is stable and always sees the latest log — safe to call from the receive
  // callback registered once at mount. appendEvents returns the same array
  // reference when nothing new was added (dedup), so we only re-render on a change.
  const ingest = useCallback(async (incoming: KymEvent[]): Promise<KymEvent[]> => {
    const next = await appendEvents(eventsRef.current, incoming);
    if (next !== eventsRef.current) {
      eventsRef.current = next;
      setEvents(next);
    }
    return next;
  }, []);

  const commit = useCallback(
    async (newEvents: KymEvent[]) => {
      await ingest(newEvents);
      // Best-effort publish to the household over Delivery. Fire-and-forget:
      // capture must NEVER block on (or fail because of) the network.
      if (syncActiveRef.current) {
        for (const e of newEvents) {
          sendEnvelope(e).catch(() => {
            /* offline / no peers / node not up — the event is already in the log */
          });
        }
      }
    },
    [ingest]
  );

  // Sync bring-up: register the receiver and mark ourselves online once the node
  // is up. Everything is wrapped so unpaired / emulator / no-peers degrades to
  // "offline" and NEVER crashes or blocks the app.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let unsub: (() => void) | null = null;
    (async () => {
      try {
        if (!deliveryAvailable()) {
          if (alive) setSyncStatus("offline"); // native .so absent (emulator/web)
          return;
        }
        const id = await loadIdentity();
        if (!id) {
          if (alive) setSyncStatus("not paired");
          return;
        }
        if (!alive) return;
        syncActiveRef.current = true;
        setSyncStatus("connecting");
        // Register the receiver BEFORE the node settles so we don't miss early
        // Store replays; incoming events go through the same deduping ingest.
        unsub = startReceiving((event) => {
          ingest([event]).catch(() => {});
        });
        await ensureNode();
        if (alive) setSyncStatus("syncing");
      } catch {
        // NOT_PAIRED, UnsatisfiedLinkError (arm64 .so on x86_64), no peers, etc.
        syncActiveRef.current = false;
        if (alive) setSyncStatus("offline");
      }
    })();
    return () => {
      alive = false;
      if (unsub) unsub();
    };
  }, [ready, ingest]);

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
    syncStatus,
  };

  return <BudgetContext.Provider value={value}>{children}</BudgetContext.Provider>;
}

export function useBudget(): BudgetContextValue {
  const ctx = useContext(BudgetContext);
  if (!ctx) throw new Error("useBudget must be used within BudgetProvider");
  return ctx;
}
