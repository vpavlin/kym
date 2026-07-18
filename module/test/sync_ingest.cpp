// Sync receive-path parity (#3): read the TS fixture (a household secret + a
// stream of SEALED EVENT messages + expected state), open each with the C++
// crypto, decode via kym_wire, fold via kym_engine, and assert the module
// reproduces the TS budget exactly. This is the module's Delivery ingest path,
// verified cross-language without needing the live fleet.
//   node sync_fixture.mjs | ./sync_ingest
#include "../src/kym_crypto.hpp"
#include "../src/kym_wire.hpp"
#include "../src/kym_engine.hpp"
#include <iostream>
#include <sstream>
#include <map>
#include <vector>

using namespace kym;
static int fails = 0, checks = 0;
static void eq(long long got, long long want, const std::string &what) {
  checks++;
  if (got != want) { fails++; std::cerr << "  FAIL " << what << ": got " << got << " want " << want << "\n"; }
}

int main() {
  std::string secretHex, topic;
  std::vector<std::string> msgs;
  std::map<std::string, long long> expect;
  std::string line, tok;
  while (std::getline(std::cin, line)) {
    std::istringstream is(line);
    is >> tok;
    if (tok == "secret") is >> secretHex;
    else if (tok == "topic") is >> topic;
    else if (tok == "msg") { std::string m; is >> m; msgs.push_back(m); }
    else if (tok == "expect") { std::string k; long long v; is >> k >> v; expect[k] = v; }
  }

  Identity id = deriveIdentity(fromHex(secretHex));
  eq(topicFor(id) == topic ? 1 : 0, 1, "topic derivation matches fixture");

  std::vector<Event> log;
  int opened = 0;
  for (const auto &m : msgs) {
    Bytes pt = open(id, fromHex(m), topic);          // decrypt (throws on failure)
    QByteArray bytes(reinterpret_cast<const char *>(pt.data()), (int)pt.size());
    Event e;
    if (decodeEventEnvelope(bytes, e)) { log.push_back(e); opened++; }
  }
  eq(opened, (long long)msgs.size(), "all sealed messages opened + decoded");

  BudgetState st = computeState(log);
  eq(st.balances["chk"], expect["chk"], "checking balance");
  eq(st.categoryAvailable["groc"], expect["groc"], "groceries available");
  eq(st.categoryAvailable["dine"], expect["dine"], "dining available");
  eq(st.readyToAssign, expect["rta"], "ready to assign");
  eq(checkInvariant(st).ok ? 1 : 0, expect["inv"], "invariant holds");

  std::cout << (fails ? "SYNC INGEST FAILED" : "SYNC INGEST OK")
            << " — " << (checks - fails) << "/" << checks << " checks\n";
  return fails ? 1 : 0;
}
