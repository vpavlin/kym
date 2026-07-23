// Two-instance sync test: two independent hub "peers" sharing one household key,
// each holding a partial log after offline edits, reconcile and exchange ONLY the
// missing events, then converge to identical budget state. Exercises the hub's
// real C++ stack — crypto (seal/open) + wire (encode/decode) + set reconciliation
// + engine fold — end to end between two instances. The ONLY thing simulated is
// the Waku hop (a direct byte pipe stands in for delivery_module, which doesn't
// run in this sandbox). Build & run (from module/test):
//   g++ -std=c++17 -I../src hub_sync.cpp -lcrypto -o hub_sync && ./hub_sync
#include "../src/kym_crypto.hpp"
#include "../src/kym_wire_std.hpp"
#include "../src/kym_reconcile_std.hpp"
#include "../src/kym_engine.hpp"
#include <iostream>
#include <map>

using namespace kym;
static int failures = 0, checks = 0;
static void eqi(int64_t g, int64_t w, const std::string &what) {
  checks++; if (g != w) { failures++; std::cerr << "  FAIL " << what << ": " << g << " != " << w << "\n"; }
}
static void ok(bool c, const std::string &what) { checks++; if (!c) { failures++; std::cerr << "  FAIL " << what << "\n"; } }

// A hub instance: the exact ingest/reconcile the module runs, minus the transport.
struct Peer {
  Identity id;
  std::string topic;
  std::vector<Event> log;
  std::set<std::string> ids;
  uint64_t nonceCtr = 0;

  explicit Peer(const Bytes &secret) : id(deriveIdentity(secret)), topic(topicFor(id)) {}

  // Author/append an event locally and return its sealed wire bytes to "send".
  Bytes append(const Event &e) {
    if (!ids.count(e.id)) { log.push_back(e); ids.insert(e.id); }
    Bytes nonce(12, 0);
    for (int i = 0; i < 8; i++) nonce[i] = (uint8_t)(nonceCtr >> (i * 8));
    nonceCtr++;
    return seal(id, strBytes(encodeEventEnvelopeStd(e)), topic, nonce);
  }
  // Ingest a sealed message from a peer (open → decode → dedup → append).
  bool ingest(const Bytes &sealed) {
    try {
      Bytes pt = open(id, sealed, topic);
      Event e;
      if (!decodeEventEnvelopeStd(std::string(pt.begin(), pt.end()), e)) return false;
      if (ids.count(e.id)) return false;
      ids.insert(e.id); log.push_back(e);
      return true;
    } catch (...) { return false; }
  }
  std::vector<rbsr::Item> items() const {
    std::vector<rbsr::Item> v;
    for (const auto &e : log) v.push_back({e.hlc.wall, e.id});
    return v;
  }
  const Event *byId(const std::string &id) const {
    for (const auto &e : log) if (e.id == id) return &e;
    return nullptr;
  }
};

// --- event builders (shared wall so HLC order is stable across peers) ---
static int64_t T = 1000000;
static Event acct(const std::string &id, Money bal) {
  Event e; e.id = id; e.type = "account.create"; e.hlc = {T++, 0, "base"};
  e.s["accountId"] = id; e.s["name"] = id; e.s["accountType"] = "checking";
  e.s["startDate"] = "2026-07-01T00:00:00Z"; e.n["startingBalance"] = bal; e.b["onBudget"] = true; return e;
}
static Event cat(const std::string &id) {
  Event e; e.id = id; e.type = "category.create"; e.hlc = {T++, 0, "base"};
  e.s["categoryId"] = id; e.s["groupId"] = "g1"; e.s["name"] = id; return e;
}
static Event assign(const std::string &id, const std::string &c, Money amt) {
  Event e; e.id = id; e.type = "assign"; e.hlc = {T++, 0, "base"};
  e.s["categoryId"] = c; e.s["month"] = "2026-07"; e.n["amount"] = amt; e.s["mode"] = "delta"; return e;
}
static Event txn(const std::string &id, Money amt, const std::string &c, const std::string &dev) {
  Event e; e.id = id; e.type = "txn.create"; e.hlc = {T++, 0, dev};
  e.s["txnId"] = id; e.s["accountId"] = "chk"; e.n["amount"] = amt;
  e.s["date"] = "2026-07-10T00:00:00Z"; e.s["categoryId"] = c; return e;
}

int main() {
  Bytes secret(32); for (int i = 0; i < 32; i++) secret[i] = (uint8_t)(i * 3 + 5);
  Peer A(secret), B(secret);   // same household key

  // Shared base budget both devices already have (same event ids in both logs).
  std::vector<Event> base = { acct("chk", 100000), cat("groc"), cat("dine"),
                              assign("a1", "groc", 30000), assign("a2", "dine", 20000) };
  for (const auto &e : base) { A.append(e); B.append(e); }

  // Offline divergence: A spends on groceries, B spends on dining — neither has
  // seen the other's transaction.
  A.append(txn("tA", -12000, "groc", "A"));   // only in A
  B.append(txn("tB", -8000, "dine", "B"));    // only in B

  ok(A.ids.size() == 6 && B.ids.size() == 6, "setup.sizes");
  ok(A.ids != B.ids, "setup.diverged");

  // 1. Reconcile finds exactly the missing events (A needs tB, B needs tA).
  rbsr::Diff d = rbsr::reconcile(A.items(), B.items());
  ok(d.aNeeds.size() == 1 && d.aNeeds[0] == "tB", "1.A-needs-tB");
  ok(d.bNeeds.size() == 1 && d.bNeeds[0] == "tA", "1.B-needs-tA");

  // 2. Exchange ONLY the diff over the (simulated) sealed transport.
  for (const auto &id : d.aNeeds) ok(A.ingest(B.append(*B.byId(id))), "2.A-ingests-" + id);
  for (const auto &id : d.bNeeds) ok(B.ingest(A.append(*A.byId(id))), "2.B-ingests-" + id);

  // 3. Both instances now hold the same set and compute identical budgets.
  ok(A.ids == B.ids && A.ids.size() == 7, "3.converged-idset");
  BudgetState sa = computeState(A.log), sb = computeState(B.log);
  eqi(sa.categoryAvailable["groc"], sb.categoryAvailable["groc"], "3.groc-equal");
  eqi(sa.categoryAvailable["dine"], sb.categoryAvailable["dine"], "3.dine-equal");
  eqi(sa.categoryAvailable["groc"], 18000, "3.groc-value");   // 30000 - 12000
  eqi(sa.categoryAvailable["dine"], 12000, "3.dine-value");   // 20000 - 8000
  eqi(sa.balances["chk"], sb.balances["chk"], "3.balance-equal");
  eqi(sa.balances["chk"], 80000, "3.balance-value");          // 100000 - 12000 - 8000
  ok(checkInvariant(sa).ok && checkInvariant(sb).ok, "3.invariant-both");

  // 4. A second reconcile now finds nothing (fixpoint).
  rbsr::Diff d2 = rbsr::reconcile(A.items(), B.items());
  ok(d2.aNeeds.empty() && d2.bNeeds.empty(), "4.fixpoint");

  // 5. A wrong-key peer cannot ingest the household's sealed traffic.
  Bytes other(32, 7); Peer E(other);
  ok(!E.ingest(A.append(*A.byId("tA"))), "5.stranger-rejected");

  std::cout << (failures ? "HUB SYNC FAILED" : "HUB SYNC OK")
            << " — " << (checks - failures) << "/" << checks << " checks passed\n";
  return failures ? 1 : 0;
}
