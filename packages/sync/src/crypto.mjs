// Household crypto for KYM sync — the reference implementation. Byte-for-byte
// identical to the mobile port (mobile/src/lib/identity.ts) and the C++ module
// (issue #6). One 32-byte pre-shared secret S is the whole household key; every
// device shares it (carried out-of-band via the pairing QR).
//
//   K            = HKDF-SHA256(ikm=S, salt="kym-pair-v1", info="", 32)
//   topic(e)     = HMAC-SHA256(K, "kym/topic/v1|"+e)[0..15]           (16 bytes)
//   contentTopic = "/kym/1/" + hex(topic(e)) + "/proto"
//   Ke           = HKDF-SHA256(ikm=K, salt="", info="kym/payload/v1", 32)
//   fingerprint  = pgpWords(SHA-256(K)[0..2])
//   wire payload = nonce(12) ‖ ChaCha20-Poly1305(Ke, nonce, plaintext, aad=topic)
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes as nodeRandomBytes } from "node:crypto";

const enc = (s) => new TextEncoder().encode(s);
const SALT_PAIR = enc("kym-pair-v1");
const INFO_PAYLOAD = enc("kym/payload/v1");
const HEXC = "0123456789abcdef";
const hex = (b) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };

/** A fresh 32-byte household secret. rng defaults to node CSPRNG; inject on RN. */
export function newSecret(rng = nodeRandomBytes) {
  return Uint8Array.from(rng(32));
}

/** Derive the full identity from a 32-byte secret. Pure. */
export function deriveIdentity(secret) {
  if (secret.length !== 32) throw new Error("kym household secret must be 32 bytes");
  const K = hkdf(sha256, secret, SALT_PAIR, new Uint8Array(0), 32);
  const Ke = hkdf(sha256, K, new Uint8Array(0), INFO_PAYLOAD, 32);
  const fp = sha256(K).slice(0, 3);
  return { secret, K, Ke, fpBytes: fp };
}

/** The household content topic for a rotation epoch (0 = static, phase 1). */
export function topicFor(id, epoch = 0) {
  const t = hmac(sha256, id.K, enc(`kym/topic/v1|${epoch}`)).slice(0, 16);
  return `/kym/1/${hex(t)}/proto`;
}

/** Encrypt: nonce(12) ‖ ChaCha20-Poly1305 ciphertext, AAD-bound to the topic. */
export function seal(id, plaintext, topic, nonce = nodeRandomBytes(12)) {
  const n = Uint8Array.from(nonce);
  const ct = chacha20poly1305(id.Ke, n, enc(topic)).encrypt(plaintext);
  const out = new Uint8Array(n.length + ct.length);
  out.set(n, 0); out.set(ct, n.length);
  return out;
}

/** Inverse of seal(). Throws if the tag doesn't verify (wrong key / tampered). */
export function open(id, sealed, topic) {
  const nonce = sealed.subarray(0, 12);
  const ct = sealed.subarray(12);
  return chacha20poly1305(id.Ke, nonce, enc(topic)).decrypt(ct);
}
