// KYM pairing identity + payload crypto (phone side) — ported from Perun's
// shipped `identity.ts` (docs/pairing-crypto.md), re-namespaced to `kym`.
//
// One symmetric 32-byte pre-shared secret S is the whole household key. Every
// device in a household shares it; it is created on ONE device and carried to
// the others out-of-band (the QR shown on the Pairing screen), then confirmed
// by both ends showing the same 3-word fingerprint.
//
// Derivations (the C++ module + other phones must match byte-for-byte):
//   K            = HKDF-SHA256(ikm=S, salt="kym-pair-v1", info="", 32)
//   topic(e)     = HMAC-SHA256(K, "kym/topic/v1|"+e)[0..15]   (16 bytes)
//   contentTopic = "/kym/1/" + hex(topic(e)) + "/proto"
//   Ke           = HKDF-SHA256(ikm=K, salt="", info="kym/payload/v1", 32)
//   fingerprint  = pgpWords(SHA-256(K)[0..2])   (even/odd/even)
//   nonce(id)    = HMAC-SHA256(Ke, "kym/nonce/v1|"+id)[0..11] (12B, DETERMINISTIC)
//   wire payload = nonce(12) || ChaCha20-Poly1305(Ke, nonce, plaintext, aad=topic)
//
// This is a vendored, byte-parity copy of loam-sync's shared household crypto
// (basecamp/logos_sync/crypto.ts, domain="kym") — Metro cannot bundle the
// out-of-tree loam-sync package on an Expo export, so the phone carries an
// identical implementation. The DETERMINISTIC id-derived nonce (ADR 0011) means
// re-sealing an immutable event is byte-identical, so the fleet store dedups it
// (fixes store bloat + the cold-start 2500-cap truncation). Parity with the
// shared seal is locked by packages/sync/test (mobile-crypto-parity).
//
// NOTE (Phase 2): this file only DERIVES and displays the secret/topic/fingerprint
// for the Pairing screen. It performs NO networking — seal/open/topic are provided
// so that Phase 3 (issue #4, liblogosdelivery) can wire Delivery without touching
// the crypto. The household secret itself is real, full-entropy, and usable.
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import * as Crypto from "expo-crypto";
import { PGP_EVEN, PGP_ODD } from "./pgpWords";

const enc = (s: string): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
};

const SALT_PAIR = enc("kym-pair-v1");
const INFO_PAYLOAD = enc("kym/payload/v1");
const HEX = "0123456789abcdef";
const hex = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += HEX[x >> 4] + HEX[x & 15];
  return s;
};

/** A household identity: the raw secret plus everything derived from it. */
export interface Identity {
  secret: Uint8Array; // S, 32 bytes
  K: Uint8Array; // master derived key
  Ke: Uint8Array; // payload encryption key
  fingerprint: string[]; // 3 pgp words, shown on every device to confirm the pairing
}

/** Fresh 32-byte household secret from the platform CSPRNG (Android SecureRandom). */
export function newSecret(): Uint8Array {
  return Crypto.getRandomBytes(32);
}

/** Derive the full identity from a 32-byte secret. Pure; no I/O. */
export function deriveIdentity(secret: Uint8Array): Identity {
  if (secret.length !== 32) throw new Error("kym household secret must be 32 bytes");
  const K = hkdf(sha256, secret, SALT_PAIR, new Uint8Array(0), 32);
  const Ke = hkdf(sha256, K, new Uint8Array(0), INFO_PAYLOAD, 32);
  const fp = sha256(K).slice(0, 3);
  const fingerprint = [PGP_EVEN[fp[0]], PGP_ODD[fp[1]], PGP_EVEN[fp[2]]];
  return { secret, K, Ke, fingerprint };
}

/** The household content topic for a rotation epoch (default 0 = static, phase 1). */
export function topicFor(id: Identity, epoch = 0): string {
  const t = hmac(sha256, id.K, enc(`kym/topic/v1|${epoch}`)).slice(0, 16);
  return `/kym/1/${hex(t)}/proto`;
}

/**
 * Deterministic 12-byte nonce from the seal id (an immutable event's id, or a
 * fresh token for a control frame). Same id → same nonce → same ciphertext.
 */
export function nonceFor(id: Identity, sealId: string): Uint8Array {
  return hmac(sha256, id.Ke, enc(`kym/nonce/v1|${sealId}`)).slice(0, 12);
}

/**
 * Encrypt plaintext → nonce(12) ‖ ciphertext‖tag, AAD-bound to the topic. The
 * nonce is DERIVED from `sealId` (deterministic): pass the event id for an
 * immutable event so a re-seal is byte-identical (the store dedups it); pass a
 * fresh unique token for an ephemeral control frame.
 */
export function seal(id: Identity, sealId: string, plaintext: Uint8Array, topic: string): Uint8Array {
  const nonce = nonceFor(id, sealId);
  const ct = chacha20poly1305(id.Ke, nonce, enc(topic)).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/** Inverse of seal(). Throws if the tag doesn't verify. (Phase 3.) */
export function open(id: Identity, sealed: Uint8Array, topic: string): Uint8Array {
  const nonce = sealed.subarray(0, 12);
  const ct = sealed.subarray(12);
  return chacha20poly1305(id.Ke, nonce, enc(topic)).decrypt(ct);
}

// ---- Pairing code <-> secret (Crockford base32, no I/O) --------------------
// 32 bytes = 256 bits = 52 base32 chars. Shown grouped; parsing is lenient.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford (no I,L,O,U)

export function encodeSecret(secret: Uint8Array): string {
  let bits = 0;
  let val = 0;
  let out = "";
  for (const b of secret) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export function decodeSecret(code: string): Uint8Array {
  const clean = code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
  let bits = 0;
  let val = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length < 32) throw new Error("pairing code too short");
  return new Uint8Array(out.slice(0, 32));
}

/** The deep link a QR / camera scan yields: kym://pair?s=<base32>. */
export function pairingUri(secret: Uint8Array): string {
  return `kym://pair?s=${encodeSecret(secret)}`;
}

/** Group a base32 code into 4-char blocks for easier reading. */
export function groupCode(code: string): string {
  return (code.match(/.{1,4}/g) || [code]).join(" ");
}
