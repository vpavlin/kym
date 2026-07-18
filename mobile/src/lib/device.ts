// Stable per-install device id — the HLC tiebreak and event authorship id. Every
// event this phone authors carries `dev`, so all replicas order concurrent edits
// identically. Persisted in SecureStore; created once on first launch.
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

const KEY = "kym.deviceId";
let cached: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  let id: string | null = null;
  try {
    id = await SecureStore.getItemAsync(KEY);
  } catch {
    id = null;
  }
  if (!id) {
    // Short, human-recognisable, but globally unique enough as an HLC tiebreak.
    id = "dev-" + Crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    try {
      await SecureStore.setItemAsync(KEY, id);
    } catch {
      // SecureStore unavailable (e.g. web) — fall back to the in-memory id.
    }
  }
  cached = id;
  return id;
}
