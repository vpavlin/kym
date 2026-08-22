// kym_crypto.hpp — C++ mirror of packages/sync/src/crypto.mjs (OpenSSL 3).
// Byte-for-byte compatible with the TS reference and the mobile port, so the
// Basecamp module, phones, and peers all share one household key and wire.
//
//   K   = HKDF-SHA256(ikm=S, salt="kym-pair-v1", info="", 32)
//   Ke  = HKDF-SHA256(ikm=K, salt="",           info="kym/payload/v1", 32)
//   topic(e)     = HMAC-SHA256(K, "kym/topic/v1|"+e)[0..15]
//   contentTopic = "/kym/1/" + hex(topic) + "/proto"
//   sealed       = nonce(12) ‖ ChaCha20-Poly1305(Ke, nonce, pt, aad=topic) ‖ tag
//
// HKDF is implemented directly over HMAC (not EVP_KDF) to match @noble's
// empty-salt semantics exactly (empty salt => HMAC key of length 0).
#pragma once
#include <string>
#include <vector>
#include <cstdint>
#include <stdexcept>
#include <openssl/hmac.h>
#include <openssl/evp.h>

namespace kym {

using Bytes = std::vector<uint8_t>;

inline Bytes hmac_sha256(const uint8_t *key, size_t klen, const uint8_t *msg, size_t mlen) {
  uint8_t out[32]; unsigned int l = 32;
  HMAC(EVP_sha256(), key, (int)klen, msg, mlen, out, &l);
  return Bytes(out, out + 32);
}
inline Bytes hmac_sha256(const Bytes &key, const Bytes &msg) {
  return hmac_sha256(key.data(), key.size(), msg.data(), msg.size());
}

// HKDF-SHA256, matching @noble/hashes (extract = HMAC(salt,ikm); expand T(i)).
inline Bytes hkdf(const Bytes &salt, const Bytes &ikm, const Bytes &info, size_t len) {
  Bytes prk = hmac_sha256(salt, ikm);
  Bytes okm, t;
  uint8_t ctr = 1;
  while (okm.size() < len) {
    Bytes in = t;
    in.insert(in.end(), info.begin(), info.end());
    in.push_back(ctr++);
    t = hmac_sha256(prk, in);
    okm.insert(okm.end(), t.begin(), t.end());
  }
  okm.resize(len);
  return okm;
}

inline Bytes strBytes(const std::string &s) { return Bytes(s.begin(), s.end()); }
inline std::string toHex(const Bytes &b) {
  static const char *H = "0123456789abcdef";
  std::string s; s.reserve(b.size() * 2);
  for (auto x : b) { s += H[x >> 4]; s += H[x & 15]; }
  return s;
}
inline Bytes fromHex(const std::string &h) {
  auto v = [](char c) -> int { return c <= '9' ? c - '0' : (c | 32) - 'a' + 10; };
  Bytes b; for (size_t i = 0; i + 1 < h.size(); i += 2) b.push_back((v(h[i]) << 4) | v(h[i + 1]));
  return b;
}

struct Identity { Bytes secret, K, Ke; };

inline Identity deriveIdentity(const Bytes &secret) {
  if (secret.size() != 32) throw std::runtime_error("household secret must be 32 bytes");
  Identity id; id.secret = secret;
  id.K = hkdf(strBytes("kym-pair-v1"), secret, {}, 32);
  id.Ke = hkdf({}, id.K, strBytes("kym/payload/v1"), 32);
  return id;
}

inline std::string topicFor(const Identity &id, int epoch = 0) {
  Bytes t = hmac_sha256(id.K, strBytes("kym/topic/v1|" + std::to_string(epoch)));
  t.resize(16);
  return "/kym/1/" + toHex(t) + "/proto";
}

// Deterministic 12-byte nonce derived from a seal id (ADR 0011). Byte-identical to
// loam-sync crypto.hpp nonceFor() and the phone's identity.ts: pass an immutable
// event's id so a re-seal is byte-identical and the fleet store dedups it (fixes
// store bloat + the cold-start truncation). Ephemeral control frames keep a random
// nonce so a fresh send is never collapsed onto an old one.
inline Bytes nonceFor(const Identity &id, const std::string &eventId) {
  Bytes n = hmac_sha256(id.Ke, strBytes("kym/nonce/v1|" + eventId));
  n.resize(12);
  return n;
}

// sealed = nonce(12) ‖ ciphertext ‖ tag(16)  (tag appended, as @noble does).
inline Bytes seal(const Identity &id, const Bytes &plaintext, const std::string &topic, const Bytes &nonce) {
  Bytes aad = strBytes(topic);
  EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
  int len = 0;
  EVP_EncryptInit_ex(ctx, EVP_chacha20_poly1305(), nullptr, nullptr, nullptr);
  EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_IVLEN, 12, nullptr);
  EVP_EncryptInit_ex(ctx, nullptr, nullptr, id.Ke.data(), nonce.data());
  EVP_EncryptUpdate(ctx, nullptr, &len, aad.data(), (int)aad.size());
  Bytes ct(plaintext.size());
  EVP_EncryptUpdate(ctx, ct.data(), &len, plaintext.data(), (int)plaintext.size());
  int ctlen = len;
  EVP_EncryptFinal_ex(ctx, ct.data() + ctlen, &len);
  ctlen += len;
  ct.resize(ctlen);
  uint8_t tag[16];
  EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_GET_TAG, 16, tag);
  EVP_CIPHER_CTX_free(ctx);
  Bytes out(nonce);
  out.insert(out.end(), ct.begin(), ct.end());
  out.insert(out.end(), tag, tag + 16);
  return out;
}

// Throws on auth failure (wrong key / tampered / not for us).
inline Bytes open(const Identity &id, const Bytes &sealed, const std::string &topic) {
  if (sealed.size() < 12 + 16) throw std::runtime_error("sealed too short");
  Bytes aad = strBytes(topic);
  const uint8_t *nonce = sealed.data();
  size_t ctlen = sealed.size() - 12 - 16;
  const uint8_t *ct = sealed.data() + 12;
  uint8_t tag[16];
  std::copy(sealed.end() - 16, sealed.end(), tag);
  EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
  int len = 0;
  EVP_DecryptInit_ex(ctx, EVP_chacha20_poly1305(), nullptr, nullptr, nullptr);
  EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_IVLEN, 12, nullptr);
  EVP_DecryptInit_ex(ctx, nullptr, nullptr, id.Ke.data(), nonce);
  EVP_DecryptUpdate(ctx, nullptr, &len, aad.data(), (int)aad.size());
  Bytes pt(ctlen);
  EVP_DecryptUpdate(ctx, pt.data(), &len, ct, (int)ctlen);
  int ptlen = len;
  EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_TAG, 16, tag);
  int ok = EVP_DecryptFinal_ex(ctx, pt.data() + ptlen, &len);
  EVP_CIPHER_CTX_free(ctx);
  if (ok <= 0) throw std::runtime_error("open: authentication failed");
  pt.resize(ptlen + len);
  return pt;
}

} // namespace kym
