// Per-budget household identities for the sync layer.
//
// Each budget (household) has its own 32-byte secret S, stored in expo-secure-store
// under `kym.householdSecret.<budgetId>` as Crockford base32. From S we derive the
// full Identity (K/Ke/topic material). The legacy single-household key
// `kym.householdSecret.b32` migrates in place to the default budget "main".
//
// A per-budget in-memory cache keeps the hot path (every send/receive attempt) off
// the keystore. Mirrors kym_core's per-budget key + loadOrCreateSecret.
import * as SecureStore from "expo-secure-store";
import {
  decodeSecret,
  encodeSecret,
  deriveIdentity,
  newSecret,
  Identity,
} from "./identity";
import { DEFAULT_BUDGET_ID } from "./budgets";

const LEGACY_SECRET_KEY = "kym.householdSecret.b32";
const secretKey = (budgetId: string) => `kym.householdSecret.${budgetId}`;

// budgetId -> Identity (present) | null (loaded, no secret) | undefined (unloaded).
const cache = new Map<string, Identity | null>();

async function readSecretB32(budgetId: string): Promise<string | null> {
  let b32 = await SecureStore.getItemAsync(secretKey(budgetId));
  // Migrate the legacy single-household secret into the default budget once.
  if (!b32 && budgetId === DEFAULT_BUDGET_ID) {
    const legacy = await SecureStore.getItemAsync(LEGACY_SECRET_KEY);
    if (legacy) {
      await SecureStore.setItemAsync(secretKey(budgetId), legacy);
      b32 = legacy;
    }
  }
  return b32;
}

/**
 * The identity for a budget, or null if that budget has no secret yet (unpaired
 * and not yet initialised). Cached. Any failure degrades to null — never throws.
 */
export async function loadIdentity(budgetId: string): Promise<Identity | null> {
  const hit = cache.get(budgetId);
  if (hit !== undefined) return hit;
  let id: Identity | null = null;
  try {
    const b32 = await readSecretB32(budgetId);
    id = b32 ? deriveIdentity(decodeSecret(b32)) : null;
  } catch {
    id = null;
  }
  cache.set(budgetId, id);
  return id;
}

/** Persist a secret for a budget (pairing/join), returning its derived identity. */
export async function saveSecret(budgetId: string, secret: Uint8Array): Promise<Identity> {
  await SecureStore.setItemAsync(secretKey(budgetId), encodeSecret(secret));
  const id = deriveIdentity(secret);
  cache.set(budgetId, id);
  return id;
}

/**
 * Ensure a budget has a secret: load it, or GENERATE + persist a fresh household
 * (this device becomes the host, exactly like a freshly created desktop budget).
 * Mirrors kym_core loadOrCreateSecret. Used when creating a new budget.
 */
export async function ensureSecret(budgetId: string): Promise<Identity> {
  const existing = await loadIdentity(budgetId);
  if (existing) return existing;
  return saveSecret(budgetId, newSecret());
}

/** The budget's secret as a base32 pairing code, or null if it has none. */
export async function getSecretB32(budgetId: string): Promise<string | null> {
  return readSecretB32(budgetId);
}

/** Forget the cached identity (after re-pairing). Next load re-reads the keystore. */
export function resetIdentityCache(budgetId?: string): void {
  if (budgetId) cache.delete(budgetId);
  else cache.clear();
}

/** Permanently delete a budget's household secret from the keystore (on delete). */
export async function deleteSecret(budgetId: string): Promise<void> {
  cache.delete(budgetId);
  try {
    await SecureStore.deleteItemAsync(secretKey(budgetId));
  } catch {
    /* already gone / keystore unavailable — nothing to do */
  }
}
