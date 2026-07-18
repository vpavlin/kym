// kym_engine.hpp — C++ port of the KYM budget fold. Mirrors @kym/engine
// (packages/engine/src/engine.mjs). The TS version is the reference; this must
// produce identical BudgetState (guarded by the parity test in module/test).
// Header-only, std-only (no Qt) so it can be unit-tested with plain g++ and then
// linked into the Basecamp module backend. See docs/data-model.md.
#pragma once
#include <string>
#include <vector>
#include <map>
#include <set>
#include <algorithm>
#include <cstdint>
#include <optional>
#include <stdexcept>

namespace kym {

using Money = int64_t; // integer milliunits

struct HLC { int64_t wall = 0; int64_t ctr = 0; std::string dev; };

// Total order: wall, then ctr, then dev — identical to compareHlc in hlc.mjs.
inline int compareHlc(const HLC& a, const HLC& b) {
  if (a.wall != b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.ctr != b.ctr) return a.ctr < b.ctr ? -1 : 1;
  return a.dev < b.dev ? -1 : (a.dev > b.dev ? 1 : 0);
}

struct Split { std::string categoryId; Money amount; };

// A generic event. String/number/bool fields live in maps so partial edits
// (txn.edit provides only changed keys) are represented by key presence.
struct Event {
  std::string id, type;
  HLC hlc;
  std::map<std::string, std::string> s;
  std::map<std::string, Money> n;
  std::map<std::string, bool> b;
  std::vector<Split> splits;
  bool hasSplits = false;
  bool has(const std::string& k) const { return s.count(k) || n.count(k) || b.count(k); }
};

struct Account { std::string id, name, type; bool onBudget; Money startingBalance; };
struct CategoryMonth { std::string categoryId, month; Money assigned, activity, available; };

struct BudgetState {
  std::string currentMonth;
  std::vector<Account> accounts;
  std::map<std::string, std::string> categoryGroup; // categoryId -> groupId
  std::vector<std::string> categoryIds;
  std::map<std::string, Money> balances;            // accountId -> balance
  std::vector<CategoryMonth> categoryMonths;
  std::map<std::string, Money> categoryAvailable;   // categoryId -> current available
  std::map<std::string, Money> creditCardPayments;  // accountId -> ccp available
  Money income = 0, totalAssigned = 0, cashOverspending = 0, readyToAssign = 0;
  size_t eventCount = 0;
};

inline const std::set<std::string> ASSET_TYPES = {"checking", "savings", "cash"};
inline const std::set<std::string> CREDIT_TYPES = {"creditCard", "lineOfCredit"};
inline const std::string RTA_INFLOW = "rta-inflow";

inline bool isCcp(const std::string& c) { return c.rfind("ccp:", 0) == 0; }
inline std::string monthOf(const std::string& date) { return date.substr(0, 7); } // YYYY-MM from ISO

// Union by id (idempotent) + HLC sort. Mirrors mergeEvents.
inline std::vector<Event> mergeEvents(const std::vector<Event>& events) {
  std::map<std::string, Event> byId;
  for (const auto& e : events) if (!byId.count(e.id)) byId[e.id] = e;
  std::vector<Event> out;
  out.reserve(byId.size());
  for (auto& kv : byId) out.push_back(kv.second);
  std::sort(out.begin(), out.end(), [](const Event& a, const Event& b) { return compareHlc(a.hlc, b.hlc) < 0; });
  return out;
}

inline std::string keyOf(const std::string& cat, const std::string& month) { return cat + " " + month; }

// The category legs a txn contributes (splits, or single category, or none).
struct TxnView {
  std::string accountId, date, categoryId, transferId;
  Money amount = 0;
  bool hasCategory = false, hasSplits = false;
  std::vector<Split> splits;
};

inline std::vector<Split> txnLegs(const TxnView& t) {
  if (t.hasSplits && !t.splits.empty()) {
    Money sum = 0; for (auto& sp : t.splits) sum += sp.amount;
    if (sum != t.amount) throw std::runtime_error("split amounts must sum to txn amount");
    return t.splits;
  }
  if (t.hasCategory) return {{t.categoryId, t.amount}};
  return {};
}

inline BudgetState computeState(const std::vector<Event>& rawEvents, std::optional<std::string> asOf = std::nullopt) {
  auto ordered = mergeEvents(rawEvents);
  BudgetState st;
  st.eventCount = ordered.size();

  std::map<std::string, Account> accounts;
  std::vector<std::string> accountOrder;
  std::set<std::string> categories;
  std::vector<std::string> categoryOrder;
  std::map<std::string, Money> assigned;   // key(cat,month) -> money
  std::set<std::string> months;

  // pass 1: entities + plan layer
  for (const auto& e : ordered) {
    if (e.type == "group.create") {
      // group name not needed for the fold's numbers
    } else if (e.type == "account.create") {
      Account a{e.s.at("accountId"), e.s.at("name"), e.s.at("accountType"),
                e.b.count("onBudget") ? e.b.at("onBudget") : true,
                e.n.count("startingBalance") ? e.n.at("startingBalance") : 0};
      if (!accounts.count(a.id)) accountOrder.push_back(a.id);
      accounts[a.id] = a;
    } else if (e.type == "account.edit") {
      auto it = accounts.find(e.s.at("accountId"));
      if (it != accounts.end() && e.s.count("name")) it->second.name = e.s.at("name");
    } else if (e.type == "category.create") {
      const auto& id = e.s.at("categoryId");
      if (!categories.count(id)) categoryOrder.push_back(id);
      categories.insert(id);
      st.categoryGroup[id] = e.s.count("groupId") ? e.s.at("groupId") : "";
    } else if (e.type == "assign") {
      const auto k = keyOf(e.s.at("categoryId"), e.s.at("month"));
      Money amt = e.n.at("amount");
      std::string mode = e.s.count("mode") ? e.s.at("mode") : "delta";
      if (mode == "set") assigned[k] = amt; else assigned[k] += amt;
      months.insert(e.s.at("month"));
    } else if (e.type == "move") {
      Money amt = e.n.at("amount");
      const auto& m = e.s.at("month");
      assigned[keyOf(e.s.at("fromCategoryId"), m)] -= amt;
      assigned[keyOf(e.s.at("toCategoryId"), m)] += amt;
      months.insert(m);
    }
  }

  // reconstruct txns (create + edits, sticky delete)
  struct Rec { TxnView v; bool deleted = false; bool exists = false; };
  std::map<std::string, Rec> txns;
  std::vector<std::string> txnOrder;
  auto applyFields = [](TxnView& v, const Event& e) {
    if (e.s.count("accountId")) v.accountId = e.s.at("accountId");
    if (e.s.count("date")) v.date = e.s.at("date");
    if (e.n.count("amount")) v.amount = e.n.at("amount");
    if (e.s.count("categoryId")) { v.categoryId = e.s.at("categoryId"); v.hasCategory = true; }
    if (e.s.count("transferId")) v.transferId = e.s.at("transferId");
    if (e.hasSplits) { v.splits = e.splits; v.hasSplits = true; }
  };
  for (const auto& e : ordered) {
    if (e.type == "txn.create") {
      auto& r = txns[e.s.at("txnId")];
      if (!r.exists) { r.exists = true; txnOrder.push_back(e.s.at("txnId")); }
      applyFields(r.v, e);
    } else if (e.type == "txn.edit") {
      auto it = txns.find(e.s.at("txnId"));
      if (it != txns.end()) applyFields(it->second.v, e);
    } else if (e.type == "txn.delete") {
      auto it = txns.find(e.s.at("txnId"));
      if (it != txns.end()) it->second.deleted = true;
    }
  }

  // pass 2: ledger layer
  std::map<std::string, Money> balance;
  std::map<std::string, Money> activity;
  std::map<std::string, Money>& ccp = st.creditCardPayments;
  Money income = 0;

  for (const auto& id : accountOrder) {
    const auto& a = accounts[id];
    balance[id] = a.startingBalance;
    if (a.onBudget && ASSET_TYPES.count(a.type)) income += a.startingBalance;
    if (a.onBudget && CREDIT_TYPES.count(a.type)) ccp[id] = 0;
  }

  for (const auto& tid : txnOrder) {
    auto& r = txns[tid];
    if (r.deleted) continue;
    const auto ait = accounts.find(r.v.accountId);
    if (ait == accounts.end()) continue;
    const auto& acct = ait->second;
    balance[r.v.accountId] += r.v.amount;
    auto legs = txnLegs(r.v);
    std::string month = monthOf(r.v.date);
    bool onCredit = acct.onBudget && CREDIT_TYPES.count(acct.type);
    for (const auto& leg : legs) {
      if (leg.categoryId == RTA_INFLOW) {
        income += leg.amount;
      } else if (isCcp(leg.categoryId)) {
        ccp[leg.categoryId.substr(4)] += leg.amount;
      } else {
        activity[keyOf(leg.categoryId, month)] += leg.amount;
        months.insert(month);
        if (onCredit) ccp[r.v.accountId] -= leg.amount;
      }
    }
    if (onCredit && legs.empty() && !r.v.transferId.empty() && r.v.amount > 0) {
      ccp[r.v.accountId] -= r.v.amount;
    }
  }

  // pass 3: rollover -> available, cash overspending
  std::vector<std::string> monthList(months.begin(), months.end());
  std::sort(monthList.begin(), monthList.end());
  std::string currentMonth = asOf ? *asOf : (monthList.empty() ? "" : monthList.back());
  std::vector<std::string> upto;
  for (const auto& m : monthList) if (currentMonth.empty() || m <= currentMonth) upto.push_back(m);
  if (!currentMonth.empty() && (upto.empty() || upto.back() != currentMonth)) upto.push_back(currentMonth);
  std::sort(upto.begin(), upto.end());

  Money cashOverspending = 0;
  for (const auto& cat : categoryOrder) {
    Money carry = 0, current = 0;
    for (const auto& m : upto) {
      Money a = assigned.count(keyOf(cat, m)) ? assigned[keyOf(cat, m)] : 0;
      Money act = activity.count(keyOf(cat, m)) ? activity[keyOf(cat, m)] : 0;
      Money avail = carry + a + act;
      st.categoryMonths.push_back({cat, m, a, act, avail});
      if (avail < 0 && m != currentMonth) cashOverspending += -avail;
      carry = std::max<Money>(0, avail);
      current = avail;
    }
    st.categoryAvailable[cat] = current;
  }

  Money totalAssigned = 0;
  for (auto& kv : assigned) totalAssigned += kv.second;

  st.currentMonth = currentMonth;
  for (const auto& id : accountOrder) st.accounts.push_back(accounts[id]);
  st.categoryIds = categoryOrder;
  st.balances = balance;
  st.income = income;
  st.totalAssigned = totalAssigned;
  st.cashOverspending = cashOverspending;
  st.readyToAssign = income - totalAssigned - cashOverspending;
  return st;
}

struct Invariant { Money assets, categoriesAvail, readyToAssign, rhs, diff; bool ok; };

inline Invariant checkInvariant(const BudgetState& st) {
  Money assets = 0;
  for (const auto& a : st.accounts)
    if (a.onBudget && ASSET_TYPES.count(a.type)) {
      auto it = st.balances.find(a.id);
      if (it != st.balances.end()) assets += it->second;
    }
  Money catAvail = 0;
  for (auto& kv : st.categoryAvailable) catAvail += kv.second;
  for (auto& kv : st.creditCardPayments) catAvail += kv.second;
  Money rhs = catAvail + st.readyToAssign;
  return {assets, catAvail, st.readyToAssign, rhs, assets - rhs, (assets - rhs) == 0};
}

} // namespace kym
