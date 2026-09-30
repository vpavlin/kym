// Parity test: the C++ engine must produce the SAME numbers the TS reference
// asserts (packages/engine/test/engine.test.mjs) and the demo's §9 convergence
// example. Build & run:  g++ -std=c++17 -I../src parity.cpp -o parity && ./parity
#include "../src/kym_engine.hpp"
#include <iostream>
#include <functional>
#include <fstream>

using namespace kym;

static int failures = 0, checks = 0;
static void eq(Money got, Money want, const std::string& what) {
  checks++;
  if (got != want) { failures++; std::cerr << "  FAIL " << what << ": got " << got << " want " << want << "\n"; }
}
static void ok(bool cond, const std::string& what) {
  checks++;
  if (!cond) { failures++; std::cerr << "  FAIL " << what << "\n"; }
}

// --- tiny event builders (HLC assigned in monotonic order per test) ---
static int64_t T = 1000000;
static HLC h(const std::string& dev) { return HLC{T++, 0, dev}; }

static Event acct(const std::string& id, const std::string& name, const std::string& type, Money bal, const std::string& date) {
  Event e; e.id = "e" + std::to_string(T); e.type = "account.create"; e.hlc = h("A");
  e.payload["accountId"] = id; e.payload["name"] = name; e.payload["accountType"] = type;
  e.payload["startDate"] = date; e.payload["startingBalance"] = bal; e.payload["onBudget"] = true; return e;
}
static Event cat(const std::string& id, const std::string& name) {
  Event e; e.id = "e" + std::to_string(T); e.type = "category.create"; e.hlc = h("A");
  e.payload["categoryId"] = id; e.payload["groupId"] = "g1"; e.payload["name"] = name; return e;
}
static Event assign(const std::string& c, const std::string& m, Money amt) {
  Event e; e.id = "e" + std::to_string(T); e.type = "assign"; e.hlc = h("A");
  e.payload["categoryId"] = c; e.payload["month"] = m; e.payload["amount"] = amt; e.payload["mode"] = "delta"; return e;
}
static Event mv(const std::string& f, const std::string& t, const std::string& m, Money amt) {
  Event e; e.id = "e" + std::to_string(T); e.type = "move"; e.hlc = h("A");
  e.payload["fromCategoryId"] = f; e.payload["toCategoryId"] = t; e.payload["month"] = m; e.payload["amount"] = amt; return e;
}
static Event txn(const std::string& id, const std::string& acc, Money amt, const std::string& date,
                 const std::string& category, const std::string& dev = "A") {
  Event e; e.id = "e" + std::to_string(T); e.type = "txn.create"; e.hlc = h(dev);
  e.payload["txnId"] = id; e.payload["accountId"] = acc; e.payload["amount"] = amt; e.payload["date"] = date;
  if (!category.empty()) e.payload["categoryId"] = category; return e;
}

// --- group-budget builders (author = hlc.dev) ---
static Event assignBy(const std::string& dev, const std::string& c, const std::string& m, Money amt) {
  Event e; e.id = "e" + std::to_string(T); e.type = "assign"; e.hlc = h(dev);
  e.payload["categoryId"] = c; e.payload["month"] = m; e.payload["amount"] = amt; e.payload["mode"] = "delta"; return e;
}
static Event groupInit(const std::string& dev, const std::string& name) {
  Event e; e.id = "e" + std::to_string(T); e.type = "group.init"; e.hlc = h(dev);
  e.payload["name"] = name; e.payload["founderId"] = dev; e.payload["founderName"] = dev; return e;
}
static Event memberAdd(const std::string& admin, const std::string& id, const std::string& role) {
  Event e; e.id = "e" + std::to_string(T); e.type = "member.add"; e.hlc = h(admin);
  e.payload["memberId"] = id; e.payload["name"] = id; e.payload["role"] = role; return e;
}

static const std::string M = "2026-07";
static std::string d() { return M + "-15T12:00:00Z"; }

int main() {
  // 1. clean single-category budget (mirrors TS "clean single-category budget")
  {
    std::vector<Event> ev = {
      acct("chk", "Checking", "checking", 100000, d()),
      cat("groc", "Groceries"),
      assign("groc", M, 30000),
      txn("t1", "chk", -25000, d(), "groc"),
    };
    auto s = computeState(ev);
    eq(s.balances["chk"], 75000, "1.checking");
    eq(s.categoryAvailable["groc"], 5000, "1.groceries");
    eq(s.readyToAssign, 70000, "1.rta");
    ok(checkInvariant(s).ok, "1.invariant");
  }

  // 2. funded credit-card purchase relocates to the card payment category
  {
    std::vector<Event> ev = {
      acct("chk", "Checking", "checking", 100000, d()),
      acct("visa", "Visa", "creditCard", 0, d()),
      cat("groc", "Groceries"),
      assign("groc", M, 30000),
      txn("t1", "visa", -25000, d(), "groc"),
    };
    auto s = computeState(ev);
    eq(s.balances["visa"], -25000, "2.visa-debt");
    eq(s.categoryAvailable["groc"], 5000, "2.groceries");
    eq(s.creditCardPayments["visa"], 25000, "2.ccp");
    eq(s.readyToAssign, 70000, "2.rta");
    ok(checkInvariant(s).ok, "2.invariant");
  }

  // 3. cash overspend rolls off and reduces next month's RTA
  {
    std::string M2 = "2026-08";
    std::vector<Event> ev = {
      acct("chk", "Checking", "checking", 100000, d()),
      cat("groc", "Groceries"),
      assign("groc", M, 20000),
      txn("t1", "chk", -45000, d(), "groc"),
      assign("groc", M2, 0),
    };
    auto aug = computeState(ev, M2);
    eq(aug.categoryAvailable["groc"], 0, "3.groc-reset");
    eq(aug.cashOverspending, 25000, "3.cashover");
    eq(aug.readyToAssign, 55000, "3.rta");
    ok(checkInvariant(aug).ok, "3.invariant");
  }

  // 4. splits fan out and must sum to parent
  {
    Event split; split.id = "s1"; split.type = "txn.create"; split.hlc = h("A");
    split.payload["txnId"] = "t1"; split.payload["accountId"] = "chk"; split.payload["amount"] = -30000; split.payload["date"] = d();
    split.payload["splits"] = {{{"categoryId", "groc"}, {"amount", -18000}}, {{"categoryId", "home"}, {"amount", -12000}}};
    std::vector<Event> ev = {
      acct("chk", "Checking", "checking", 100000, d()),
      cat("groc", "Groceries"), cat("home", "Household"),
      assign("groc", M, 40000), assign("home", M, 40000), split,
    };
    auto s = computeState(ev);
    eq(s.categoryAvailable["groc"], 22000, "4.groc");
    eq(s.categoryAvailable["home"], 28000, "4.home");
    ok(checkInvariant(s).ok, "4.invariant");
  }

  // 5. the demo's §9 convergence example — two devices, order-independent
  {
    std::vector<Event> base = {
      acct("chk", "Checking", "checking", 100000, d()),
      cat("groc", "Groceries"), cat("dine", "Dining"),
    };
    std::vector<Event> A = { assign("groc", M, 60000), txn("A1", "chk", -25000, d(), "groc", "A") };
    std::vector<Event> B = { assign("dine", M, 40000), txn("B1", "chk", -30000, d(), "dine", "B"),
                             mv("groc", "dine", M, 10000) };
    std::vector<Event> orderX = base; orderX.insert(orderX.end(), A.begin(), A.end()); orderX.insert(orderX.end(), B.begin(), B.end());
    std::vector<Event> orderY = B; orderY.insert(orderY.end(), base.begin(), base.end()); orderY.insert(orderY.end(), A.begin(), A.end());
    auto sx = computeState(orderX);
    auto sy = computeState(orderY);
    eq(sx.balances["chk"], 45000, "5.chk");
    eq(sx.categoryAvailable["groc"], 25000, "5.groc");
    eq(sx.categoryAvailable["dine"], 20000, "5.dine");
    eq(sx.readyToAssign, 0, "5.rta");
    ok(checkInvariant(sx).ok, "5.invariant");
    // order independence: X and Y must match exactly
    ok(sx.balances == sy.balances, "5.converge-balances");
    ok(sx.categoryAvailable == sy.categoryAvailable, "5.converge-available");
    eq(sx.readyToAssign, sy.readyToAssign, "5.converge-rta");
  }

  // 6. group budgets — role admission mirrors engine.mjs group tests
  {
    // editor counts, viewer & non-member dropped; order-independent
    std::vector<Event> ev = {
      groupInit("A", "Household"),           // founder A (also authors cat() below) is admin
      memberAdd("A", "bob", "editor"),
      memberAdd("A", "carol", "viewer"),
      cat("groc", "Groceries"),              // authored by "A" (admin) → admitted
      assignBy("bob", "groc", M, 30000),     // editor → counts
      assignBy("carol", "groc", M, 9999),    // viewer → ignored
      assignBy("eve", "groc", M, 5000),      // non-member → ignored
    };
    auto s = computeState(ev);
    ok(s.isGroup, "6.isGroup");
    eq(s.categoryAvailable["groc"], 30000, "6.editor-counts-viewer-dropped");
    ok(s.members.size() == 3, "6.member-count");
    // order independence
    std::vector<Event> rev(ev.rbegin(), ev.rend());
    auto s2 = computeState(rev);
    eq(s2.categoryAvailable["groc"], 30000, "6.converge");
    // an editor cannot add members
    std::vector<Event> ev2 = ev;
    ev2.push_back(memberAdd("bob", "mallory", "editor")); // bob is editor, not admin → dropped
    auto s3 = computeState(ev2);
    ok(s3.members.size() == 3, "6.editor-cannot-add-member");
  }

  // 7. phone-shaped events (null categoryId / targetMonth / date / amount, epoch-ms
  //    dates, a null-category edit) — the SAME fixture + expectation the JS fold checks
  //    in packages/engine/test/phone-shaped.test.mjs. Neither fold may throw.
  {
    std::ifstream f("../../packages/engine/test/fixtures/phone-shaped.json");
    ok((bool)f, "7.fixture-readable (run from kym_core/test)");
    if (f) {
      nlohmann::json fx = nlohmann::json::parse(f);
      std::vector<Event> ev;
      for (const auto& j : fx["events"]) ev.push_back(eventFromJson(j));
      const auto& x = fx["expect"];
      auto s = computeState(ev);
      ok(s.currentMonth == x["currentMonth"].get<std::string>(), "7.currentMonth");
      for (auto& [k, v] : x["balances"].items()) eq(s.balances[k], v.get<Money>(), "7.balance " + k);
      for (auto& [k, v] : x["categoryAvailable"].items()) eq(s.categoryAvailable[k], v.get<Money>(), "7.available " + k);
      for (auto& [k, v] : x["creditCardPayments"].items()) eq(s.creditCardPayments[k], v.get<Money>(), "7.ccp " + k);
      for (auto& [k, v] : x["activity"].items()) {
        const auto bar = k.find('|');
        const std::string c = k.substr(0, bar), m = k.substr(bar + 1);
        Money act = 999999999;
        for (const auto& r : s.categoryMonths) if (r.categoryId == c && r.month == m) act = r.activity;
        eq(act, v.get<Money>(), "7.activity " + k);
      }
      eq(s.income, x["income"].get<Money>(), "7.income");
      eq(s.totalAssigned, x["totalAssigned"].get<Money>(), "7.totalAssigned");
      eq(s.cashOverspending, x["cashOverspending"].get<Money>(), "7.cashOverspending");
      eq(s.readyToAssign, x["readyToAssign"].get<Money>(), "7.rta");
      for (auto& [k, v] : x["targetNeeded"].items()) eq(s.targetProgress[k].needed, v.get<Money>(), "7.target " + k);
      ok(checkInvariant(s).ok == x["invariantOk"].get<bool>(), "7.invariant");
      std::vector<Event> rev(ev.rbegin(), ev.rend());
      eq(computeState(rev).readyToAssign, x["readyToAssign"].get<Money>(), "7.converge-rta");
      // jdate(): epoch ms renders as the UTC ISO timestamp JS toISOString() gives.
      nlohmann::json dj = {{"date", 1784541600000LL}};
      ok(jdate(dj, "date") == "2026-07-20T10:00:00.000Z", "7.jdate-epoch");
    }
  }

  // 8. delete guard: categoryHistory counts txn.edit re-categorization + splits, and
  //    ignores null categoryIds (same log/answer as phone-shaped.test.mjs).
  {
    auto mk = [](const std::string& type, nlohmann::json p) { Event e; e.id = "h" + std::to_string(T); e.type = type; e.hlc = h("d"); e.payload = p; return e; };
    std::vector<Event> log = {
      mk("category.create", {{"categoryId", "cat:empty"}, {"groupId", "g"}, {"name", "Empty"}}),
      mk("txn.create", {{"txnId", "t"}, {"accountId", "x"}, {"amount", -1}, {"date", "2026-07-01"}, {"categoryId", nullptr}}),
      mk("txn.edit", {{"txnId", "t"}, {"categoryId", "cat:edited"}}),
      mk("txn.edit", {{"txnId", "t"}, {"splits", {{{"categoryId", "cat:split"}, {"amount", -1}}}}}),
      mk("move", {{"fromCategoryId", "cat:from"}, {"toCategoryId", "cat:to"}, {"month", "2026-07"}, {"amount", 1}}),
    };
    ok(categoryHistory(log) == std::set<std::string>{"cat:edited", "cat:from", "cat:split", "cat:to"}, "8.categoryHistory");
  }

  std::cout << (failures ? "PARITY FAILED" : "PARITY OK") << " — " << (checks - failures) << "/" << checks << " checks passed\n";
  return failures ? 1 : 0;
}
