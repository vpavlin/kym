// Multiple budgets on the phone. A "budget" IS a household — its own event log and
// its own household secret (→ own topic). Privacy is just who you share the pairing
// code with. All budgets sync in the background; the app renders/edits the CURRENT
// one. Mirrors kym_core's struct Budget + budgets.json registry.
//
// Storage layout (AsyncStorage):
//   kym.budgets.v1              → { current, budgets:[{id,name,color}] } (registry)
//   kym.eventLog.<budgetId>     → index {"v":2,"chunks":N}
//   kym.eventLog.<budgetId>.<i> → JSON array of events, chunk i (≤ CHUNK_CHARS serialized)
// Chunked because Android's AsyncStorage (SQLite) cannot READ a row over ~2 MB
// ("Row too big to fit into CursorWindow") — a single-key log that grew past that
// became unreadable. The old single-key format (a bare JSON array under
// kym.eventLog.<budgetId>) is migrated to chunks on first read.
// The legacy single-budget log key `kym.eventLog.v1` migrates in place to the
// default budget "main" (matching the desktop's in-place migration).
//
// Every log MUTATION for a budget runs through withBudgetLock(budgetId) — one
// promise chain per budget — so a live ingest and a background append can never
// interleave read → await write → overwrite. A FAILED read throws (never "[]"), and
// nothing writes a log after a failed read, so a transient read error can't wipe it.
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { KymEvent } from "./engine";

const REG_KEY = "kym.budgets.v1";
const LOG_PREFIX = "kym.eventLog.";
const LEGACY_LOG = "kym.eventLog.v1";

export const DEFAULT_BUDGET_ID = "main";

// The shared budget palette — MUST match kym_core's kBudgetColors (same order) so a
// household renders the same colour on every device. A budget's colour is derived
// from its household TOPIC (identical across all paired devices, since it comes
// from the shared secret) — NOT the local budget id, which differs per device.
export const BUDGET_PALETTE = ["#7dd3fc", "#a78bfa", "#4ade80", "#f472b6", "#fbbf24", "#fb7185"];
export const DEFAULT_BUDGET_COLOR = BUDGET_PALETTE[0];

// FNV-1a (32-bit) — replicated byte-for-byte in kym_core so JS and C++ pick the
// SAME palette index for the same seed. Math.imul + >>>0 keep it 32-bit unsigned.
function fnv1a(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic budget colour from a stable seed (the household topic). */
export function budgetColorForSeed(seed: string): string {
  return BUDGET_PALETTE[fnv1a(seed) % BUDGET_PALETTE.length];
}

export interface BudgetMeta {
  id: string;
  name: string;
  color: string;
}
export interface BudgetRegistry {
  current: string;
  budgets: BudgetMeta[];
}

const logKey = (budgetId: string) => LOG_PREFIX + budgetId;

function freshRegistry(): BudgetRegistry {
  return {
    current: DEFAULT_BUDGET_ID,
    budgets: [{ id: DEFAULT_BUDGET_ID, name: "My budget", color: DEFAULT_BUDGET_COLOR }],
  };
}

/**
 * Load the budget registry, migrating a legacy single-budget install on first run:
 * a `kym.eventLog.v1` log becomes budget "main" (copied to `kym.eventLog.main`).
 * Always returns a valid registry with at least the default budget.
 */
export async function loadRegistry(): Promise<BudgetRegistry> {
  try {
    const raw = await AsyncStorage.getItem(REG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.budgets) && parsed.budgets.length) {
        const current =
          typeof parsed.current === "string" &&
          parsed.budgets.some((b: BudgetMeta) => b.id === parsed.current)
            ? parsed.current
            : parsed.budgets[0].id;
        return { current, budgets: parsed.budgets };
      }
    }
  } catch {
    /* fall through to migration / fresh */
  }
  // No registry yet → migrate a legacy single log into "main".
  const reg = freshRegistry();
  try {
    const legacy = await AsyncStorage.getItem(LEGACY_LOG);
    const mainKey = logKey(DEFAULT_BUDGET_ID);
    const already = await AsyncStorage.getItem(mainKey);
    if (legacy && !already) await AsyncStorage.setItem(mainKey, legacy);
  } catch {
    /* ignore — a fresh install just has no legacy log */
  }
  await saveRegistry(reg);
  return reg;
}

export async function saveRegistry(reg: BudgetRegistry): Promise<void> {
  await AsyncStorage.setItem(REG_KEY, JSON.stringify(reg));
}

export function newBudgetId(): string {
  return "bud-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// ~400k UTF-16 chars per chunk: ≤ ~1.2 MB even if every char were 3-byte UTF-8,
// well under the ~2 MB CursorWindow read limit.
const CHUNK_CHARS = 400_000;
const chunkKey = (budgetId: string, i: number) => `${logKey(budgetId)}.${i}`;

// Per-budget serial queue. fn runs after every earlier op on the same budget has
// settled (success or failure); the returned promise carries fn's own result.
const queues = new Map<string, Promise<unknown>>();
export function withBudgetLock<T>(budgetId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(budgetId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(budgetId, tail);
  tail.then(() => { if (queues.get(budgetId) === tail) queues.delete(budgetId); });
  return run;
}

/** Thrown when a budget's log exists but could not be read/parsed. Never write after this. */
export class LogReadError extends Error {
  constructor(budgetId: string, cause: unknown) {
    super(`Could not read the event log of budget "${budgetId}": ${String((cause as any)?.message ?? cause)}`);
    this.name = "LogReadError";
  }
}

interface LogIndex { v: 2; chunks: number }

// Split events into JSON-array chunks of at most ~CHUNK_CHARS serialized chars.
function toChunks(events: KymEvent[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const e of events) {
    const j = JSON.stringify(e);
    if (cur.length && size + j.length + 1 > CHUNK_CHARS) {
      out.push("[" + cur.join(",") + "]");
      cur = []; size = 2;
    }
    cur.push(j); size += j.length + 1;
  }
  if (cur.length) out.push("[" + cur.join(",") + "]");
  return out;
}

function parseIndex(raw: string): LogIndex | KymEvent[] {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as KymEvent[];                 // legacy single key
  if (parsed && parsed.v === 2 && Number.isInteger(parsed.chunks) && parsed.chunks >= 0) return parsed as LogIndex;
  throw new Error("unrecognised log index");
}

// Rewrite a budget's whole log as chunks: chunks first, then the index (so a crash
// mid-write leaves the old index pointing at a consistent prefix), then drop any
// now-unused trailing chunks. Caller holds the budget lock.
async function writeAll(budgetId: string, events: KymEvent[], oldChunks = 0): Promise<void> {
  const chunks = toChunks(events);
  if (chunks.length) await AsyncStorage.multiSet(chunks.map((c, i) => [chunkKey(budgetId, i), c] as [string, string]));
  await AsyncStorage.setItem(logKey(budgetId), JSON.stringify({ v: 2, chunks: chunks.length }));
  const stale: string[] = [];
  for (let i = chunks.length; i < oldChunks; i++) stale.push(chunkKey(budgetId, i));
  if (stale.length) await AsyncStorage.multiRemove(stale);
}

/**
 * Read a budget's log WITHOUT taking the lock (the caller holds it, or only reads).
 * Missing → [] (a new budget). Unreadable / corrupt → throws LogReadError. A legacy
 * single-key array is migrated to chunks in place.
 */
export async function readBudgetLog(budgetId: string): Promise<KymEvent[]> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(logKey(budgetId));
  } catch (e) {
    throw new LogReadError(budgetId, e);
  }
  if (raw == null) return [];
  let idx: LogIndex | KymEvent[];
  try {
    idx = parseIndex(raw);
  } catch (e) {
    throw new LogReadError(budgetId, e);
  }
  if (Array.isArray(idx)) {
    // Legacy single-key log → chunks. A failed migration write leaves the legacy key
    // intact (the index is written last), so it simply retries on the next read.
    await writeAll(budgetId, idx).catch(() => {});
    return idx;
  }
  if (idx.chunks === 0) return [];
  const keys = Array.from({ length: idx.chunks }, (_, i) => chunkKey(budgetId, i));
  let rows: readonly (readonly [string, string | null])[];
  try {
    rows = await AsyncStorage.multiGet(keys);
  } catch (e) {
    throw new LogReadError(budgetId, e);
  }
  const out: KymEvent[] = [];
  for (const [k, v] of rows) {
    if (v == null) throw new LogReadError(budgetId, `missing chunk ${k}`);
    try {
      const arr = JSON.parse(v);
      if (!Array.isArray(arr)) throw new Error("chunk is not an array");
      for (const e of arr) out.push(e as KymEvent);
    } catch (e) {
      throw new LogReadError(budgetId, e);
    }
  }
  return out;
}

/** Load one budget's event log (empty if none), queued behind any pending writes. Throws on a failed read. */
export function loadBudgetLog(budgetId: string): Promise<KymEvent[]> {
  return withBudgetLock(budgetId, () => readBudgetLog(budgetId));
}

/**
 * Append ALREADY-DEDUPED events to a budget's stored log: rewrite only the last
 * chunk (+ any new ones) and the index. Caller holds the budget lock and knows the
 * events are not yet stored (the in-memory log of the current budget).
 */
export async function appendStoredEvents(budgetId: string, added: KymEvent[]): Promise<void> {
  if (!added.length) return;
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(logKey(budgetId));
  } catch (e) {
    throw new LogReadError(budgetId, e);
  }
  let idx: LogIndex | KymEvent[] = { v: 2, chunks: 0 };
  if (raw != null) {
    try { idx = parseIndex(raw); } catch (e) { throw new LogReadError(budgetId, e); }
  }
  if (Array.isArray(idx)) { await writeAll(budgetId, [...idx, ...added]); return; } // legacy → migrate
  let tail: KymEvent[] = [];
  let first = idx.chunks;                    // index of the first chunk we (re)write
  if (idx.chunks > 0) {
    first = idx.chunks - 1;
    let v: string | null;
    try { v = await AsyncStorage.getItem(chunkKey(budgetId, first)); } catch (e) { throw new LogReadError(budgetId, e); }
    if (v == null) throw new LogReadError(budgetId, `missing chunk ${first}`);
    try { tail = JSON.parse(v); } catch (e) { throw new LogReadError(budgetId, e); }
    if (!Array.isArray(tail)) throw new LogReadError(budgetId, "chunk is not an array");
  }
  const chunks = toChunks([...tail, ...added]);
  await AsyncStorage.multiSet(chunks.map((c, i) => [chunkKey(budgetId, first + i), c] as [string, string]));
  await AsyncStorage.setItem(logKey(budgetId), JSON.stringify({ v: 2, chunks: first + chunks.length }));
}

/** Rewrite a budget's whole stored log from `events` (recovery after a failed append). Caller holds the lock. */
export async function rewriteStoredLog(budgetId: string, events: KymEvent[]): Promise<void> {
  let old = 0;
  try {
    const raw = await AsyncStorage.getItem(logKey(budgetId));
    const idx = raw != null ? parseIndex(raw) : null;
    if (idx && !Array.isArray(idx)) old = idx.chunks;
  } catch { /* unknown old size — stale chunks beyond the new index are harmless */ }
  await writeAll(budgetId, events, old);
}

/**
 * Append incoming events to a budget's log ON DISK (read → dedup → append) — for
 * budgets that aren't in memory. Caller holds the budget lock. Throws (and writes
 * nothing) if the stored log can't be read. Returns the number of new events.
 */
export async function appendToStoredLog(budgetId: string, incoming: KymEvent[]): Promise<number> {
  const current = await readBudgetLog(budgetId);
  const seen = new Set(current.map((e) => e.id));
  const added: KymEvent[] = [];
  for (const e of incoming) if (!seen.has(e.id)) { seen.add(e.id); added.push(e); }
  if (added.length === 0) return 0;
  await appendStoredEvents(budgetId, added);
  return added.length;
}

/** Locked appendToStoredLog — for BACKGROUND budgets that aren't currently folded/rendered. */
export function appendBudgetEventsToStorage(budgetId: string, incoming: KymEvent[]): Promise<number> {
  return withBudgetLock(budgetId, () => appendToStoredLog(budgetId, incoming));
}

/** Wipe one budget's stored log (index + every chunk). Caller holds the lock. */
export async function clearStoredLog(budgetId: string): Promise<void> {
  const prefix = logKey(budgetId) + ".";
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
  await AsyncStorage.multiRemove([logKey(budgetId), ...keys]);
}

/** Wipe one budget's log (reset / delete), queued behind pending writes. */
export function clearBudgetLog(budgetId: string): Promise<void> {
  return withBudgetLock(budgetId, () => clearStoredLog(budgetId));
}
