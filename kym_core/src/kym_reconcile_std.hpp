// kym_reconcile_std.hpp — Qt-free C++ mirror of packages/sync/src/reconcile.mjs.
// Range-Based Set Reconciliation over the event-id set: two peers exchange
// fingerprints over sorted ranges and split only where they disagree, so the hub
// serves backfill by sending ONLY the events a peer is missing (not the whole
// log). Parity-guarded byte-for-byte against the TS reference in
// module/test/reconcile_parity.cpp (fingerprints + reconcile results must match).
#pragma once
#include <string>
#include <vector>
#include <set>
#include <algorithm>
#include <utility>
#include <cstdint>
#include <cmath>
#include <openssl/sha.h>

namespace kym {
namespace rbsr {

struct Item { int64_t wall; std::string id; };

// Order by (wall, id) — identical to reconcile.mjs keyCmp.
inline int keyCmp(const Item &a, const Item &b) {
  if (a.wall != b.wall) return a.wall < b.wall ? -1 : 1;
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

// A half-open range bound: !set means ±infinity.
struct Bound { bool set = false; Item key; };

inline std::vector<Item> inRange(const std::vector<Item> &items, const Bound &lo, const Bound &hi) {
  std::vector<Item> out;
  for (const auto &it : items) {
    if (lo.set && keyCmp(it, lo.key) < 0) continue;
    if (hi.set && keyCmp(it, hi.key) >= 0) continue;
    out.push_back(it);
  }
  return out;
}

inline std::string toHex(const unsigned char *b, size_t n) {
  static const char *h = "0123456789abcdef";
  std::string s; s.reserve(n * 2);
  for (size_t i = 0; i < n; i++) { s.push_back(h[b[i] >> 4]); s.push_back(h[b[i] & 0xf]); }
  return s;
}

// Order-independent fingerprint of a set of ids — byte-identical to reconcile.mjs:
// XOR of SHA-256(id) over 32 bytes, then SHA-256(acc ‖ uint32_be(count))[0..16].
inline std::string fingerprint(const std::vector<Item> &items) {
  unsigned char acc[32] = {0};
  for (const auto &it : items) {
    unsigned char h[32];
    SHA256(reinterpret_cast<const unsigned char *>(it.id.data()), it.id.size(), h);
    for (int i = 0; i < 32; i++) acc[i] ^= h[i];
  }
  unsigned char buf[36];
  for (int i = 0; i < 32; i++) buf[i] = acc[i];
  uint32_t c = (uint32_t)items.size();
  buf[32] = (c >> 24) & 0xff; buf[33] = (c >> 16) & 0xff; buf[34] = (c >> 8) & 0xff; buf[35] = c & 0xff;
  unsigned char fp[32];
  SHA256(buf, 36, fp);
  return toHex(fp, 16);
}

struct Diff { std::vector<std::string> aNeeds, bNeeds; };

// Reconcile two event sets → exact symmetric difference (ids A lacks / ids B
// lacks). Breadth-first range splitting, mirroring reconcile.mjs.
inline Diff reconcile(std::vector<Item> A, std::vector<Item> B, int threshold = 8, int buckets = 16) {
  std::sort(A.begin(), A.end(), [](const Item &x, const Item &y) { return keyCmp(x, y) < 0; });
  std::sort(B.begin(), B.end(), [](const Item &x, const Item &y) { return keyCmp(x, y) < 0; });
  std::set<std::string> aNeeds, bNeeds;

  std::vector<std::pair<Bound, Bound>> frontier{{Bound{}, Bound{}}};
  while (!frontier.empty()) {
    std::vector<std::pair<Bound, Bound>> next;
    for (const auto &fr : frontier) {
      const Bound &lo = fr.first, &hi = fr.second;
      std::vector<Item> ia = inRange(A, lo, hi), ib = inRange(B, lo, hi);
      if (fingerprint(ia) == fingerprint(ib)) continue;

      const std::vector<Item> &larger = ia.size() >= ib.size() ? ia : ib;
      if ((int)larger.size() <= threshold) {
        std::set<std::string> aSet, bSet;
        for (auto &x : ia) aSet.insert(x.id);
        for (auto &x : ib) bSet.insert(x.id);
        for (auto &x : ib) if (!aSet.count(x.id)) aNeeds.insert(x.id);
        for (auto &x : ia) if (!bSet.count(x.id)) bNeeds.insert(x.id);
        continue;
      }
      int step = (int)std::ceil((double)larger.size() / buckets);
      Bound subLo = lo;
      for (size_t i = 0; i < larger.size(); i += step) {
        Bound subHi;
        if (i + step < larger.size()) { subHi.set = true; subHi.key = larger[i + step]; }
        else subHi = hi;
        next.push_back({subLo, subHi});
        subLo = subHi;
      }
    }
    frontier.swap(next);
  }
  return Diff{std::vector<std::string>(aNeeds.begin(), aNeeds.end()),
              std::vector<std::string>(bNeeds.begin(), bNeeds.end())};
}

} // namespace rbsr
} // namespace kym
