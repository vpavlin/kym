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

// The event envelope, HLC and CRDT merge now come from the shared logos-sync
// library (vendored under logos_sync/) — they were already byte-identical to
// KYM's hand-written copies, so this is a pure de-duplication. What stays KYM's:
// the Money/Split types, the app types (Account/BudgetState/…) and the whole
// budget fold below (logos-sync ADR 0007/0010).
#include "logos_sync/event.hpp"
#include "logos_sync/merge.hpp"

namespace kym {

using Money = int64_t; // integer milliunits

// Adopt the shared spine into the kym:: namespace so the rest of the module keeps
// compiling unchanged against kym::Event / kym::HLC etc. The event payload is now
// an opaque nlohmann::json object (was typed maps s/n/b + splits); the fold reads
// it directly via payload.value()/contains()/at().
using logos_sync::HLC;
using logos_sync::compareHlc;
using logos_sync::Event;
using logos_sync::eventToJson;
using logos_sync::eventFromJson;
using logos_sync::mergeEvents;

// Tolerant field read: the default when the key is missing, null, or the wrong type. nlohmann's
// value() THROWS on a null or wrong-typed field, and mobile sends e.g. `categoryId: null` for an
// uncategorized expense and a numeric `date` for a reconcile adjustment. One such event made every
// fold of the budget throw ("Invalid response" everywhere, the hub's snapshot timer failing).
template <class T>
inline T jget(const nlohmann::json& j, const char* key, T def) {
  if (!j.is_object()) return def;
  auto it = j.find(key);
  if (it == j.end() || it->is_null()) return def;
  try { return it->template get<T>(); } catch (...) { return def; }
}
inline std::string jget(const nlohmann::json& j, const char* key, const char* def) { return jget<std::string>(j, key, std::string(def)); }

struct Split { std::string categoryId; Money amount; };

struct Account { std::string id, name, type; bool onBudget; Money startingBalance; std::string currency; };
struct CategoryMonth { std::string categoryId, month; Money assigned, activity, available; };
struct Target { std::string type, targetMonth; Money amount; };
struct TargetProgress { std::string type, targetMonth; Money amount, needed, funded; bool onTrack; };

struct Member { std::string id, name, role; bool active = true; };

struct BudgetState {
  std::string currentMonth;
  bool isGroup = false;
  std::vector<Member> members;
  std::vector<Account> accounts;
  std::map<std::string, std::string> categoryGroup; // categoryId -> groupId
  std::vector<std::string> categoryIds;
  std::set<std::string> archivedCategories;         // hidden from the active list; history kept
  std::map<std::string, Money> balances;            // accountId -> balance
  std::vector<CategoryMonth> categoryMonths;
  std::map<std::string, Money> categoryAvailable;   // categoryId -> current available
  std::map<std::string, TargetProgress> targetProgress; // categoryId -> funding progress
  std::map<std::string, Money> creditCardPayments;  // accountId -> ccp available
  Money income = 0, totalAssigned = 0, cashOverspending = 0, readyToAssign = 0;
  size_t eventCount = 0;
};

inline const std::set<std::string> ASSET_TYPES = {"checking", "savings", "cash"};
inline const std::set<std::string> CREDIT_TYPES = {"creditCard", "lineOfCredit"};
inline const std::string RTA_INFLOW = "rta-inflow";

inline bool isCcp(const std::string& c) { return c.rfind("ccp:", 0) == 0; }
inline std::string monthOf(const std::string& date) { return date.substr(0, 7); } // YYYY-MM from ISO

inline std::string keyOf(const std::string& cat, const std::string& month) { return cat + " " + month; }

// Role-based admission for group budgets. Mirrors admitEvents in engine.mjs:
// until a group.init event appears every event is admitted (personal budget);
// afterwards member.* need an ADMIN author, budget events need an active
// admin/editor, and viewers/non-members are dropped. `ordered` must be HLC-sorted.
struct Admission { std::vector<Event> admitted; std::vector<Member> members; bool isGroup = false; };
inline Admission admitEvents(const std::vector<Event>& ordered) {
  Admission out;
  std::map<std::string, Member> members;      // memberId -> Member
  std::vector<std::string> order;             // stable insertion order
  auto get = [&](const std::string& id) -> Member* {
    auto it = members.find(id); return it == members.end() ? nullptr : &it->second;
  };
  for (const auto& e : ordered) {
    const std::string& author = e.hlc.dev;
    if (e.type == "group.init") {
      out.isGroup = true;
      std::string founder = jget(e.payload, "founderId", author);
      if (!members.count(founder)) {
        members[founder] = Member{founder, jget(e.payload, "founderName", founder), "admin", true};
        order.push_back(founder);
      }
      out.admitted.push_back(e);
      continue;
    }
    if (!out.isGroup) { out.admitted.push_back(e); continue; }
    Member* m = get(author);
    std::string role = (m && m->active) ? m->role : "";
    if (e.type == "member.add" || e.type == "member.role" || e.type == "member.remove") {
      if (role != "admin") continue;          // only admins manage members
      const std::string mid = jget(e.payload, "memberId", std::string());
      if (e.type == "member.add") {
        if (!mid.empty() && !members.count(mid)) {
          members[mid] = Member{mid, jget(e.payload, "name", mid), jget(e.payload, "role", std::string("viewer")), true};
          order.push_back(mid);
        }
      } else if (e.type == "member.role") {
        if (Member* t = get(mid)) t->role = jget(e.payload, "role", t->role);
      } else { // member.remove
        if (Member* t = get(mid)) t->active = false;
      }
      out.admitted.push_back(e);
    } else if (role == "admin" || role == "editor") {
      out.admitted.push_back(e);              // active editor+ may change the budget
    } // viewer / non-member budget events dropped
  }
  for (const auto& id : order) out.members.push_back(members[id]);
  return out;
}

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
  auto admission = admitEvents(mergeEvents(rawEvents));  // role-gated for groups; all-pass for personal
  auto ordered = admission.admitted;
  BudgetState st;
  st.isGroup = admission.isGroup;
  st.members = admission.members;
  st.eventCount = ordered.size();

  std::map<std::string, Account> accounts;
  std::vector<std::string> accountOrder;
  std::set<std::string> categories;
  std::vector<std::string> categoryOrder;
  std::map<std::string, Money> assigned;   // key(cat,month) -> money
  std::map<std::string, Target> targets;   // categoryId -> target
  std::set<std::string> months;

  // pass 1: entities + plan layer
  for (const auto& e : ordered) {
    if (e.type == "group.create") {
      // group name not needed for the fold's numbers
    } else if (e.type == "account.create") {
      Account a{jget(e.payload, "accountId", std::string()), jget(e.payload, "name", std::string()),
                jget(e.payload, "accountType", std::string()),
                jget(e.payload, "onBudget", true),
                jget(e.payload, "startingBalance", (Money)0),
                jget(e.payload, "currency", std::string())};
      if (!accounts.count(a.id)) accountOrder.push_back(a.id);
      accounts[a.id] = a;
    } else if (e.type == "account.edit") {
      auto it = accounts.find(jget(e.payload, "accountId", std::string()));
      if (it != accounts.end() && e.payload.contains("name")) it->second.name = jget(e.payload, "name", std::string());
    } else if (e.type == "category.create") {
      const auto id = jget(e.payload, "categoryId", std::string());
      if (!categories.count(id)) categoryOrder.push_back(id);
      categories.insert(id);
      st.categoryGroup[id] = jget(e.payload, "groupId", std::string());
    } else if (e.type == "category.target") {
      const auto cid = jget(e.payload, "categoryId", std::string());
      Money amt = jget(e.payload, "amount", (Money)0);
      if (!amt) targets.erase(cid);
      else targets[cid] = Target{jget(e.payload, "targetType", std::string()),
                                 jget(e.payload, "targetMonth", std::string()), amt};
    } else if (e.type == "assign") {
      const auto k = keyOf(jget(e.payload, "categoryId", std::string()), jget(e.payload, "month", std::string()));
      Money amt = jget(e.payload, "amount", (Money)0);
      std::string mode = jget(e.payload, "mode", std::string("delta"));
      if (mode == "set") assigned[k] = amt; else assigned[k] += amt;
      months.insert(jget(e.payload, "month", std::string()));
    } else if (e.type == "move") {
      Money amt = jget(e.payload, "amount", (Money)0);
      const auto m = jget(e.payload, "month", std::string());
      assigned[keyOf(jget(e.payload, "fromCategoryId", std::string()), m)] -= amt;
      assigned[keyOf(jget(e.payload, "toCategoryId", std::string()), m)] += amt;
      months.insert(m);
    } else if (e.type == "category.delete") {
      // Remove an (empty) category from the fold. kym_core only emits this for a
      // category with no assignments and no activity, so there's no orphaned money
      // to reconcile; drop it and any stray plan entries defensively.
      const auto id = jget(e.payload, "categoryId", std::string());
      categories.erase(id);
      st.categoryGroup.erase(id);
      categoryOrder.erase(std::remove(categoryOrder.begin(), categoryOrder.end(), id), categoryOrder.end());
      targets.erase(id);
      for (auto it = assigned.begin(); it != assigned.end(); )
        (it->first.rfind(id + " ", 0) == 0) ? it = assigned.erase(it) : ++it;
    } else if (e.type == "category.archive") {
      st.archivedCategories.insert(jget(e.payload, "categoryId", std::string()));   // stays in the fold; just flagged hidden
    } else if (e.type == "category.unarchive") {
      st.archivedCategories.erase(jget(e.payload, "categoryId", std::string()));
    }
    // group.delete has no numeric effect (groups are a display grouping); it's
    // applied in kym_core's name maps so the empty group stops rendering.
  }

  // reconstruct txns (create + edits, sticky delete)
  struct Rec { TxnView v; bool deleted = false; bool exists = false; };
  std::map<std::string, Rec> txns;
  std::vector<std::string> txnOrder;
  auto applyFields = [](TxnView& v, const Event& e) {
    if (e.payload.contains("accountId")) v.accountId = jget(e.payload, "accountId", std::string());
    if (e.payload.contains("date")) v.date = jget(e.payload, "date", std::string());
    if (e.payload.contains("amount")) v.amount = jget(e.payload, "amount", (Money)0);
    if (e.payload.contains("categoryId")) { v.categoryId = jget(e.payload, "categoryId", std::string()); v.hasCategory = true; }
    if (e.payload.contains("transferId")) v.transferId = jget(e.payload, "transferId", std::string());
    if (e.payload.contains("splits") && e.payload.at("splits").is_array()) {
      v.splits.clear();
      for (const auto& sp : e.payload.at("splits"))
        v.splits.push_back(Split{jget(sp, "categoryId", std::string()), jget(sp, "amount", (Money)0)});
      v.hasSplits = true;
    }
  };
  for (const auto& e : ordered) {
    if (e.type == "txn.create") {
      const auto tid = jget(e.payload, "txnId", std::string());
      auto& r = txns[tid];
      if (!r.exists) { r.exists = true; txnOrder.push_back(tid); }
      applyFields(r.v, e);
    } else if (e.type == "txn.edit") {
      auto it = txns.find(jget(e.payload, "txnId", std::string()));
      if (it != txns.end()) applyFields(it->second.v, e);
    } else if (e.type == "txn.delete") {
      auto it = txns.find(jget(e.payload, "txnId", std::string()));
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
        // Income only counts toward RTA when it lands in an on-budget ASSET
        // account. Income booked to a credit card / off-budget account has no
        // backing cash, so counting it inflates RTA and breaks the invariant
        // (assets never rose). Mirrors packages/engine/src/engine.mjs.
        if (acct.onBudget && ASSET_TYPES.count(acct.type)) income += leg.amount;
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
    // Uncategorized activity on an on-budget ASSET account flows to/from RTA
    // (unassigned money in/out) — keeps the invariant; matches imported txns.
    if (legs.empty() && r.v.transferId.empty() && acct.onBudget && ASSET_TYPES.count(acct.type)) {
      income += r.v.amount;
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

  // Target funding progress (mirrors engine.mjs).
  auto monthDiff = [](const std::string &a, const std::string &b) {
    return (std::stoi(b.substr(0, 4)) - std::stoi(a.substr(0, 4))) * 12 +
           (std::stoi(b.substr(5, 2)) - std::stoi(a.substr(5, 2)));
  };
  for (const auto &kv : targets) {
    const std::string &cid = kv.first; const Target &t = kv.second;
    Money avail = st.categoryAvailable.count(cid) ? st.categoryAvailable[cid] : 0;
    Money assignedThisMonth = assigned.count(keyOf(cid, currentMonth)) ? assigned[keyOf(cid, currentMonth)] : 0;
    Money needed = 0, funded = 0;
    if (t.type == "monthly") { funded = assignedThisMonth; needed = std::max<Money>(0, t.amount - assignedThisMonth); }
    else if (t.type == "balance") { funded = avail; needed = std::max<Money>(0, t.amount - avail); }
    else if (t.type == "balanceByDate" && !t.targetMonth.empty() && !currentMonth.empty()) {
      long monthsLeft = std::max<long>(1, monthDiff(currentMonth, t.targetMonth) + 1);
      Money remaining = std::max<Money>(0, t.amount - avail);
      Money perMonth = (remaining + monthsLeft - 1) / monthsLeft;
      needed = std::max<Money>(0, perMonth - std::max<Money>(0, assignedThisMonth));
      funded = avail;
    }
    st.targetProgress[cid] = TargetProgress{t.type, t.targetMonth, t.amount, needed, funded, needed == 0};
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
