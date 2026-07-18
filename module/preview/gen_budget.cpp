// Drives the REAL C++ engine (kym_engine.hpp) with the same demo budget the
// module's loadDemo() seeds, and emits the budget JSON the grid QML renders.
// Proves the preview screenshot is engine-computed, not mocked.
//   g++ -std=c++17 -I../src gen_budget.cpp -o gen && ./gen > budget.json
#include "../src/kym_engine.hpp"
#include <iostream>
#include <sstream>
#include <map>
#include <vector>

using namespace kym;

static int64_t T = 1000000;
static HLC h() { return HLC{T++, 0, "basecamp"}; }
static std::string money(Money m) {
  char buf[32]; std::snprintf(buf, sizeof(buf), "%.2f", m / 1000.0); return buf;
}

int main() {
  const std::string M = "2026-07";
  const std::string d = M + "-15T12:00:00Z";
  std::vector<Event> ev;
  std::map<std::string, std::string> accName, catName, catGroup;
  std::vector<std::string> groupOrder = {"Bills", "Everyday", "Goals"};

  auto acct = [&](std::string id, std::string name, std::string type, Money bal) {
    Event e; e.id = "a" + id; e.type = "account.create"; e.hlc = h();
    e.s["accountId"] = id; e.s["name"] = name; e.s["accountType"] = type;
    e.s["startDate"] = d; e.n["startingBalance"] = bal; e.b["onBudget"] = true;
    ev.push_back(e); accName[id] = name;
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

  acct("chk", "Checking", "checking", 2500000);
  acct("visa", "Visa", "creditCard", 0);
  cat("rent", "Rent", "Bills"); cat("util", "Utilities", "Bills");
  cat("groc", "Groceries", "Everyday"); cat("dine", "Dining", "Everyday"); cat("fun", "Fun Money", "Everyday");
  cat("save", "Emergency Fund", "Goals");
  txn("chk", 3000000, RTA_INFLOW);
  assign("rent", 1200000); assign("util", 180000); assign("groc", 500000);
  assign("dine", 200000); assign("fun", 120000); assign("save", 400000);
  txn("chk", -1200000, "rent"); txn("chk", -164300, "groc"); txn("visa", -42800, "dine");

  BudgetState st = computeState(ev);
  Invariant inv = checkInvariant(st);

  auto rowFor = [&](const std::string &c) {
    Money a = 0, act = 0;
    for (auto &r : st.categoryMonths) if (r.categoryId == c && r.month == st.currentMonth) { a = r.assigned; act = r.activity; }
    return std::make_pair(a, act);
  };

  std::ostringstream o;
  o << "{";
  o << "\"currentMonth\":\"" << st.currentMonth << "\",";
  o << "\"readyToAssign\":\"" << money(st.readyToAssign) << "\",";
  o << "\"readyToAssignRaw\":" << st.readyToAssign << ",";
  o << "\"invariant\":{\"ok\":" << (inv.ok ? "true" : "false")
    << ",\"assets\":\"" << money(inv.assets) << "\",\"categoriesAvail\":\"" << money(inv.categoriesAvail)
    << "\",\"diff\":\"" << money(inv.diff) << "\"},";
  o << "\"accounts\":[";
  for (size_t i = 0; i < st.accounts.size(); i++) {
    auto &a = st.accounts[i];
    o << (i ? "," : "") << "{\"name\":\"" << accName[a.id] << "\",\"type\":\"" << a.type
      << "\",\"balance\":\"" << money(st.balances[a.id]) << "\"}";
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
      o << (firstC ? "" : ",") << "{\"name\":\"" << catName[cid] << "\",\"assigned\":\"" << money(a)
        << "\",\"activity\":\"" << money(act) << "\",\"available\":\"" << money(avail)
        << "\",\"negative\":" << (avail < 0 ? "true" : "false") << "}";
      firstC = false;
    }
    o << "]}";
  }
  o << "],\"creditCardPayments\":[";
  bool firstP = true;
  for (auto &kv : st.creditCardPayments) {
    o << (firstP ? "" : ",") << "{\"name\":\"" << accName[kv.first] << "\",\"available\":\"" << money(kv.second) << "\"}";
    firstP = false;
  }
  o << "]}";
  std::cout << o.str() << std::endl;
  return 0;
}
