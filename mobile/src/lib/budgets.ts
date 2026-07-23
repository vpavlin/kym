// Multiple budgets on the phone. A "budget" IS a household — its own event log and
// its own household secret (→ own topic). Privacy is just who you share the pairing
// code with. All budgets sync in the background; the app renders/edits the CURRENT
// one. Mirrors kym_core's struct Budget + budgets.json registry.
//
// Storage layout (AsyncStorage):
//   kym.budgets.v1            → { current, budgets:[{id,name,color}] } (registry)
//   kym.eventLog.<budgetId>   → JSON array of that budget's events
// The legacy single-budget log key `kym.eventLog.v1` migrates in place to the
// default budget "main" (matching the desktop's in-place migration).
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

/** Load one budget's event log (empty if none). */
export async function loadBudgetLog(budgetId: string): Promise<KymEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(logKey(budgetId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as KymEvent[]) : [];
  } catch {
    return [];
  }
}

async function writeBudgetLog(budgetId: string, events: KymEvent[]): Promise<void> {
  await AsyncStorage.setItem(logKey(budgetId), JSON.stringify(events));
}

/**
 * Append events to a budget's log, deduped by id (idempotent). Returns the full
 * log after the append. Used for the CURRENT budget (caller holds `current`).
 */
export async function appendBudgetEvents(
  budgetId: string,
  current: KymEvent[],
  incoming: KymEvent[]
): Promise<KymEvent[]> {
  const seen = new Set(current.map((e) => e.id));
  const added = incoming.filter((e) => !seen.has(e.id));
  if (added.length === 0) return current;
  const next = [...current, ...added];
  await writeBudgetLog(budgetId, next);
  return next;
}

/**
 * Append incoming events to a budget's log ON DISK (load → dedup → write) without
 * an in-memory copy — for BACKGROUND budgets that aren't currently folded/rendered.
 * Returns the number of genuinely new events appended.
 */
export async function appendBudgetEventsToStorage(
  budgetId: string,
  incoming: KymEvent[]
): Promise<number> {
  const current = await loadBudgetLog(budgetId);
  const seen = new Set(current.map((e) => e.id));
  const added = incoming.filter((e) => !seen.has(e.id));
  if (added.length === 0) return 0;
  await writeBudgetLog(budgetId, [...current, ...added]);
  return added.length;
}

/** Wipe one budget's log (reset). */
export async function clearBudgetLog(budgetId: string): Promise<void> {
  await AsyncStorage.removeItem(logKey(budgetId));
}
