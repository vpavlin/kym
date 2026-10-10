// kym_wire_std.hpp — Qt-FREE (de)serialize of a kym::Event <-> the Delivery
// EVENT envelope. Semantically identical to kym_wire.hpp (Qt/QJson) and
// packages/sync/src/wire.mjs, but std-only so the headless hub (module-hub, a
// Qt-free core module) and the C++ set-reconciler can use it. Parity-guarded by
// module/test/wire_std_parity.cpp (round-trip + decode of TS-produced JSON).
//
//   envelope = { v:1, type:"EVENT", event:{ v,id,type,hlc:{wall,ctr,dev},dev,payload } }
//
// Numbers are integers only (money = milliunits, HLC wall/ctr) — never floats.
#pragma once
#include <string>
#include <vector>
#include <utility>
#include <cstdint>
#include <cmath>
#include <cstdlib>
#include "kym_engine.hpp"

namespace kym {
namespace json {

// A tiny JSON DOM — enough for the event shape (objects, arrays, strings,
// integer numbers, booleans, null). Object members keep insertion order.
struct Value {
  enum Type { Null, Bool, Num, Str, Arr, Obj } type = Null;
  bool b = false;
  double num = 0;                 // parsed as double; callers round to int64
  std::string str;
  std::vector<Value> arr;
  std::vector<std::pair<std::string, Value>> obj;
  const Value *find(const std::string &k) const {
    for (const auto &kv : obj) if (kv.first == k) return &kv.second;
    return nullptr;
  }
  int64_t asInt() const { return (int64_t)std::llround(num); }
};

struct Parser {
  const char *p, *end;
  bool ok = true;
  explicit Parser(const std::string &s) : p(s.data()), end(s.data() + s.size()) {}

  void ws() { while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++; }

  // Append the UTF-8 encoding of a Unicode code point to out.
  static void utf8(uint32_t cp, std::string &out) {
    if (cp <= 0x7F) out.push_back((char)cp);
    else if (cp <= 0x7FF) { out.push_back((char)(0xC0 | (cp >> 6))); out.push_back((char)(0x80 | (cp & 0x3F))); }
    else if (cp <= 0xFFFF) { out.push_back((char)(0xE0 | (cp >> 12))); out.push_back((char)(0x80 | ((cp >> 6) & 0x3F))); out.push_back((char)(0x80 | (cp & 0x3F))); }
    else { out.push_back((char)(0xF0 | (cp >> 18))); out.push_back((char)(0x80 | ((cp >> 12) & 0x3F))); out.push_back((char)(0x80 | ((cp >> 6) & 0x3F))); out.push_back((char)(0x80 | (cp & 0x3F))); }
  }
  uint32_t hex4() {
    uint32_t v = 0;
    for (int i = 0; i < 4 && p < end; i++) {
      char c = *p++; v <<= 4;
      if (c >= '0' && c <= '9') v |= (c - '0');
      else if (c >= 'a' && c <= 'f') v |= (c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= (c - 'A' + 10);
      else { ok = false; }
    }
    return v;
  }
  std::string str() {
    std::string out;
    if (p >= end || *p != '"') { ok = false; return out; }
    p++;
    while (p < end && *p != '"') {
      char c = *p++;
      if (c == '\\') {
        if (p >= end) { ok = false; break; }
        char e = *p++;
        switch (e) {
          case '"': out.push_back('"'); break;
          case '\\': out.push_back('\\'); break;
          case '/': out.push_back('/'); break;
          case 'n': out.push_back('\n'); break;
          case 't': out.push_back('\t'); break;
          case 'r': out.push_back('\r'); break;
          case 'b': out.push_back('\b'); break;
          case 'f': out.push_back('\f'); break;
          case 'u': {
            uint32_t cp = hex4();
            if (cp >= 0xD800 && cp <= 0xDBFF && p + 1 < end && p[0] == '\\' && p[1] == 'u') {
              p += 2; uint32_t lo = hex4();
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            }
            utf8(cp, out);
            break;
          }
          default: ok = false; break;
        }
      } else {
        out.push_back(c); // raw byte (incl. multi-byte UTF-8)
      }
    }
    if (p < end && *p == '"') p++; else ok = false;
    return out;
  }
  Value value() {
    ws();
    Value v;
    if (p >= end) { ok = false; return v; }
    char c = *p;
    if (c == '{') { v.type = Value::Obj; p++; ws();
      if (p < end && *p == '}') { p++; return v; }
      while (p < end) {
        ws(); std::string k = str(); ws();
        if (p < end && *p == ':') p++; else { ok = false; break; }
        v.obj.emplace_back(k, value()); ws();
        if (p < end && *p == ',') { p++; continue; }
        if (p < end && *p == '}') { p++; break; }
        ok = false; break;
      }
    } else if (c == '[') { v.type = Value::Arr; p++; ws();
      if (p < end && *p == ']') { p++; return v; }
      while (p < end) {
        v.arr.push_back(value()); ws();
        if (p < end && *p == ',') { p++; continue; }
        if (p < end && *p == ']') { p++; break; }
        ok = false; break;
      }
    } else if (c == '"') { v.type = Value::Str; v.str = str(); }
    else if (c == 't') { v.type = Value::Bool; v.b = true; p += (end - p >= 4) ? 4 : (end - p); }
    else if (c == 'f') { v.type = Value::Bool; v.b = false; p += (end - p >= 5) ? 5 : (end - p); }
    else if (c == 'n') { v.type = Value::Null; p += (end - p >= 4) ? 4 : (end - p); }
    else { // number
      const char *start = p;
      while (p < end && (*p == '-' || *p == '+' || *p == '.' || *p == 'e' || *p == 'E' || (*p >= '0' && *p <= '9'))) p++;
      v.type = Value::Num; v.num = std::strtod(std::string(start, p).c_str(), nullptr);
    }
    return v;
  }
};

inline Value parse(const std::string &s, bool &ok) {
  Parser pr(s);
  Value v = pr.value();
  ok = pr.ok;
  return v;
}

// Escape a string for JSON output — mandatory escapes only; non-ASCII stays raw
// UTF-8 (matching JSON.stringify, so wire bytes look like the TS reference).
inline void escapeTo(const std::string &s, std::string &out) {
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\t': out += "\\t"; break;
      case '\r': out += "\\r"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) { char buf[8]; std::snprintf(buf, sizeof buf, "\\u%04x", c); out += buf; }
        else out.push_back((char)c);
    }
  }
  out.push_back('"');
}

} // namespace json

// Base64 — the Delivery FFI carries the message as {"payload":"<base64>"} (see
// liblogosdelivery.h). Both the headless hub (std API) and the desktop backend
// (Qt API) base64-encode the sealed bytes into the payload so the two surfaces
// are wire-compatible and no raw binary rides a JSON/UTF-8 string.
inline std::string b64encode(const std::string &in) {
  static const char *B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out; int val = 0, bits = -6;
  for (unsigned char c : in) { val = (val << 8) + c; bits += 8;
    while (bits >= 0) { out.push_back(B[(val >> bits) & 0x3F]); bits -= 6; } }
  if (bits > -6) out.push_back(B[((val << 8) >> (bits + 8)) & 0x3F]);
  while (out.size() % 4) out.push_back('=');
  return out;
}
inline std::string b64decode(const std::string &in) {
  static const char *B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<int> T(256, -1);
  for (int i = 0; i < 64; i++) T[(unsigned char)B[i]] = i;
  std::string out; int val = 0, bits = -8;
  for (unsigned char c : in) { if (T[c] == -1) break; val = (val << 6) + T[c]; bits += 6;
    if (bits >= 0) { out.push_back(char((val >> bits) & 0xFF)); bits -= 8; } }
  return out;
}

// event -> plaintext bytes (JSON string) ready to seal. The event body comes
// from logos_sync::eventToJson (v,id,type,hlc,dev,payload; pub/sig only if set),
// wrapped in KYM's {v,type:"EVENT",event} envelope. The wire has always carried
// event.dev == hlc.dev, so we stamp it from the HLC regardless of Event.dev.
// nlohmann orders object keys, but every decoder here (C++, TS JSON.parse) is
// key-order-independent, so this round-trips with the TS/Qt codecs.
inline std::string encodeEventEnvelopeStd(const Event &e) {
  nlohmann::json ev = logos_sync::eventToJson(e);
  ev["dev"] = e.hlc.dev;                       // wire dev == hlc.dev (kym contract)
  nlohmann::json env = {{"v", 1}, {"type", "EVENT"}, {"event", ev}};
  return env.dump();
}

// plaintext bytes (after open) -> event. Returns false on a non-EVENT envelope
// or malformed JSON. The opaque payload is carried through verbatim (numbers stay
// integer milliunits, splits stay an array of {categoryId,amount}).
inline bool decodeEventEnvelopeStd(const std::string &bytes, Event &out) {
  nlohmann::json env = nlohmann::json::parse(bytes, nullptr, /*allow_exceptions=*/false);
  if (env.is_discarded() || !env.is_object()) return false;
  if (jget(env, "type", std::string()) != "EVENT") return false;
  if (!env.contains("event") || !env["event"].is_object()) return false;
  // A peer's event with a wrong-typed envelope field (id/type/hlc.wall as the wrong JSON type)
  // makes eventFromJson's value() throw: that's an undecodable event, not a crash.
  try { out = logos_sync::eventFromJson(env["event"]); } catch (...) { return false; }
  return true;
}

// A peer's RBSR catch-up frame (fp/ids/need), checked BEFORE the vendored
// logos_sync::catchup::respond() sees it. respond() reads these fields with value()/get<>()
// (a wrong type throws) and const operator[] (a MISSING "bounds"/"fps"/"ids" is an assertion
// abort, which no try/catch survives) - either kills the module. Accepts exactly the shape
// buildFp()/respond() emit: optional string from/lo/hi; fp = string arrays fps + bounds with
// bounds.size() >= fps.size() - 1; ids/need = a string array ids. (Fix upstream in logos-sync.)
inline bool catchupWellFormed(const nlohmann::json& m) {
  if (!m.is_object()) return false;
  for (const char* k : {"from", "lo", "hi"}) {
    auto it = m.find(k);
    if (it != m.end() && !it->is_string()) return false;
  }
  auto strArray = [&](const char* k, size_t& n) {
    auto it = m.find(k);
    if (it == m.end() || !it->is_array()) return false;
    for (const auto& x : *it) if (!x.is_string()) return false;
    n = it->size();
    return true;
  };
  auto t = m.find("t");
  if (t == m.end() || !t->is_string()) return false;
  const std::string tt = t->get<std::string>();
  size_t nf = 0, nb = 0;
  if (tt == "fp") return strArray("fps", nf) && strArray("bounds", nb) && (nf == 0 || nb + 1 >= nf);
  if (tt == "ids" || tt == "need") return strArray("ids", nf);
  return true;   // any other t: respond() ignores it
}

} // namespace kym
