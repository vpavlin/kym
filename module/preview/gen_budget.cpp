// Drives the REAL C++ engine (kym_engine.hpp) with a CZK demo budget (plus a EUR
// off-budget tracking account) and emits the budget JSON the grid QML renders.
// Money is formatted per currency via money_format.hpp (mirrors the TS formatter).
//   g++ -std=c++17 -I../src gen_budget.cpp -o gen && ./gen > budget.json
#include "../src/kym_engine.hpp"
#include "../src/money_format.hpp"
#include <iostream>
#include <sstream>
#include <map>
#include <vector>

using namespace kym;

static const std::string BUDGET_CCY = "CZK";
static int64_t T = 1000000;
static HLC h() { return HLC{T++, 0, "basecamp"}; }

int main() {
  const std::string M = "2026-07";
  const std::string d = M + "-15T12:00:00Z";
  std::vector<Event> ev;
  std::map<std::string, std::string> accName, catName, catGroup, accCcy;
  std::vector<std::string> groupOrder = {"Bills", "Everyday", "Goals"};

  auto acct = [&](std::string id, std::string name, std::string type, Money bal, bool onBudget, std::string ccy) {
    Event e; e.id = "a" + id; e.type = "account.create"; e.hlc = h();
    e.s["accountId"] = id; e.s["name"] = name; e.s["accountType"] = type;
    e.s["startDate"] = d; e.n["startingBalance"] = bal; e.b["onBudget"] = onBudget; e.s["currency"] = ccy;
    ev.push_back(e); accName[id] = name; accCcy[id] = ccy;
  };
  auto cat = [&](std::string id, std::string name, std::string group) {
    Event e; e.id = "c" + id; e.type = "category.create"; e.hlc = h();
    e.s["categoryId"] = id; e.s["groupId"] = group; e.s["name"] = name;
    ev.push_back(e); catName[id] = name; catGroup[id] = group;
  };
  auto assign = [&](std::string c, Money amt) {
    Event e; e.id = "s" + c + std::to_string(T); e.type = "assign"; e.hlc = h();
    e.s["categoryId"] = c; e.s["month"] = M; e.s["mode"] = "delta"; e.n["amount"] = amt;
    ev.push_back(e);
  };
  auto txn = [&](std::string acc, Money amt, std::string c) {
    Event e; e.id = "t" + std::to_string(T); e.type = "txn.create"; e.hlc = h();
    e.s["txnId"] = e.id; e.s["accountId"] = acc; e.n["amount"] = amt; e.s["date"] = d;
    e.s["categoryId"] = c; ev.push_back(e);
  };
  auto target = [&](std::string c, std::string type, Money amt) {
    Event e; e.id = "tg" + c + std::to_string(T); e.type = "category.target"; e.hlc = h();
    e.s["categoryId"] = c; e.s["targetType"] = type; e.n["amount"] = amt; ev.push_back(e);
  };
  auto fb = [](Money m) { return formatMoney(m, BUDGET_CCY); };  // budget figures

  // A realistic Czech household month (values in CZK; Revolut in EUR, tracked off-budget).
  acct("chk", "Checking", "checking", 30000000, true, "CZK");
  acct("visa", "Visa", "creditCard", 0, true, "CZK");
  acct("revolut", "Revolut", "tracking", 420000, false, "EUR");
  cat("rent", "Rent", "Bills"); cat("util", "Utilities", "Bills");
  cat("groc", "Groceries", "Everyday"); cat("dine", "Dining", "Everyday"); cat("fun", "Fun Money", "Everyday");
  cat("save", "Emergency Fund", "Goals");
  txn("chk", 45000000, RTA_INFLOW);                       // salary
  assign("rent", 18000000); assign("util", 3000000); assign("groc", 8000000);
  assign("dine", 3000000); assign("fun", 2000000); assign("save", 5000000);
  txn("chk", -18000000, "rent"); txn("chk", -2450000, "groc"); txn("visa", -680000, "dine");
  target("groc", "monthly", 8000000);      // fund 8000 Kč/mo — funded
  target("save", "balance", 100000000);    // reach 100 000 Kč — needs more

  BudgetState st = computeState(ev);
  Invariant inv = checkInvariant(st);

  auto rowFor = [&](const std::string &c) {
    Money a = 0, act = 0;
    for (auto &r : st.categoryMonths) if (r.categoryId == c && r.month == st.currentMonth) { a = r.assigned; act = r.activity; }
    return std::make_pair(a, act);
  };

  std::ostringstream o;
  o << "{";
  o << "\"currency\":\"" << BUDGET_CCY << "\",";
  o << "\"currentMonth\":\"" << st.currentMonth << "\",";
  o << "\"readyToAssign\":\"" << fb(st.readyToAssign) << "\",";
  o << "\"readyToAssignRaw\":" << st.readyToAssign << ",";
  o << "\"invariant\":{\"ok\":" << (inv.ok ? "true" : "false")
    << ",\"assets\":\"" << fb(inv.assets) << "\",\"categoriesAvail\":\"" << fb(inv.categoriesAvail)
    << "\",\"diff\":\"" << fb(inv.diff) << "\"},";
  o << "\"accounts\":[";
  for (size_t i = 0; i < st.accounts.size(); i++) {
    auto &a = st.accounts[i];
    std::string ac = a.currency.empty() ? BUDGET_CCY : a.currency;
    o << (i ? "," : "") << "{\"name\":\"" << accName[a.id] << "\",\"type\":\"" << a.type
      << (a.onBudget ? "" : " (off-budget)") << "\",\"balance\":\"" << formatMoney(st.balances[a.id], ac) << "\"}";
  }
  o << "],\"groups\":[";
  bool firstG = true;
  for (auto &g : groupOrder) {
    o << (firstG ? "" : ",") << "{\"name\":\"" << g << "\",\"categories\":["; firstG = false;
    bool firstC = true;
    for (auto &cid : st.categoryIds) {
      if (catGroup[cid] != g) continue;
      auto [a, act] = rowFor(cid);
      Money avail = st.categoryAvailable.count(cid) ? st.categoryAvailable[cid] : 0;
      std::string tgt = "", tgtOk = "true";
      if (st.targetProgress.count(cid)) {
        auto &tp = st.targetProgress[cid];
        tgt = tp.onTrack ? "\\ud83c\\udfaf funded" : ("\\ud83c\\udfaf need " + fb(tp.needed));
        tgtOk = tp.onTrack ? "true" : "false";
      }
      o << (firstC ? "" : ",") << "{\"name\":\"" << catName[cid] << "\",\"assigned\":\"" << fb(a)
        << "\",\"activity\":\"" << fb(act) << "\",\"available\":\"" << fb(avail)
        << "\",\"negative\":" << (avail < 0 ? "true" : "false")
        << ",\"target\":\"" << tgt << "\",\"targetOnTrack\":" << tgtOk << "}";
      firstC = false;
    }
    o << "]}";
  }
  o << "],\"creditCardPayments\":[";
  bool firstP = true;
  for (auto &kv : st.creditCardPayments) {
    o << (firstP ? "" : ",") << "{\"name\":\"" << accName[kv.first] << "\",\"available\":\"" << fb(kv.second) << "\"}";
    firstP = false;
  }
  o << "]}";
  std::cout << o.str() << std::endl;
  return 0;
}
