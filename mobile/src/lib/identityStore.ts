// Loads the household pairing identity for the sync layer.
//
// The Pairing screen persists the household secret S in expo-secure-store under
// `kym.householdSecret.b32` as a Crockford-base32 string (see PairingScreen +
// identity.ts). Here we read it back, decode it to the 32-byte secret, and derive
// the full Identity (K/Ke/topic material). Nothing else in the app owns this seam,
// so delivery.ts can stay crypto-agnostic.
//
// A small in-memory cache keeps the hot path (every sendEnvelope) off the keystore.
import * as SecureStore from "expo-secure-store";
import { decodeSecret, deriveIdentity, Identity } from "./identity";

// Same key the Pairing screen writes. Base32 (not base64) — this is KYM-specific.
const SECRET_KEY = "kym.householdSecret.b32";

// undefined = not loaded yet; null = loaded, unpaired.
let cache: Identity | null | undefined = undefined;

/**
 * The household identity, or null if the phone isn't paired yet. Cached after the
 * first successful read. Any read/parse failure degrades to null (treated as
 * unpaired) rather than throwing — the sync layer must never crash the app.
 */
export async function loadIdentity(): Promise<Identity | null> {
  if (cache !== undefined) return cache;
  try {
    const b32 = await SecureStore.getItemAsync(SECRET_KEY);
    cache = b32 ? deriveIdentity(decodeSecret(b32)) : null;
  } catch {
    cache = null;
  }
  return cache;
}

/** Forget the cached identity (e.g. after re-pairing). Next load re-reads the keystore. */
export function resetIdentityCache(): void {
  cache = undefined;
}
