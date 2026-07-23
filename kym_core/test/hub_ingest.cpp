// Tests the headless hub's ingest composition end to end WITHOUT the module
// framework: derive identity → encode an EVENT envelope (Qt-free) → seal → open
// → decode, and assert the event survives. This is exactly what
// KymHubImpl::ingestSealed does internally (module-hub/src/kym_hub_impl.cpp).
// Build & run:  g++ -std=c++17 -I../src hub_ingest.cpp -lcrypto -o hub && ./hub
#include "../src/kym_crypto.hpp"
#include "../src/kym_wire_std.hpp"
#include <iostream>
#include <string>

using namespace kym;
static int failures = 0, checks = 0;
static void eqs(const std::string &g, const std::string &w, const std::string &what) {
  checks++; if (g != w) { failures++; std::cerr << "  FAIL " << what << ": [" << g << "] != [" << w << "]\n"; }
}
static void eqi(int64_t g, int64_t w, const std::string &what) {
  checks++; if (g != w) { failures++; std::cerr << "  FAIL " << what << ": " << g << " != " << w << "\n"; }
}
static void ok(bool c, const std::string &what) {
  checks++; if (!c) { failures++; std::cerr << "  FAIL " << what << "\n"; }
}

// The hub's ingest core, minus the framework: open(sealed) → decode.
static bool hubIngest(const Identity &id, const std::string &topic, const Bytes &sealed, Event &out) {
  try {
    Bytes pt = open(id, sealed, topic);
    std::string js(pt.begin(), pt.end());
    return decodeEventEnvelopeStd(js, out);
  } catch (...) { return false; }
}

int main() {
  Bytes secret(32, 0); for (int i = 0; i < 32; i++) secret[i] = (uint8_t)(i * 7 + 1);
  Identity id = deriveIdentity(secret);
  std::string topic = topicFor(id);

  // Build an event with splits, a negative amount, a bool, and a UTF-8 memo.
  Event e;
  e.id = "t1"; e.type = "txn.create"; e.hlc = HLC{1784401737851LL, 0, "dev-A"};
  e.s["accountId"] = "chk"; e.s["memo"] = "Kč café \"x\""; e.n["amount"] = -25000; e.b["approved"] = true;
  e.hasSplits = true; e.splits = {{"groc", -15000}, {"home", -10000}};

  // Seal it exactly as a peer would (fixed nonce for the test).
  Bytes nonce(12); for (int i = 0; i < 12; i++) nonce[i] = (uint8_t)(i + 3);
  std::string envelope = encodeEventEnvelopeStd(e);
  Bytes sealed = seal(id, strBytes(envelope), topic, nonce);

  // 1. The hub opens + decodes it back.
  Event got;
  ok(hubIngest(id, topic, sealed, got), "1.ingest-ok");
  eqs(got.id, "t1", "1.id");
  eqs(got.type, "txn.create", "1.type");
  eqi(got.hlc.wall, 1784401737851LL, "1.wall");
  eqs(got.s["memo"], "Kč café \"x\"", "1.memo-utf8+escape");
  eqi(got.n["amount"], -25000, "1.amount");
  ok(got.b["approved"], "1.approved");
  ok(got.hasSplits && got.splits.size() == 2 && got.splits[1].amount == -10000, "1.splits");

  // 2. A different household key cannot open it (auth fails, no crash).
  Bytes other(32, 9);
  Identity wrong = deriveIdentity(other);
  Event none;
  ok(!hubIngest(wrong, topicFor(wrong), sealed, none), "2.wrong-key-rejected");

  // 3. Idempotency is by id (the hub dedups) — same event decodes to same id.
  Event again;
  ok(hubIngest(id, topic, sealed, again) && again.id == got.id, "3.stable-id");

  std::cout << (failures ? "HUB INGEST FAILED" : "HUB INGEST OK")
            << " — " << (checks - failures) << "/" << checks << " checks passed\n";
  return failures ? 1 : 0;
}
