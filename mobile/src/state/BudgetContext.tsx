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
import { AccountType, DEFAULT_CURRENCY, RTA_INFLOW } from "../lib/engine";
import { getDeviceId } from "../lib/device";
import {
  loadRegistry,
  saveRegistry,
  loadBudgetLog,
  appendBudgetEvents,
  appendBudgetEventsToStorage,
  clearBudgetLog,
  newBudgetId,
  budgetColorForSeed,
  DEFAULT_BUDGET_COLOR,
  type BudgetMeta,
} from "../lib/budgets";
import { topicFor, deriveIdentity, decodeSecret } from "../lib/identity";
import { acctId, buildSeedEvents, catId, grpId, listTransactions } from "../lib/budget";
import type { TxnView } from "../lib/budget";
import { loadSettings, saveSettings } from "../lib/settings";
import {
  deliveryAvailable,
  ensureNode,
  sendEnvelope,
  getPeerCount,
  sendSyncReq,
  startReceiving,
  refreshRoutes,
  stopNode,
  getRx,
} from "../lib/delivery";
import { ensureSecret, saveSecret, loadIdentity, deleteSecret } from "../lib/identityStore";

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
  // Record money coming IN: a positive transaction categorized to Ready-to-Assign.
  addIncome: (amountMilli: number, accountId: string, opts?: { memo?: string; date?: number }) => Promise<void>;
  setTxnCategory: (txnId: string, categoryId: string | null) => Promise<void>;
  setTxnCleared: (txnId: string, cleared: TxnView["cleared"]) => Promise<void>;
  editTransaction: (
    txnId: string,
    fields: Partial<Pick<TxnView, "amount" | "accountId" | "categoryId" | "date" | "memo">>
  ) => Promise<void>;
  deleteTransaction: (txnId: string) => Promise<void>;
  deleteCategory: (categoryId: string) => Promise<void>;
  archiveCategory: (categoryId: string) => Promise<void>;
  unarchiveCategory: (categoryId: string) => Promise<void>;
  authorName: string;
  setAuthorName: (name: string) => Promise<void>;
  // Multiple budgets (each a household). All sync in the background; the current
  // one is rendered/edited. Switch or create; privacy = who you share the code with.
  budgets: BudgetMeta[];
  currentBudgetId: string;
  currentBudgetName: string;
  currentBudgetColor: string;
  selectBudget: (id: string) => Promise<void>;
  createBudget: (name: string) => Promise<void>;
  joinBudget: (name: string, code: string) => Promise<void>;
  deleteBudget: (id: string) => Promise<void>;
  refreshBudgetColors: () => Promise<void>;
  addAccount: (
    name: string,
    accountType: string,
    startingBalanceMilli: number,
    currency?: string
  ) => Promise<void>;
  addCategory: (name: string, groupId: string) => Promise<void>;
  assign: (categoryId: string, amountMilli: number, mode?: "delta" | "set", month?: string) => Promise<void>;
  moveMoney: (fromCategoryId: string, toCategoryId: string, amountMilli: number, month?: string) => Promise<void>;
  setTarget: (categoryId: string, targetType: "monthly" | "balance" | "balanceByDate", amountMilli: number, targetMonth?: string | null) => Promise<void>;
  // Book a balance adjustment so KYM matches `actualMilli`, then lock the account's
  // cleared transactions (mirrors `kym reconcile … --adjust`). Returns the diff booked.
  reconcile: (accountId: string, actualMilli: number) => Promise<number>;
  groupInit: (name: string) => Promise<void>;
  addMember: (memberId: string, name: string, role: string) => Promise<void>;
  setMemberRole: (memberId: string, role: string) => Promise<void>;
  removeMember: (memberId: string) => Promise<void>;
  seedDemo: () => Promise<void>;
  resetAll: () => Promise<void>;
  syncStatus: SyncStatus;
  syncError: string | null;
  reconnect: () => Promise<void>;
  syncNow: () => Promise<void>;
  rxInfo: { seen: number; opened: number; sent: number; raw: number; sample: string };
  /** Live peer counts, or null when unavailable. See getPeerCount(). */
  peerInfo: { peers: number; mesh: number; shard: string } | null;
}

const BudgetContext = createContext<BudgetContextValue | null>(null);

const EMPTY_STATE = computeState([]);

export function BudgetProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [deviceId, setDeviceId] = useState("dev-loading");
  const [events, setEvents] = useState<KymEvent[]>([]);
  // Multiple budgets (each a household = own log + own household key). We render/
  // edit the CURRENT one; all of them sync in the background. Mirrors kym_core.
  const [budgets, setBudgets] = useState<BudgetMeta[]>([]);
  const [currentBudgetId, setCurrentBudgetId] = useState<string>("");
  // The receive callback + commit/ingest are registered once and route by the
  // CURRENT budget, so they read it through a ref (not stale captured state).
  const currentBudgetIdRef = useRef<string>("");
  useEffect(() => {
    currentBudgetIdRef.current = currentBudgetId;
  }, [currentBudgetId]);
  const [budgetCurrency, setBudgetCurrencyState] = useState<string>(DEFAULT_CURRENCY);
  const [authorName, setAuthorNameState] = useState<string>("");
  // Current values for the memoised commit/save callbacks (which would otherwise
  // capture stale state). authorName is also stamped onto every authored event.
  const authorNameRef = useRef<string>("");
  const budgetCurrencyRef = useRef<string>(DEFAULT_CURRENCY);
  useEffect(() => {
    authorNameRef.current = authorName;
  }, [authorName]);
  useEffect(() => {
    budgetCurrencyRef.current = budgetCurrency;
  }, [budgetCurrency]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("offline");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);   // bump to re-attempt the node bring-up
  const [peerInfo, setPeerInfo] = useState<{ peers: number; mesh: number; shard: string } | null>(null);
  const [rxInfo, setRxInfo] = useState<{ seen: number; opened: number; sent: number; raw: number; sample: string }>({ seen: 0, opened: 0, sent: 0, raw: 0, sample: "" });
  const clockRef = useRef<Clock | null>(null);
  // Always-current view of the log for the receive callback (which is registered
  // once and otherwise would capture a stale `events`) and for best-effort sends.
  const eventsRef = useRef<KymEvent[]>([]);
  // Same staleness problem as eventsRef: the SYNC_REQ handler is registered once
  // and must compare against the CURRENT device id to skip our own requests.
  const deviceIdRef = useRef("dev-loading");
  useEffect(() => {
    deviceIdRef.current = deviceId;
  }, [deviceId]);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  // True once we've decided this build+device can sync (native module present and
  // paired). Gates best-effort sends so we don't retry node bring-up on capture
  // when we're on the emulator/web or unpaired.
  const syncActiveRef = useRef(false);
  const retryCountRef = useRef(0);   // bounds the node bring-up retry (no tight loop)

  // Boot: resolve device id, build the HLC clock, load the persisted log + settings.
  useEffect(() => {
    let alive = true;
    (async () => {
      const dev = await getDeviceId();
      const reg = await loadRegistry();     // migrates a legacy single log into "main"
      const log = await loadBudgetLog(reg.current);
      const settings = await loadSettings();
      if (!alive) return;
      clockRef.current = new Clock(dev);
      setDeviceId(dev);
      setBudgets(reg.budgets);
      setCurrentBudgetId(reg.current);
      currentBudgetIdRef.current = reg.current;
      setEvents(log);
      setBudgetCurrencyState(settings.budgetCurrency);
      setAuthorNameState(settings.authorName);
      setReady(true);
      // Deterministic per-household colours (fixes budgets that shared the default).
      refreshBudgetColors().catch(() => {});
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setBudgetCurrency = useCallback(async (code: string) => {
    setBudgetCurrencyState(code);
    await saveSettings({ budgetCurrency: code, authorName: authorNameRef.current });
  }, []);

  // Attribution name (mirrors kym_core setAuthorName → author.txt). Persisted as a
  // local preference; stamped onto every event this device authors (see commit).
  const setAuthorName = useCallback(async (name: string) => {
    const n = name.trim();
    setAuthorNameState(n);
    await saveSettings({ budgetCurrency: budgetCurrencyRef.current, authorName: n });
  }, []);

  // Poll live connectivity while the node is up: peer count (mesh health) and the
  // rx counters (whether anything is actually arriving over the mesh).
  useEffect(() => {
    if (syncStatus !== "syncing") {
      setPeerInfo(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      const info = await getPeerCount();
      if (alive) { setPeerInfo(info); setRxInfo(getRx()); }
    };
    tick();
    const h = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [syncStatus]);

  // Re-fold whenever the log changes. This is the whole point: balances are a
  // pure projection of the log via the same engine the desktop module runs.
  // Live folded state for callbacks registered once (addCategory needs the
  // current group list to avoid re-creating a group that already exists).
  const stateRef = useRef(EMPTY_STATE);
  const state = useMemo(
    () => (events.length ? computeState(events) : EMPTY_STATE),
    [events]
  );
  stateRef.current = state;
  const invariant = useMemo(() => checkInvariant(state), [state]);
  const txns = useMemo(() => listTransactions(events), [events]);

  // Append events (local or remote) through the deduping log. Uses eventsRef so it
  // is stable and always sees the latest log — safe to call from the receive
  // callback registered once at mount. appendEvents returns the same array
  // reference when nothing new was added (dedup), so we only re-render on a change.
  const ingest = useCallback(async (incoming: KymEvent[]): Promise<KymEvent[]> => {
    const next = await appendBudgetEvents(currentBudgetIdRef.current, eventsRef.current, incoming);
    if (next !== eventsRef.current) {
      eventsRef.current = next;
      setEvents(next);
    }
    return next;
  }, []);

  const commit = useCallback(
    async (newEvents: KymEvent[]) => {
      // Stamp local authorship into the payload before persist/send — mirrors
      // kym_core's pushEvent setting e.s["author"]. Rides the wire + fold as a
      // passthrough key (the engine carries it onto the txn view). "" = no stamp.
      const author = authorNameRef.current;
      if (author) {
        for (const e of newEvents) {
          if (e.payload && (e.payload as any).author == null) (e.payload as any).author = author;
        }
      }
      await ingest(newEvents);
      // Best-effort publish to the CURRENT budget's household over Delivery.
      // Fire-and-forget: capture must NEVER block on (or fail because of) the net.
      if (syncActiveRef.current) {
        const bud = currentBudgetIdRef.current;
        for (const e of newEvents) {
          sendEnvelope(e, bud).catch(() => {
            /* offline / no peers / node not up — the event is already in the log */
          });
        }
      }
    },
    [ingest]
  );

  // Re-serve a budget's whole log to a peer that asked (SYNC_REQ). The current
  // budget's log is in memory; a background budget's is read from disk.
  const reserveBudget = useCallback(async (budgetId: string) => {
    const log =
      budgetId === currentBudgetIdRef.current
        ? eventsRef.current
        : await loadBudgetLog(budgetId);
    for (const e of log) sendEnvelope(e, budgetId).catch(() => {});
  }, []);

  // Re-derive every budget's colour from its household identity (topic), so colours
  // are deterministic AND identical across paired devices — and so budgets created
  // before this existed (which all shared the default colour) get distinct ones.
  const refreshBudgetColors = useCallback(async () => {
    const reg = await loadRegistry();
    let changed = false;
    for (const b of reg.budgets) {
      const idn = await loadIdentity(b.id);
      if (!idn) continue; // no household key yet — keep the default colour
      const c = budgetColorForSeed(topicFor(idn));
      if (c !== b.color) { b.color = c; changed = true; }
    }
    if (changed) { await saveRegistry(reg); setBudgets(reg.budgets); }
  }, []);

  // Switch the rendered budget: persist the selection, load its log, re-fold. All
  // budgets keep syncing in the background regardless of which is current.
  const selectBudget = useCallback(
    async (id: string) => {
      if (id === currentBudgetIdRef.current) return;
      const log = await loadBudgetLog(id);
      currentBudgetIdRef.current = id;
      setCurrentBudgetId(id);
      eventsRef.current = log;
      setEvents(log);
      const reg = await loadRegistry();
      await saveRegistry({ ...reg, current: id });
    },
    []
  );

  // Create a NEW budget = a new household: generate its own secret (this device
  // hosts it), register it, switch to it, and start syncing its topic. Share its
  // pairing code (Pair tab) to bring in your other devices / your partner.
  const createBudget = useCallback(async (name: string) => {
    const id = newBudgetId();
    const idn = await ensureSecret(id); // generate + persist a fresh household key
    // Colour derives from the household topic → deterministic + shared across
    // whoever pairs into this budget (they compute the same colour).
    const color = budgetColorForSeed(topicFor(idn));
    const reg = await loadRegistry();
    const meta: BudgetMeta = { id, name: name.trim() || "New budget", color };
    const nextReg = { current: id, budgets: [...reg.budgets, meta] };
    await saveRegistry(nextReg);
    setBudgets(nextReg.budgets);
    currentBudgetIdRef.current = id;
    setCurrentBudgetId(id);
    eventsRef.current = [];
    setEvents([]);
    // Subscribe the new topic on the live node (or bring the node up if it wasn't).
    if (syncActiveRef.current) {
      refreshRoutes().catch(() => {});
    } else if (deliveryAvailable()) {
      ensureNode()
        .then(() => {
          syncActiveRef.current = true;
          setSyncStatus("syncing");
          sendSyncReq(deviceIdRef.current).catch(() => {});
        })
        .catch(() => {});
    }
  }, []);

  // JOIN an existing budget from another device's pairing code (or kym://pair link):
  // add it as a NEW budget entry keyed to that household's secret, then sync it from
  // scratch. This is the "scan a QR from Basecamp / another phone" path — no need to
  // create-then-share. If we already hold this household, just switch to it.
  const joinBudget = useCallback(async (name: string, code: string) => {
    let raw = code.trim();
    const i = raw.indexOf("s=");
    if (raw.startsWith("kym://") && i >= 0) raw = raw.slice(i + 2);
    let secret: Uint8Array;
    try {
      secret = decodeSecret(raw);
    } catch {
      throw new Error("Invalid code — scan or paste the full pairing code / kym://pair link.");
    }
    const topic = topicFor(deriveIdentity(secret));
    const reg = await loadRegistry();
    // Already have this household? Don't duplicate — switch to it.
    for (const b of reg.budgets) {
      const bi = await loadIdentity(b.id);
      if (bi && topicFor(bi) === topic) {
        await selectBudget(b.id);
        return;
      }
    }
    const id = newBudgetId();
    const idn = await saveSecret(id, secret); // this budget shares that household key
    const color = budgetColorForSeed(topicFor(idn));
    const meta: BudgetMeta = { id, name: name.trim() || "Shared budget", color };
    const nextReg = { current: id, budgets: [...reg.budgets, meta] };
    await saveRegistry(nextReg);
    setBudgets(nextReg.budgets);
    currentBudgetIdRef.current = id;
    setCurrentBudgetId(id);
    eventsRef.current = [];
    setEvents([]);
    // Start syncing the joined household and pull its whole log (sync from zero).
    if (syncActiveRef.current) {
      await refreshRoutes().catch(() => {});
      sendSyncReq(deviceIdRef.current).catch(() => {});
    } else if (deliveryAvailable()) {
      ensureNode()
        .then(() => {
          syncActiveRef.current = true;
          setSyncStatus("syncing");
          sendSyncReq(deviceIdRef.current).catch(() => {});
        })
        .catch(() => {});
    }
  }, [selectBudget]);

  // Manual reconnect: tear the node down and bring it back up (one deliberate
  // restart; setup() is not re-run). Use it if the mesh looks stuck.
  const reconnect = useCallback(async () => {
    try { await stopNode(); } catch { /* ignore */ }
    retryCountRef.current = 0;
    setSyncStatus("connecting");
    setSyncError(null);
    setRetryTick((t) => t + 1);
  }, []);

  // Manual "Sync now": ask every household to re-serve anything we're missing AND
  // re-broadcast our current budget's log (belt-and-suspenders pull + push). Safe
  // to tap repeatedly — peers dedup by event id.
  const syncNow = useCallback(async () => {
    if (!syncActiveRef.current) return;
    sendSyncReq(deviceIdRef.current).catch(() => {});
    reserveBudget(currentBudgetIdRef.current).catch(() => {});
  }, [reserveBudget]);

  // Permanently delete a budget on THIS device: drop its log, forget its household
  // key, and remove it from the registry. Destructive — the UI confirms hard. If it
  // was the current one, switch to another. Refuses to delete your only budget.
  const deleteBudget = useCallback(async (id: string) => {
    const reg = await loadRegistry();
    if (reg.budgets.length <= 1) throw new Error("Can't delete your only budget.");
    const remaining = reg.budgets.filter((b) => b.id !== id);
    const nextCurrent = reg.current === id ? remaining[0].id : reg.current;
    await saveRegistry({ current: nextCurrent, budgets: remaining });
    await clearBudgetLog(id);
    await deleteSecret(id);
    setBudgets(remaining);
    if (currentBudgetIdRef.current === id) {
      const log = await loadBudgetLog(nextCurrent);
      currentBudgetIdRef.current = nextCurrent;
      setCurrentBudgetId(nextCurrent);
      eventsRef.current = log;
      setEvents(log);
    }
    refreshRoutes().catch(() => {}); // stop syncing the removed topic
  }, []);

  // Sync bring-up: register the receiver and mark ourselves online once the node
  // is up. Everything is wrapped so unpaired / emulator / no-peers degrades to
  // "offline" and NEVER crashes or blocks the app.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let unsub: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      try {
        if (!deliveryAvailable()) {
          if (alive) setSyncStatus("offline"); // native .so absent (emulator/web)
          return;
        }
        syncActiveRef.current = true;
        // Register the receiver, then bring the node up ONCE. Routed by budget: the
        // current budget folds into the live view; others append to disk.
        // NOTE: we do NOT restart the node to chase "filter 0" — repeatedly
        // re-setup/restarting the native Waku node crashed the app. The Setup
        // screen shows the filter count + region so we can diagnose receive instead.
        unsub = startReceiving(
          (budgetId, event) => {
            if (budgetId === currentBudgetIdRef.current) ingest([event]).catch(() => {});
            else appendBudgetEventsToStorage(budgetId, [event]).catch(() => {});
          },
          (budgetId, from) => {
            if (!from || from === deviceIdRef.current) return; // never answer ourselves
            reserveBudget(budgetId).catch(() => {});
          }
        );
        setSyncStatus("connecting");
        await ensureNode(); // throws NOT_PAIRED if no budget has a household key
        if (!alive) return;
        setSyncStatus("syncing");
        setSyncError(null);
        sendSyncReq(deviceIdRef.current).catch(() => {}); // pull anything we're missing
      } catch (e: any) {
        // NOT_PAIRED, UnsatisfiedLinkError (arm64 .so on x86_64), a rejected config,
        // etc. Surface it and self-heal with a BOUNDED retry (no tight loop).
        syncActiveRef.current = false;
        const msg = String(e?.message ?? e);
        const notPaired = msg.includes("NOT_PAIRED");
        if (alive) {
          setSyncStatus(notPaired ? "not paired" : "offline");
          setSyncError(notPaired ? null : msg);
          if (!notPaired && retryCountRef.current < 5) {
            retryCountRef.current += 1;
            retryTimer = setTimeout(() => { if (alive) setRetryTick((t) => t + 1); }, 15000);
          }
        }
      }
    })();
    return () => {
      alive = false;
      if (unsub) unsub();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [ready, ingest, retryTick]);

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

  // Income: a positive inflow categorized to Ready-to-Assign (the pool zero-based
  // budgeting hands out). Same txn shape as an expense, opposite sign + RTA target.
  const addIncome = useCallback(
    async (amountMilli: number, accountId: string, opts?: { memo?: string; date?: number }) => {
      const event = ev.txnCreate(clock().send(), {
        txnId: newTxnId(),
        accountId,
        amount: Math.abs(amountMilli), // inflow is positive, always
        date: opts?.date ?? Date.now(),
        categoryId: RTA_INFLOW,
        cleared: "uncleared",
        approved: true,
        memo: opts?.memo,
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

  // Edit a transaction: append a txn.edit carrying ONLY the changed fields (the
  // fold applies them key-by-key; undefined keys are unchanged). Amount is stored
  // signed — the caller passes a signed milli value. Mirrors kym_core editTxn.
  const editTransaction = useCallback(
    async (txnId: string, fields: Partial<Pick<TxnView, "amount" | "accountId" | "categoryId" | "date" | "memo">>) => {
      const patch: Record<string, unknown> = { txnId };
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) patch[k] = v;
      const event = ev.txnEdit(clock().send(), patch as { txnId: string });
      await commit([event]);
    },
    [commit]
  );

  // Delete a transaction: a sticky txn.delete tombstone (the fold never un-sets it).
  const deleteTransaction = useCallback(
    async (txnId: string) => {
      await commit([ev.txnDelete(clock().send(), { txnId })]);
    },
    [commit]
  );

  // Delete an EMPTY category (no assignments/txns) — refuse otherwise so no money
  // is orphaned. Mirrors kym_core deleteCategory's guard.
  const deleteCategory = useCallback(
    async (categoryId: string) => {
      const hasHistory = eventsRef.current.some((e) => {
        const p: any = e.payload;
        return (
          (e.type === "assign" && p?.categoryId === categoryId) ||
          (e.type === "move" && (p?.fromCategoryId === categoryId || p?.toCategoryId === categoryId)) ||
          (e.type === "txn.create" && p?.categoryId === categoryId) ||
          (Array.isArray(p?.splits) && p.splits.some((s: any) => s?.categoryId === categoryId))
        );
      });
      if (hasHistory) throw new Error("This category has money or transactions — archive it instead.");
      await commit([ev.categoryDelete(clock().send(), { categoryId })]);
    },
    [commit]
  );

  // Archive a category WITH history: hidden but kept. Requires Available === 0
  // (empty it first), matching kym_core archiveCategory.
  const archiveCategory = useCallback(
    async (categoryId: string) => {
      const avail = stateRef.current.categoryAvailable?.[categoryId] ?? 0;
      if (avail !== 0) throw new Error("Move this category's balance to Ready to Assign first, then archive.");
      await commit([ev.categoryArchive(clock().send(), { categoryId })]);
    },
    [commit]
  );

  const unarchiveCategory = useCallback(
    async (categoryId: string) => {
      await commit([ev.categoryUnarchive(clock().send(), { categoryId })]);
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
        accountId: acctId(name),   // slug-derived so it dedups with desktop on merge
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

  // Add a category, ENSURING its group exists first (mirrors desktop
  // ensureGroup). `group` is a display NAME — accept an existing group's id or
  // name, otherwise create the group. Ids are slug-derived so the same name
  // dedups with desktop on merge. Never refuses on an empty budget (the old code
  // required a pre-seeded group, which is what blocked "add category").
  const addCategory = useCallback(
    async (name: string, group: string) => {
      const g = String(group || "").trim();
      const existing = stateRef.current.groups.find(
        (x) => x.id === g || x.name.toLowerCase() === g.toLowerCase()
      );
      const events: KymEvent[] = [];
      let gid: string;
      if (existing) {
        gid = existing.id;
      } else {
        const gname = g && !g.startsWith("grp:") && !g.startsWith("grp-") ? g : "General";
        gid = grpId(gname);
        events.push(ev.groupCreate(clock().send(), { groupId: gid, name: gname }));
      }
      events.push(ev.categoryCreate(clock().send(), { categoryId: catId(name), groupId: gid, name }));
      await commit(events);
    },
    [commit]
  );

  // --- budgeting ops (parity with CLI/desktop; same engine event builders) ---
  const monthNow = () => state.currentMonth || new Date().toISOString().slice(0, 7);

  // Give a category money for a month. mode "delta" adds `amount`; "set" makes the
  // assigned total equal `amount`. Mirrors `kym assign` (cli/kym.mjs).
  const assign = useCallback(
    async (categoryId: string, amountMilli: number, mode: "delta" | "set" = "delta", month?: string) => {
      const event = ev.assign(clock().send(), { categoryId, month: month || monthNow(), amount: amountMilli, mode });
      await commit([event]);
    },
    [commit, state.currentMonth]
  );

  // Net-zero move of budgeted money between two categories in a month (`kym move`).
  const moveMoney = useCallback(
    async (fromCategoryId: string, toCategoryId: string, amountMilli: number, month?: string) => {
      const event = ev.move(clock().send(), { fromCategoryId, toCategoryId, month: month || monthNow(), amount: amountMilli });
      await commit([event]);
    },
    [commit, state.currentMonth]
  );

  // Set (or clear, amount=0) a funding target. type "monthly" funds `amount` each
  // month; "by" targets `amount` available by targetMonth (`kym target`).
  const setTarget = useCallback(
    async (categoryId: string, targetType: "monthly" | "balance" | "balanceByDate", amountMilli: number, targetMonth?: string | null) => {
      const event = ev.categoryTarget(clock().send(), { categoryId, targetType, amount: amountMilli, targetMonth: targetMonth ?? null });
      await commit([event]);
    },
    [commit]
  );

  // Reconcile an account to `actualMilli`: book an uncategorized adjustment for any
  // difference (flows to Ready to Assign, invariant preserved) and lock all of the
  // account's not-yet-reconciled transactions. Mirrors `kym reconcile … --adjust`.
  const reconcile = useCallback(
    async (accountId: string, actualMilli: number): Promise<number> => {
      const c = clock();
      const bal = state.balances?.[accountId] ?? 0;
      const diff = actualMilli - bal;
      const out: KymEvent[] = [];
      if (diff !== 0) {
        out.push(
          ev.txnCreate(c.send(), {
            txnId: newTxnId(), accountId, amount: diff, date: Date.now(),
            categoryId: null, payeeId: "Reconciliation adjustment", cleared: "reconciled", approved: true,
          })
        );
      }
      const toLock = listTransactions(eventsRef.current).filter(
        (t) => t.accountId === accountId && t.cleared !== "reconciled"
      );
      for (const t of toLock) out.push(ev.txnEdit(c.send(), { txnId: t.txnId, cleared: "reconciled" }));
      if (out.length) await commit(out);
      return diff;
    },
    [commit, state.balances]
  );

  // --- group budgets (member identity + roles; enforced on merge by the engine) ---
  const groupInit = useCallback(
    async (name: string) => {
      const event = ev.groupInit(clock().send(), {
        name: name || "Household",
        founderId: deviceId,
        founderName: deviceId,
      });
      await commit([event]);
    },
    [commit, deviceId]
  );

  const addMember = useCallback(
    async (memberId: string, name: string, role: string) => {
      const event = ev.memberAdd(clock().send(), { memberId, name: name || memberId, role });
      await commit([event]);
    },
    [commit]
  );

  const setMemberRole = useCallback(
    async (memberId: string, role: string) => {
      await commit([ev.memberRole(clock().send(), { memberId, role })]);
    },
    [commit]
  );

  const removeMember = useCallback(
    async (memberId: string) => {
      await commit([ev.memberRemove(clock().send(), { memberId })]);
    },
    [commit]
  );

  const seedDemo = useCallback(async () => {
    const seed = buildSeedEvents(clock());
    await commit(seed);
  }, [commit]);

  const resetAll = useCallback(async () => {
    // Reset only the CURRENT budget's log (other budgets are untouched).
    await clearBudgetLog(currentBudgetIdRef.current);
    eventsRef.current = [];
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
    addIncome,
    setTxnCategory,
    setTxnCleared,
    editTransaction,
    deleteTransaction,
    deleteCategory,
    archiveCategory,
    unarchiveCategory,
    authorName,
    setAuthorName,
    budgets,
    currentBudgetId,
    currentBudgetName: budgets.find((b) => b.id === currentBudgetId)?.name ?? "My budget",
    currentBudgetColor: budgets.find((b) => b.id === currentBudgetId)?.color ?? DEFAULT_BUDGET_COLOR,
    selectBudget,
    createBudget,
    joinBudget,
    deleteBudget,
    refreshBudgetColors,
    addAccount,
    addCategory,
    assign,
    moveMoney,
    setTarget,
    reconcile,
    groupInit,
    addMember,
    setMemberRole,
    removeMember,
    seedDemo,
    resetAll,
    syncStatus,
    syncError,
    reconnect,
    syncNow,
    rxInfo,
    peerInfo,
  };

  return <BudgetContext.Provider value={value}>{children}</BudgetContext.Provider>;
}

export function useBudget(): BudgetContextValue {
  const ctx = useContext(BudgetContext);
  if (!ctx) throw new Error("useBudget must be used within BudgetProvider");
  return ctx;
}
