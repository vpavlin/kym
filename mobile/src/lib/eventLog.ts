// The local append-only event log — the on-device durable copy of the household
// ledger, and the exact wire format that will later sync over Delivery (issue #4).
//
// Persistence: a single AsyncStorage key holding a JSON array of events. Appends
// are O(events) (rewrite the array); fine for a phone's transaction volume, and
// dead simple. NOTHING here blocks capture on network — there is no network yet.
//
// This log IS the source of truth. Balances are never stored; they are a fold of
// this log via @kym/engine.computeState (see BudgetContext).
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { KymEvent } from "./engine";

const KEY = "kym.eventLog.v1";

export async function loadLog(): Promise<KymEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as KymEvent[]) : [];
  } catch {
    return [];
  }
}

async function writeLog(events: KymEvent[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(events));
}

/**
 * Append events, deduped by id (idempotent — matches the merge contract). Returns
 * the full log after the append so callers can re-fold immediately.
 */
export async function appendEvents(
  current: KymEvent[],
  incoming: KymEvent[]
): Promise<KymEvent[]> {
  const seen = new Set(current.map((e) => e.id));
  const added = incoming.filter((e) => !seen.has(e.id));
  if (added.length === 0) return current;
  const next = [...current, ...added];
  await writeLog(next);
  return next;
}

/** Wipe the log (used by the "reset demo" action on the Setup screen). */
export async function clearLog(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
