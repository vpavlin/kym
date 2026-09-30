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
  categoriesWithHistory,
  ev,
} from "../lib/engine";
import type { BudgetState, Invariant, KymEvent } from "../lib/engine";
import { AccountType, ASSET_TYPES, DEFAULT_CURRENCY, RTA_INFLOW } from "../lib/engine";
import { getDeviceId } from "../lib/device";
import { Alert, AppState } from "react-native";
import {
  loadRegistry,
  saveRegistry,
  loadBudgetLog,
  readBudgetLog,
  withBudgetLock,
  appendStoredEvents,
  appendToStoredLog,
  rewriteStoredLog,
  clearStoredLog,
  clearBudgetLog,
  newBudgetId,
  budgetColorForSeed,
  DEFAULT_BUDGET_COLOR,
  type BudgetMeta,
} from "../lib/budgets";
import { topicFor, deriveIdentity, decodeSecret } from "../lib/identity";
import { buildSeedEvents, listTransactions, localMonth, localYmd, newEntityId, takenIds } from "../lib/budget";
import type { TxnView } from "../lib/budget";
import { loadSettings, saveSettings } from "../lib/settings";
import {
  deliveryAvailable,
  ensureNode,
  sendEnvelope,
  getPeerCount,
  sendCatchupMsg,
  startReceiving,
  refreshRoutes,
  stopNode,
  getRx,
  storeSync,
  getStoreInfo,
} from "../lib/delivery";
import { buildInitial, respond } from "../lib/catchup";
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
  /** Last store-query outcome (msg/event counts per topic). See getStoreInfo(). */
  storeInfo: string;
  /** Live peer counts, or null when unavailable. See getPeerCount(). */
  peerInfo: { peers: number; mesh: number; shard: string } | null;
}

const BudgetContext = createContext<BudgetContextValue | null>(null);

const EMPTY_STATE = computeState([]);

// A peer can send anything. Only events with the envelope the fold/merge relies on
// (string id + type, an HLC with a string dev + numeric wall, an object payload) are
// admitted to the log — a shapeless one would otherwise throw in every fold forever.
function isWellFormed(e: any): e is KymEvent {
  return (
    !!e && typeof e.id === "string" && e.id !== "" && typeof e.type === "string" &&
    !!e.hlc && typeof e.hlc.dev === "string" && typeof e.hlc.wall === "number" &&
    !!e.payload && typeof e.payload === "object"
  );
}

// Does the log touch a month AFTER `asOf` (a future assignment / move / txn)? Only
// then does the invariant need its own full (no-asOf) fold — see `invariant` below.
function touchesAfter(events: KymEvent[], asOf: string): boolean {
  for (const e of events) {
    const p: any = e.payload;
    if (!p) continue;
    if (typeof p.month === "string" && p.month > asOf) return true;
    if (typeof p.date === "string" && p.date.slice(0, 7) > asOf) return true;
  }
  return false;
}

function reportUnreadable(e: unknown) {
  console.warn("[kym] budget log unreadable:", e);
  Alert.alert(
    "Couldn't read this budget",
    "Its saved data could not be read, so KYM will not change or overwrite it. Restart the app to retry.\n\n" +
      String((e as any)?.message ?? e)
  );
}

// Most events served in answer to ONE v2 `need` frame (kym_core kMaxNeedServe).
const MAX_NEED_SERVE = 500;

// Node bring-up retry: exponential backoff 5 s → 60 s cap, retried forever (and
// immediately when the app returns to the foreground).
const retryDelayMs = (attempt: number) => Math.min(60_000, 5_000 * 2 ** Math.min(attempt, 4));

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
  const [storeInfo, setStoreInfo] = useState<string>("store: not run");
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
  const retryCountRef = useRef(0);   // node bring-up attempts since the last success (drives backoff)
  // Budgets whose stored log failed to READ (vs. missing): writes to them are refused
  // until a re-read succeeds. Budgets whose last disk append failed: the next write
  // rewrites the whole log from memory so nothing stays unpersisted.
  const unreadableRef = useRef(new Set<string>());
  const needsRewriteRef = useRef(new Set<string>());
  // Bumped by every budget switch; a slower in-flight switch that lost the race bails.
  const switchSeqRef = useRef(0);
  // The live CALENDAR month (local time), like desktop's currentMonth(): the view
  // folds asOf it, and Assign/Move default to it. Refreshed on foreground + each minute.
  const [calMonth, setCalMonth] = useState<string>(() => localMonth());
  useEffect(() => {
    const tick = () => setCalMonth((m) => (m === localMonth() ? m : localMonth()));
    const h = setInterval(tick, 60_000);
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") tick(); });
    return () => { clearInterval(h); sub.remove(); };
  }, []);

  // Boot: resolve device id, build the HLC clock, load the persisted log + settings.
  useEffect(() => {
    let alive = true;
    (async () => {
      const dev = await getDeviceId();
      const reg = await loadRegistry();     // migrates a legacy single log into "main"
      let log: KymEvent[] = [];
      try {
        log = await loadBudgetLog(reg.current);
      } catch (e) {
        // A FAILED read (not a missing log) — render empty and refuse writes to this
        // budget until a read succeeds, so we never overwrite a log we couldn't read.
        unreadableRef.current.add(reg.current);
        reportUnreadable(e);
      }
      const settings = await loadSettings();
      if (!alive) return;
      clockRef.current = new Clock(dev);
      clockRef.current.primeFrom(log);   // ADR 0013: seed HLC from the persisted log so a local edit sorts AFTER everything already held
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
      if (alive) { setPeerInfo(info); setRxInfo(getRx()); setStoreInfo(getStoreInfo()); }
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
  // The fold is guarded: one malformed peer event must not crash the app at every
  // launch. On a throw we retry on the well-formed subset, then fall back to the last
  // good state OF THIS BUDGET (never another budget's), logging the error.
  const stateRef = useRef(EMPTY_STATE);
  const lastGoodRef = useRef<{ budgetId: string; state: BudgetState }>({ budgetId: "", state: EMPTY_STATE });
  const safeFold = useCallback((evs: KymEvent[], opts?: { asOf?: string }): BudgetState | null => {
    try {
      return computeState(evs, opts);
    } catch (e) {
      console.warn("[kym] fold failed, retrying on well-formed events:", e);
      try {
        return computeState(evs.filter(isWellFormed), opts);
      } catch (e2) {
        console.warn("[kym] fold failed again; keeping the last good state:", e2);
        return null;
      }
    }
  }, []);
  const state = useMemo(() => {
    if (!events.length) return EMPTY_STATE;
    const st = safeFold(events, { asOf: calMonth });
    const bud = currentBudgetIdRef.current;
    if (st) { lastGoodRef.current = { budgetId: bud, state: st }; return st; }
    return lastGoodRef.current.budgetId === bud ? lastGoodRef.current.state : EMPTY_STATE;
  }, [events, calMonth, safeFold]);
  stateRef.current = state;
  // The invariant is a GLOBAL identity — check it on the full fold (no asOf) when the
  // log has anything after the viewed month: a future-month assignment lowers RTA but
  // isn't in this month's categories, so the asOf fold would fail it spuriously.
  // Mirrors kym_core publishBudget.
  const invariant = useMemo(() => {
    const full = events.length && touchesAfter(events, calMonth) ? safeFold(events) ?? state : state;
    return checkInvariant(full);
  }, [events, calMonth, state, safeFold]);
  const txns = useMemo(() => {
    try { return listTransactions(events); } catch (e) { console.warn("[kym] listTransactions failed:", e); return listTransactions(events.filter(isWellFormed)); }
  }, [events]);

  // Append events (local or remote) to a budget's log. EVERY log mutation of a budget
  // runs through withBudgetLock(budgetId) — one promise chain per budget — so a live
  // ingest, a background append and a budget switch can't interleave read → await →
  // overwrite. Inside the lock the budget is re-checked: if it's no longer the rendered
  // one (the user switched), the events go to its stored log instead of the view.
  // Memory is updated synchronously (no await between the check and the update), then
  // only the NEW events are appended to disk. Malformed events are dropped at the door.
  // Resolves to the current log (or null when the events went to a background budget).
  const ingest = useCallback(
    (incoming: KymEvent[], budgetId: string = currentBudgetIdRef.current): Promise<KymEvent[] | null> =>
      withBudgetLock(budgetId, async () => {
        const good = incoming.filter(isWellFormed);
        if (budgetId !== currentBudgetIdRef.current) {
          await appendToStoredLog(budgetId, good);   // throws (writes nothing) on a failed read
          return null;
        }
        if (unreadableRef.current.has(budgetId)) {
          // Never write over a log we couldn't read. Retry the read; if it now works,
          // adopt it (memory was empty) and carry on; else refuse this write.
          const disk = await readBudgetLog(budgetId);
          if (budgetId !== currentBudgetIdRef.current) { await appendToStoredLog(budgetId, good); return null; }
          unreadableRef.current.delete(budgetId);
          const diskIds = new Set(disk.map((d) => d.id));
          const merged = [...disk, ...eventsRef.current.filter((e) => !diskIds.has(e.id))];
          eventsRef.current = merged;
          setEvents(merged);
          needsRewriteRef.current.add(budgetId);
        }
        const before = eventsRef.current;
        const seen = new Set(before.map((e) => e.id));
        const added: KymEvent[] = [];
        for (const e of good) if (!seen.has(e.id)) { seen.add(e.id); added.push(e); }
        if (added.length === 0 && !needsRewriteRef.current.has(budgetId)) return before;
        // ADR 0013: advance the clock past NEWLY-ingested REMOTE events so a
        // subsequent local edit sorts after them (fixes silent LWW revert). Only
        // new + non-local ids — re-received dupes must not bump the clock.
        const clk = clockRef.current;
        if (clk) for (const e of added) if (e.hlc.dev !== deviceIdRef.current) clk.receive(e.hlc);
        const next = added.length ? [...before, ...added] : before;
        eventsRef.current = next;
        if (added.length) setEvents(next);
        try {
          if (needsRewriteRef.current.has(budgetId)) {
            await rewriteStoredLog(budgetId, next);
            needsRewriteRef.current.delete(budgetId);
          } else {
            await appendStoredEvents(budgetId, added);
          }
        } catch (e) {
          needsRewriteRef.current.add(budgetId);   // memory has them; next write persists all
          throw e;
        }
        return next;
      }),
    []
  );

  // Route an incoming event (from live receive OR store pull) to its budget. Events
  // are micro-batched per budget (50 ms) so a store pull of N events is one locked
  // append, not N whole-chunk rewrites. ingest() decides, INSIDE the budget lock,
  // whether it's the rendered budget (fold into the view) or a background one (disk).
  // Stable identity so it can be handed to startReceiving/storeSync once.
  const pendingRef = useRef(new Map<string, KymEvent[]>());
  const routeIncoming = useCallback((budgetId: string, event: KymEvent) => {
    const pending = pendingRef.current;
    const q = pending.get(budgetId);
    if (q) { q.push(event); return; }
    pending.set(budgetId, [event]);
    setTimeout(() => {
      const batch = pending.get(budgetId) ?? [];
      pending.delete(budgetId);
      ingest(batch, budgetId).catch((e) => console.warn("[kym] ingest failed:", e));
    }, 50);
  }, [ingest]);

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
      // The budget these events were authored FOR — captured before any await so a
      // concurrent budget switch can't send them to (or store them in) another household.
      const bud = currentBudgetIdRef.current;
      await ingest(newEvents, bud);
      // Best-effort publish to that budget's household over Delivery.
      // Fire-and-forget: capture must NEVER block on (or fail because of) the net.
      if (syncActiveRef.current) {
        for (const e of newEvents) {
          sendEnvelope(e, bud).catch(() => {
            /* offline / no peers / node not up — the event is already in the log */
          });
        }
      }
    },
    [ingest]
  );

  // Re-serve a budget's whole log to a peer that asked (legacy SYNC_REQ from an old
  // peer). The current budget's log is in memory; a background budget's is read from
  // disk. The v2 catch-up path (sendCatchup/onCatchup) supersedes this — it serves only
  // the exact delta — but we keep it so a pre-v2 peer still converges.
  // Throttled to one whole-log re-serve per budget per 30 s (mirrors kym_core): several
  // old peers asking at once must not each trigger a full flood.
  const lastFullServeRef = useRef(new Map<string, number>());
  const reserveBudget = useCallback(async (budgetId: string) => {
    const now = Date.now();
    const last = lastFullServeRef.current.get(budgetId) ?? 0;
    if (now - last < 30_000) return;
    lastFullServeRef.current.set(budgetId, now);
    const log =
      budgetId === currentBudgetIdRef.current
        ? eventsRef.current
        : await loadBudgetLog(budgetId);
    for (const e of log) sendEnvelope(e, budgetId).catch(() => {});
  }, []);

  // v2 RBSR catch-up: publish our bounded id-fingerprint for a budget so peers serve the
  // EXACT events we lack (and we serve the ones they lack). Wire-identical to the desktop
  // core's catchupRound. Replaces the whole-log flood — a phone that missed one event pulls
  // just that one, and a cold-started phone recurses down to the full set. Cheap + idempotent.
  const sendCatchup = useCallback(async (budgetId: string) => {
    const log =
      budgetId === currentBudgetIdRef.current
        ? eventsRef.current
        : await loadBudgetLog(budgetId);
    await sendCatchupMsg(budgetId, buildInitial(log, deviceIdRef.current)).catch(() => {});
  }, []);

  // Handle one incoming catch-up frame (fp/ids/need): step the pure reconciliation over
  // this budget's log, serve the id-exact events the peer lacks, and publish the fp/ids/need
  // replies (all single-segment). Mirrors the desktop core's ingest dispatch of respond().
  // Round-opening fps (full range, no lo/hi) are answered at most once per (peer, budget)
  // per 10 s, and one `need` answer serves at most MAX_NEED_SERVE events (the peer's next
  // round asks for the rest) — both mirror kym_core so a burst can't flood the mesh.
  const lastRoundAnswerRef = useRef(new Map<string, number>());
  const onCatchup = useCallback(async (budgetId: string, msg: any) => {
    if (msg?.t === "fp" && msg.lo === undefined && msg.hi === undefined) {
      const k = `${String(msg.from)}\u0000${budgetId}`;
      const now = Date.now();
      const last = lastRoundAnswerRef.current.get(k) ?? 0;
      if (now - last < 10_000) return;
      lastRoundAnswerRef.current.set(k, now);
    }
    const log =
      budgetId === currentBudgetIdRef.current
        ? eventsRef.current
        : await loadBudgetLog(budgetId);
    const step = respond(log, msg, deviceIdRef.current);
    const serve = msg?.t === "need" ? step.serve.slice(0, MAX_NEED_SERVE) : step.serve;
    for (const e of serve) sendEnvelope(e, budgetId).catch(() => {});
    for (const r of step.replies) sendCatchupMsg(budgetId, r).catch(() => {});
  }, []);

  // Fire a catch-up round for EVERY household we hold a key for (not just the rendered
  // one) — background budgets must stay converged too. Called on connect (a ladder, to
  // beat a still-forming mesh), on a manual Sync, and periodically.
  const catchupAll = useCallback(async () => {
    const reg = await loadRegistry();
    for (const b of reg.budgets) sendCatchup(b.id).catch(() => {});
  }, [sendCatchup]);

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

  // Read + adopt a budget's log INSIDE its lock, so every append already queued for it
  // lands first and every later one sees it as current (→ folds into the view). A newer
  // switch started meanwhile wins (switchSeq). A failed read renders it empty and marks
  // it read-only (never overwritten) instead of throwing.
  const switchTo = useCallback(async (id: string): Promise<boolean> => {
    const seq = ++switchSeqRef.current;
    return withBudgetLock(id, async () => {
      let log: KymEvent[] = [];
      try {
        log = await readBudgetLog(id);
        unreadableRef.current.delete(id);
      } catch (e) {
        unreadableRef.current.add(id);
        if (seq === switchSeqRef.current) reportUnreadable(e);
      }
      if (seq !== switchSeqRef.current) return false;   // a later switch superseded this one
      currentBudgetIdRef.current = id;
      setCurrentBudgetId(id);
      eventsRef.current = log;
      setEvents(log);
      return true;
    });
  }, []);

  // Switch the rendered budget: persist the selection, load its log, re-fold. All
  // budgets keep syncing in the background regardless of which is current.
  const selectBudget = useCallback(
    async (id: string) => {
      if (id === currentBudgetIdRef.current) return;
      if (!(await switchTo(id))) return;
      const reg = await loadRegistry();
      await saveRegistry({ ...reg, current: id });
    },
    [switchTo]
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
    switchSeqRef.current++;   // cancel any in-flight switch
    currentBudgetIdRef.current = id;
    setCurrentBudgetId(id);
    eventsRef.current = [];
    setEvents([]);
    // Subscribe the new topic on the live node (or bring the node up if it wasn't).
    if (syncActiveRef.current) {
      refreshRoutes().then(() => sendCatchup(id)).catch(() => {});
    } else if (deliveryAvailable()) {
      ensureNode()
        .then(() => {
          syncActiveRef.current = true;
          setSyncStatus("syncing");
          sendCatchup(id).catch(() => {});
        })
        .catch(() => {});
    }
  }, [sendCatchup]);

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
    switchSeqRef.current++;   // cancel any in-flight switch
    currentBudgetIdRef.current = id;
    setCurrentBudgetId(id);
    eventsRef.current = [];
    setEvents([]);
    // Start syncing the joined household and pull its log via v2 catch-up (sync from zero:
    // our empty fingerprint recurses down to receive the peer's full set). Also pull from
    // the fleet store, the reliable path when no live peer is reachable ("joined but no history").
    if (syncActiveRef.current) {
      await refreshRoutes().catch(() => {});
      sendCatchup(id).catch(() => {});
      storeSync(routeIncoming).catch(() => {});
    } else if (deliveryAvailable()) {
      ensureNode()
        .then(() => {
          syncActiveRef.current = true;
          setSyncStatus("syncing");
          sendCatchup(id).catch(() => {});
          storeSync(routeIncoming).catch(() => {});
        })
        .catch(() => {});
    }
  }, [selectBudget, sendCatchup, routeIncoming]);

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
    // Primary: pull the full history from the fleet store (reliable, no reliance on
    // our own publish propagating). Then v2 catch-up over every household (serves/pulls
    // the exact delta). No legacy SYNC_REQ any more: it made every peer re-serve its
    // WHOLE log on each tap; the RBSR round moves only the missing events.
    storeSync(routeIncoming)
      .then((s) => setStoreInfo(s.detail))
      .catch(() => {});
    catchupAll().catch(() => {});
  }, [catchupAll, routeIncoming]);

  // Permanently delete a budget on THIS device: drop its log, forget its household
  // key, and remove it from the registry. Destructive — the UI confirms hard. If it
  // was the current one, switch to another. Refuses to delete your only budget.
  const deleteBudget = useCallback(async (id: string) => {
    const reg = await loadRegistry();
    if (reg.budgets.length <= 1) throw new Error("Can't delete your only budget.");
    const remaining = reg.budgets.filter((b) => b.id !== id);
    const nextCurrent = reg.current === id ? remaining[0].id : reg.current;
    await saveRegistry({ current: nextCurrent, budgets: remaining });
    setBudgets(remaining);
    // Switch away and stop syncing its topic FIRST, then wipe: an ingest that lands
    // between the wipe and the switch would otherwise re-create the deleted log.
    if (currentBudgetIdRef.current === id) await switchTo(nextCurrent);
    await refreshRoutes().catch(() => {}); // stop syncing the removed topic
    await clearBudgetLog(id);
    await deleteSecret(id);
  }, [switchTo]);

  // Sync bring-up: register the receiver and mark ourselves online once the node
  // is up. Everything is wrapped so unpaired / emulator / no-peers degrades to
  // "offline" and NEVER crashes or blocks the app.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let unsub: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let catchupTimer: ReturnType<typeof setInterval> | null = null;
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
          routeIncoming,
          (budgetId, from) => {
            if (!from || from === deviceIdRef.current) return; // never answer ourselves
            reserveBudget(budgetId).catch(() => {}); // legacy pre-v2 peer asked — re-serve
          },
          (budgetId, msg) => { onCatchup(budgetId, msg).catch(() => {}); } // v2 RBSR reconcile
        );
        setSyncStatus("connecting");
        await ensureNode(); // throws NOT_PAIRED if no budget has a household key
        if (!alive) return;
        retryCountRef.current = 0;
        setSyncStatus("syncing");
        setSyncError(null);
        // PULL history from the fleet store — the reliable catch-up (doesn't need our
        // publish to propagate). Runs once on connect; folds every stored event (dedup by id).
        storeSync(routeIncoming)
          .then((s) => { if (alive) setStoreInfo(s.detail); })
          .catch(() => {});
        // v2 RBSR catch-up: publish our id-fingerprint so peers serve the exact delta.
        // Retried on a short ladder to beat a still-forming mesh (a dropped first frame
        // otherwise = no history), then periodically so a drop always recovers. qaku/desktop pattern.
        catchupAll().catch(() => {});
        setTimeout(() => { if (alive) catchupAll().catch(() => {}); }, 9000);
        setTimeout(() => { if (alive) catchupAll().catch(() => {}); }, 24000);
        catchupTimer = setInterval(() => { if (alive) catchupAll().catch(() => {}); }, 30000);
      } catch (e: any) {
        // NOT_PAIRED, UnsatisfiedLinkError (arm64 .so on x86_64), a rejected config,
        // etc. Surface it and self-heal with a BOUNDED retry (no tight loop).
        syncActiveRef.current = false;
        const msg = String(e?.message ?? e);
        const notPaired = msg.includes("NOT_PAIRED");
        if (alive) {
          setSyncStatus(notPaired ? "not paired" : "offline");
          setSyncError(notPaired ? null : msg);
          // Keep retrying (never give up): backoff 5 s → 60 s. Also retried at once
          // when the app comes back to the foreground (AppState effect below).
          if (!notPaired) {
            const delay = retryDelayMs(retryCountRef.current);
            retryCountRef.current += 1;
            retryTimer = setTimeout(() => { if (alive) setRetryTick((t) => t + 1); }, delay);
          }
        }
      }
    })();
    return () => {
      alive = false;
      if (unsub) unsub();
      if (retryTimer) clearTimeout(retryTimer);
      if (catchupTimer) clearInterval(catchupTimer);
    };
  }, [ready, ingest, retryTick, onCatchup, catchupAll]);

  // Foreground = retry now: a node that failed while backgrounded (no network, the
  // Loam service not up yet) shouldn't wait out the backoff once the user is back.
  const syncStatusRef = useRef<SyncStatus>("offline");
  useEffect(() => { syncStatusRef.current = syncStatus; }, [syncStatus]);
  useEffect(() => {
    if (!ready) return;
    const sub = AppState.addEventListener("change", (st) => {
      if (st !== "active" || syncStatusRef.current !== "offline" || !deliveryAvailable()) return;
      retryCountRef.current = 0;
      setRetryTick((t) => t + 1);
    });
    return () => sub.remove();
  }, [ready]);

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
        // date is the LOCAL calendar day as a "YYYY-MM-DD" STRING. A string because the
        // desktop fold derives the category month from date.substr(0,7); LOCAL because a
        // UTC toISOString() put a 00:00–01:59 (CET/CEST) spend on the 1st into the
        // PREVIOUS month. The stored string then buckets identically on every device.
        date: localYmd(input.date ?? Date.now()),
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
      // Invariant: income only counts toward Ready to Assign in an on-budget ASSET
      // account (checking/savings/cash) — booked anywhere else the fold ignores it.
      const acct = stateRef.current.accounts.find((a) => a.id === accountId);
      if (!acct || !acct.onBudget || !ASSET_TYPES.has(acct.type)) {
        throw new Error("Income must go to an on-budget checking, savings or cash account.");
      }
      const event = ev.txnCreate(clock().send(), {
        txnId: newTxnId(),
        accountId,
        amount: Math.abs(amountMilli), // inflow is positive, always
        date: localYmd(opts?.date ?? Date.now()), // local YYYY-MM-DD string — see addExpense
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
      // Shared with desktop (engine categoriesWithHistory == kym_engine.hpp categoryHistory):
      // assign/move, txn.create AND txn.edit (a txn re-categorized into it), and splits.
      if (categoriesWithHistory(eventsRef.current).has(categoryId)) throw new Error("This category has money or transactions — archive it instead.");
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
      // Refuse a duplicate name: the old slug id made "Checking" twice silently REPLACE
      // the first account (same id → LWW). New ids are collision-free (newEntityId).
      const clean = name.trim();
      if (!clean) throw new Error("Account name required.");
      if (stateRef.current.accounts.some((a) => a.name.trim().toLowerCase() === clean.toLowerCase())) {
        throw new Error(`An account named "${clean}" already exists.`);
      }
      const onBudget = accountType !== AccountType.TRACKING;
      const ccy = (currency || budgetCurrency).toUpperCase();
      if (onBudget && ccy !== budgetCurrency) {
        throw new Error(
          `on-budget accounts must be in the budget currency (${budgetCurrency}); use a tracking account for a ${ccy} account`
        );
      }
      const event = ev.accountCreate(clock().send(), {
        accountId: newEntityId("acct:", clean, takenIds(eventsRef.current)),
        name: clean,
        accountType,
        onBudget,
        startingBalance: startingBalanceMilli,
        startDate: localYmd(), // local YYYY-MM-DD STRING (desktop writes e.s["startDate"]=ymd())
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
      // Refuse a duplicate name (a second "Groceries" used to replace the first via
      // the same slug id); new ids are collision-free (newEntityId).
      const clean = name.trim();
      if (!clean) throw new Error("Category name required.");
      if (stateRef.current.categories.some((c) => c.name.trim().toLowerCase() === clean.toLowerCase())) {
        throw new Error(`A category named "${clean}" already exists.`);
      }
      const taken = takenIds(eventsRef.current);
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
        gid = newEntityId("grp:", gname, taken);
        taken.add(gid);
        events.push(ev.groupCreate(clock().send(), { groupId: gid, name: gname }));
      }
      events.push(ev.categoryCreate(clock().send(), { categoryId: newEntityId("cat:", clean, taken), groupId: gid, name: clean }));
      await commit(events);
    },
    [commit]
  );

  // --- budgeting ops (parity with CLI/desktop; same engine event builders) ---
  // The live calendar month (local), matching desktop's currentMonth() — NOT the latest
  // month with data (a fresh month would otherwise keep assigning into last month).
  const monthNow = () => calMonth;

  // Give a category money for a month. mode "delta" adds `amount`; "set" makes the
  // assigned total equal `amount`. Mirrors `kym assign` (cli/kym.mjs).
  const assign = useCallback(
    async (categoryId: string, amountMilli: number, mode: "delta" | "set" = "delta", month?: string) => {
      const event = ev.assign(clock().send(), { categoryId, month: month || monthNow(), amount: amountMilli, mode });
      await commit([event]);
    },
    [commit, calMonth]
  );

  // Net-zero move of budgeted money between two categories in a month (`kym move`).
  const moveMoney = useCallback(
    async (fromCategoryId: string, toCategoryId: string, amountMilli: number, month?: string) => {
      const event = ev.move(clock().send(), { fromCategoryId, toCategoryId, month: month || monthNow(), amount: amountMilli });
      await commit([event]);
    },
    [commit, calMonth]
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
            txnId: newTxnId(), accountId, amount: diff, date: localYmd(), // local YYYY-MM-DD string (was a numeric Date.now())
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
    // Reset only the CURRENT budget's log (other budgets are untouched). Queued in the
    // budget's lock so an in-flight append can't re-write the log after the wipe. Also
    // the escape hatch for a budget whose stored log is unreadable.
    const bud = currentBudgetIdRef.current;
    await withBudgetLock(bud, async () => {
      await clearStoredLog(bud);
      unreadableRef.current.delete(bud);
      needsRewriteRef.current.delete(bud);
      if (currentBudgetIdRef.current === bud) {
        eventsRef.current = [];
        setEvents([]);
      }
    });
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
    storeInfo,
    peerInfo,
  };

  return <BudgetContext.Provider value={value}>{children}</BudgetContext.Provider>;
}

export function useBudget(): BudgetContextValue {
  const ctx = useContext(BudgetContext);
  if (!ctx) throw new Error("useBudget must be used within BudgetProvider");
  return ctx;
}
