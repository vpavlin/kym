#include "kym_core_impl.h"
#include "logos_sdk.h"          // umbrella: LogosModules + LogosMap(nlohmann::json)
#include "money_format.hpp"
#include "pgp_words.h"
#include "qrcodegen.hpp"
#include <cstdlib>
#include <cstdio>
#include <cctype>
#include <ctime>
#include <chrono>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <algorithm>
#include <QtCore/QTimer>
#include <QtCore/QObject>
#include <openssl/rand.h>
#include <openssl/sha.h>

using kym::b64encode;
using kym::b64decode;
using nlohmann::json;

// ---- small std helpers (ports of the Qt originals) -------------------------
namespace {
std::string uuidHex() {
    unsigned char b[16]; RAND_bytes(b, 16);
    static const char *hx = "0123456789abcdef";
    std::string s; for (int i = 0; i < 16; i++) { s.push_back(hx[b[i] >> 4]); s.push_back(hx[b[i] & 0xf]); }
    return s;
}
// human amount ("10.50", "-3") → integer milliunits (×1000), never float.
kym::Money toMilli(const std::string &in) {
    size_t i = 0; while (i < in.size() && std::isspace((unsigned char)in[i])) i++;
    bool neg = i < in.size() && in[i] == '-';
    std::string s; for (char c : in) if ((c >= '0' && c <= '9') || c == '.') s.push_back(c);
    if (s.empty()) return 0;
    auto dot = s.find('.');
    int64_t w = std::stoll("0" + (dot == std::string::npos ? s : s.substr(0, dot)));
    std::string frac = (dot == std::string::npos ? "" : s.substr(dot + 1)) + "000";
    int64_t f = std::stoll("0" + frac.substr(0, 3));
    int64_t v = w * 1000 + f;
    return neg ? -v : v;
}
std::string slug(const std::string &name) {
    std::string s; bool prevDash = false;
    for (char c : name) {
        char l = (c >= 'A' && c <= 'Z') ? char(c + 32) : c;
        if ((l >= 'a' && l <= 'z') || (l >= '0' && l <= '9')) { s.push_back(l); prevDash = false; }
        else if (!s.empty() && !prevDash) { s.push_back('-'); prevDash = true; }
    }
    while (!s.empty() && s.back() == '-') s.pop_back();
    return s.empty() ? uuidHex().substr(0, 8) : s;
}
std::string ymd() {  // YYYY-MM-DD (UTC)
    std::time_t t = std::time(nullptr); std::tm tm = *std::gmtime(&t);
    char b[16]; std::snprintf(b, sizeof b, "%04d-%02d-%02d", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday);
    return b;
}
kym::Event baseEvent(const std::string &type, const kym::HLC &hlc) {
    kym::Event e; e.id = uuidHex(); e.type = type; e.hlc = hlc; return e;
}
std::string money(kym::Money m, const std::string &ccy) { return kym::formatMoney(m, ccy); }
bool ciEq(const std::string &a, const std::string &b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); i++)
        if (std::tolower((unsigned char)a[i]) != std::tolower((unsigned char)b[i])) return false;
    return true;
}
// Crockford base32 — byte-compatible with the mobile app's pairing code
// (mobile/src/lib/identity.ts encodeSecret/decodeSecret). 32 bytes -> 52 chars.
static const char *B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
std::string b32encode(const kym::Bytes &s) {
    int bits = 0; uint32_t val = 0; std::string out;
    for (uint8_t b : s) { val = (val << 8) | b; bits += 8;
        while (bits >= 5) { out += B32[(val >> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
}
kym::Bytes b32decode(const std::string &code) {
    int bits = 0; uint32_t val = 0; kym::Bytes out;
    for (char raw : code) {
        char c = std::toupper((unsigned char)raw);
        if (c == 'O') c = '0'; else if (c == 'I' || c == 'L') c = '1'; else if (c == 'U') c = 'V';
        int idx = -1; for (int i = 0; i < 32; i++) if (B32[i] == c) { idx = i; break; }
        if (idx < 0) continue;
        val = (val << 5) | idx; bits += 5;
        if (bits >= 8) { out.push_back((val >> (bits - 8)) & 0xff); bits -= 8; }
    }
    return out;
}
// The delivery send() `bstr` payload must be a JSON byte ARRAY under the current
// cpp-sdk — passing a JSON string throws "type must be array, but is string" in
// the generated marshaling. This produces the SAME wire bytes as the old string
// form (delivery base64s the bytes either way), so a peer on either build still
// interops; it's just handed to the glue as an array of byte values.
LogosMap bytesPayload(const std::string &s) {
    LogosMap a = LogosMap::array();
    for (unsigned char c : s) a.push_back((unsigned)c);
    return a;
}
// NOTE: which in-process representation delivery's send() accepts (byte array vs
// string) differs by cpp-sdk build and is now chosen at runtime by
// KymCoreImpl::deliverySend (probe array→string, cache the winner) rather than a
// build-time/env default — so a GUI host that can't set env never crashes on it.
} // namespace

kym::HLC KymCoreImpl::nextHlc() {
    int64_t t = (int64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    if (t > cur().wall) { cur().wall = t; cur().ctr = 0; } else cur().ctr++;
    return kym::HLC{cur().wall, cur().ctr, m_deviceId};
}
std::string KymCoreImpl::currentMonth() const {
    std::time_t t = std::time(nullptr); std::tm tm = *std::gmtime(&t);
    char b[8]; std::snprintf(b, sizeof b, "%04d-%02d", tm.tm_year + 1900, tm.tm_mon + 1);
    return b;
}
void KymCoreImpl::setStatus(const std::string &s) { m_status = s; statusChanged(s); }

// ---- lifecycle -------------------------------------------------------------
void KymCoreImpl::onContextReady() {
    // Durable log dir — deliberately a SHARED, host-independent path, NOT the
    // per-instance instancePersistencePath(). Basecamp runs more than one
    // kym_core instance behind a ui plugin and routes successive callModule()
    // calls to different ones (an edit lands on instance A, the view's snapshot()
    // poll on instance B). They can only converge through a log they BOTH see, so
    // every instance must use the same directory. instancePersistencePath() is
    // per-instance and would isolate them permanently. ~/.kym-core is writable
    // from the module host (verified: edits do land there), and combined with the
    // reload-on-read/reload-on-write merging in snapshot()/pushEvent() the
    // instances converge. KYM_CORE_DATA overrides for tests/CLI.
    // See docs/logos-dev-notes.md.
    std::string dir;
    if (const char *d = std::getenv("KYM_CORE_DATA")) dir = d;
    else if (const char *h = std::getenv("HOME")) dir = std::string(h) + "/.kym-core";
    if (!dir.empty()) { std::error_code ec; std::filesystem::create_directories(dir, ec);
        m_dataDir = std::filesystem::exists(dir, ec) ? dir : std::string(); }
    if (const char *dev = std::getenv("KYM_DEVICE_ID")) m_deviceId = dev;
    // Author attribution (optional): the human name stamped on events THIS device
    // authors, so a shared budget can show who added / last-edited each txn. It's
    // accountability, not permission — every device on a household key is a full
    // writer; privacy stays per-budget. Env KYM_AUTHOR (hub) overrides the
    // persisted <root>/author.txt; empty = no attribution (single-user unaffected).
    if (const char *a = std::getenv("KYM_AUTHOR")) m_authorName = a;
    else if (!m_dataDir.empty()) { std::ifstream af(m_dataDir + "/author.txt"); if (af) std::getline(af, m_authorName); }

    // Load the budget registry (budgets.json). This migrates a legacy single
    // budget (root/log.json + root/pair.key) into the first entry, loads every
    // budget's log + household key, and sets the current selection.
    loadBudgets();
    m_ready = true;
    publishBudget();             // always publish so the ui gets initial state + fingerprint + pairing code
    // Delivery is NOT started here — touching delivery_module before it's fully up
    // crashes the host (change A did exactly that). Behind the desktop `kym` view
    // it's kicked from the view's snapshot() poll. A HEADLESS hub has no view, so
    // when KYM_HUB is set we drive it ourselves from hubLoop() — after a short
    // delay, once delivery_module has finished loading.
    if (std::getenv("KYM_HUB")) {
        setStatus("Hub: starting…");
        // Drive snapshot() from a QTimer on THIS (the host's main/event-loop)
        // thread. onContextReady runs on that thread, so the timer inherits its
        // affinity and every timeout — hence every bootstrapDelivery/sendSummary —
        // fires on the event-loop thread where the delivery async callbacks
        // actually dispatch. First tick at 4s (delivery_module is up by then;
        // touching it earlier crashes the host), then every 6s: kicks delivery,
        // reloads the shared log, runs the 30s-throttled RBSR reconcile, and
        // refreshes the heartbeat.
        m_hubTimer = new QTimer();
        QObject::connect(m_hubTimer, &QTimer::timeout, [this] { snapshot(); });
        m_hubTimer->setInterval(6000);
        QTimer::singleShot(4000, m_hubTimer, [this] { snapshot(); m_hubTimer->start(); });
    }
}

KymCoreImpl::~KymCoreImpl() {
    if (m_hubTimer) { m_hubTimer->stop(); m_hubTimer->deleteLater(); m_hubTimer = nullptr; }
}

// ---- event builders --------------------------------------------------------
std::string KymCoreImpl::ensureGroup(const std::string &name) {
    for (auto &kv : cur().groupName) if (ciEq(kv.second, name)) return kv.first;
    std::string gid = "grp:" + slug(name);
    auto e = baseEvent("group.create", nextHlc());
    e.s["groupId"] = gid; e.s["name"] = name;
    pushEvent(e, true);
    cur().groupName[gid] = name; cur().groupOrder.push_back(gid);
    return gid;
}
std::string KymCoreImpl::addAccountEv(const std::string &name, const std::string &type, kym::Money bal, const std::string &currency) {
    std::string id = "acct:" + slug(name);
    std::string ccy = currency.empty() ? cur().currency : currency;
    for (auto &c : ccy) c = std::toupper(c);
    auto e = baseEvent("account.create", nextHlc());
    e.s["accountId"] = id; e.s["name"] = name; e.s["accountType"] = type;
    e.s["startDate"] = ymd(); e.s["currency"] = ccy;
    e.n["startingBalance"] = bal; e.b["onBudget"] = (type != "tracking");
    pushEvent(e, true);
    cur().accountName[id] = name; cur().accountCurrency[id] = ccy;
    return id;
}
std::string KymCoreImpl::addCategoryEv(const std::string &name, const std::string &group) {
    std::string gid = ensureGroup(group.empty() ? "General" : group);
    std::string id = "cat:" + slug(name);
    auto e = baseEvent("category.create", nextHlc());
    e.s["categoryId"] = id; e.s["groupId"] = gid; e.s["name"] = name;
    pushEvent(e, true);
    cur().categoryName[id] = name; cur().categoryGroup[id] = gid;
    return id;
}
void KymCoreImpl::assignEv(const std::string &catId, const std::string &month, kym::Money amt) {
    auto e = baseEvent("assign", nextHlc());
    e.s["categoryId"] = catId; e.s["month"] = month; e.s["mode"] = "delta"; e.n["amount"] = amt;
    pushEvent(e, true);
}
void KymCoreImpl::moveEv(const std::string &fromId, const std::string &toId, const std::string &month, kym::Money amt) {
    auto e = baseEvent("move", nextHlc());
    e.s["fromCategoryId"] = fromId; e.s["toCategoryId"] = toId; e.s["month"] = month; e.n["amount"] = amt;
    pushEvent(e, true);
}
void KymCoreImpl::txnEv(const std::string &acctId, kym::Money amt, const std::string &month, const std::string &catId) {
    auto e = baseEvent("txn.create", nextHlc());
    e.s["txnId"] = uuidHex(); e.s["accountId"] = acctId; e.n["amount"] = amt;
    e.s["date"] = month + "-15T12:00:00Z";
    if (!catId.empty()) e.s["categoryId"] = catId;
    pushEvent(e, true);
}
std::string KymCoreImpl::findAccountId(const std::string &name) const {
    for (auto &kv : cur().accountName) if (ciEq(kv.second, name)) return kv.first;
    return "";
}
std::string KymCoreImpl::findCategoryId(const std::string &name) const {
    for (auto &kv : cur().categoryName) if (ciEq(kv.second, name)) return kv.first;
    return "";
}

// ---- public mutations ------------------------------------------------------
std::string KymCoreImpl::addAccount(std::string name, std::string type, std::string balance) {
    if (name.empty()) return "account name required";
    addAccountEv(name, type.empty() ? "checking" : type, toMilli(balance));
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::addGroup(std::string name) {
    if (name.empty()) return "group name required";
    ensureGroup(name);
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::addCategory(std::string name, std::string group) {
    if (name.empty()) return "category name required";
    addCategoryEv(name, group); publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::deleteCategory(std::string name) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    std::string cid = findCategoryId(name);
    if (cid.empty()) return "unknown category: " + name;
    // Refuse if the category has any assignment / move / transaction — deleting it
    // then would orphan money and break the zero-based invariant.
    for (const auto &e : cur().log) {
        bool refs = false;
        if (e.type == "assign" && e.s.count("categoryId") && e.s.at("categoryId") == cid) refs = true;
        else if (e.type == "move" && ((e.s.count("fromCategoryId") && e.s.at("fromCategoryId") == cid) ||
                                      (e.s.count("toCategoryId") && e.s.at("toCategoryId") == cid))) refs = true;
        else if (e.type == "txn.create" && e.s.count("categoryId") && e.s.at("categoryId") == cid) refs = true;
        for (const auto &sp : e.splits) if (sp.categoryId == cid) refs = true;
        if (refs) return "\"" + name + "\" has money or transactions — move them out first";
    }
    auto ev = baseEvent("category.delete", nextHlc());
    ev.s["categoryId"] = cid;
    pushEvent(ev, true);
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::deleteGroup(std::string name) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    std::string gid;
    for (auto &kv : cur().groupName) if (ciEq(kv.second, name)) { gid = kv.first; break; }
    if (gid.empty()) return "unknown group: " + name;
    for (auto &kv : cur().categoryGroup) if (kv.second == gid) return "\"" + name + "\" still has categories — delete them first";
    auto ev = baseEvent("group.delete", nextHlc());
    ev.s["groupId"] = gid;
    pushEvent(ev, true);
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::archiveCategory(std::string name) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    std::string cid = findCategoryId(name);
    if (cid.empty()) return "unknown category: " + name;
    // Must be emptied first — archiving a category with money would hide money.
    kym::BudgetState st = kym::computeState(cur().log);
    kym::Money avail = st.categoryAvailable.count(cid) ? st.categoryAvailable.at(cid) : 0;
    if (avail != 0) return "\"" + name + "\" still holds " + money(avail, cur().currency) +
                           " — move it to Ready to Assign (or another category) first, then archive";
    auto ev = baseEvent("category.archive", nextHlc());
    ev.s["categoryId"] = cid;
    pushEvent(ev, true);
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::unarchiveCategory(std::string name) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    std::string cid = findCategoryId(name);
    if (cid.empty()) return "unknown category: " + name;
    auto ev = baseEvent("category.unarchive", nextHlc());
    ev.s["categoryId"] = cid;
    pushEvent(ev, true);
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::editTxn(std::string txnId, std::string patchJson) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (txnId.empty()) return "txnId required";
    // patchJson is a small object of the fields to change, e.g.
    // {"amount":"900","account":"Visa","category":"Groceries","date":"2026-07-03"}.
    // A missing/empty key = unchanged. One string param keeps us under the module
    // glue's per-method argument cap (a 5-arg method silently no-ops).
    json patch;
    try { patch = patchJson.empty() ? json::object() : json::parse(patchJson); }
    catch (...) { return "bad patch json"; }
    auto pstr = [&](const char *k) -> std::string {
        if (!patch.contains(k) || patch[k].is_null()) return "";
        return patch[k].is_string() ? patch[k].get<std::string>() : patch[k].dump();
    };
    std::string amount = pstr("amount"), account = pstr("account"),
                category = pstr("category"), date = pstr("date");
    // Fold this one txn's history to learn its current category (so an amount-only
    // edit keeps the right sign). We do NOT gate on existence: in a synced budget
    // a txn.edit can arrive before the txn.create it references, and it must still
    // merge once the create lands — the fold is order-independent by design.
    std::string curCat;
    for (const auto &e : cur().log) {
        if (!e.s.count("txnId") || e.s.at("txnId") != txnId) continue;
        if ((e.type == "txn.create" || e.type == "txn.edit") && e.s.count("categoryId"))
            curCat = e.s.at("categoryId");
    }

    // A txn.edit carries ONLY the changed keys — the fold applies key-by-key, so
    // an untouched field keeps its last value even if another device edited it.
    auto ev = baseEvent("txn.edit", nextHlc());
    ev.s["txnId"] = txnId;
    bool toIncome = (curCat == kym::RTA_INFLOW);
    if (!category.empty()) {
        if (ciEq(category, "Income")) { ev.s["categoryId"] = kym::RTA_INFLOW; toIncome = true; }
        else {
            std::string cid = findCategoryId(category);
            if (cid.empty()) return "unknown category: " + category;
            ev.s["categoryId"] = cid; toIncome = false;
        }
    }
    if (!account.empty()) {
        std::string acc = findAccountId(account);
        if (acc.empty()) return "unknown account: " + account;
        ev.s["accountId"] = acc;
    }
    if (!date.empty()) ev.s["date"] = date.size() == 10 ? date + "T12:00:00Z" : date;
    if (!amount.empty()) {
        long long m = std::llabs(toMilli(amount));
        ev.n["amount"] = toIncome ? m : -m;   // expenses stay negative, income positive
    }
    pushEvent(ev, true);
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::setAuthorName(std::string name) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    m_authorName = name;
    if (!m_dataDir.empty()) { std::ofstream af(m_dataDir + "/author.txt"); if (af) af << name; }
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::deleteTxn(std::string txnId) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (txnId.empty()) return "txnId required";
    // Sticky tombstone: the fold sets deleted=true and never clears it, so a
    // concurrent edit can't resurrect a deleted txn (delete is terminal).
    auto ev = baseEvent("txn.delete", nextHlc());
    ev.s["txnId"] = txnId;
    pushEvent(ev, true);
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::assign(std::string category, std::string month, std::string amount) {
    std::string id = findCategoryId(category);
    if (id.empty()) return "unknown category: " + category;
    assignEv(id, month.empty() ? currentMonth() : month, toMilli(amount));
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::spend(std::string amount, std::string account, std::string category) {
    std::string acc = findAccountId(account), cat = findCategoryId(category);
    if (acc.empty()) return "unknown account: " + account;
    if (cat.empty()) return "unknown category: " + category;
    txnEv(acc, -std::llabs(toMilli(amount)), currentMonth(), cat);
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::income(std::string amount, std::string account) {
    std::string acc = findAccountId(account);
    if (acc.empty()) return "unknown account: " + account;
    txnEv(acc, std::llabs(toMilli(amount)), currentMonth(), kym::RTA_INFLOW);
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::setTarget(std::string category, std::string targetType, std::string amount, std::string month) {
    std::string cat = findCategoryId(category);
    if (cat.empty()) return "unknown category: " + category;
    auto e = baseEvent("category.target", nextHlc());
    e.s["categoryId"] = cat; e.s["targetType"] = targetType; e.n["amount"] = toMilli(amount);
    if (!month.empty()) e.s["targetMonth"] = month;
    pushEvent(e, true); publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::reconcile(std::string account, std::string actual) {
    std::string acc = findAccountId(account);
    if (acc.empty()) return "unknown account: " + account;
    kym::BudgetState st = kym::computeState(cur().log);
    kym::Money bal = st.balances.count(acc) ? st.balances[acc] : 0;
    kym::Money diff = toMilli(actual) - bal;
    if (diff != 0) txnEv(acc, diff, currentMonth(), "");   // uncategorized adjustment → RTA
    publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::moveMoney(std::string fromCategory, std::string toCategory, std::string month, std::string amount) {
    std::string f = findCategoryId(fromCategory), t = findCategoryId(toCategory);
    if (f.empty()) return "unknown category: " + fromCategory;
    if (t.empty()) return "unknown category: " + toCategory;
    moveEv(f, t, month.empty() ? currentMonth() : month, toMilli(amount));
    publishBudget(); return m_budgetJson;
}

// ---- group budgets ---------------------------------------------------------
std::string KymCoreImpl::adminGuard() {
    auto st = kym::computeState(cur().log);
    if (!st.isGroup) return "not a group budget — run groupInit first";
    for (auto &m : st.members) if (m.id == m_deviceId && m.active && m.role == "admin") return "";
    return "only an admin can manage members";
}
std::string KymCoreImpl::groupInit(std::string name) {
    if (kym::computeState(cur().log).isGroup) return "this budget is already a group";
    auto e = baseEvent("group.init", nextHlc());
    e.s["name"] = name.empty() ? "Household" : name; e.s["founderId"] = m_deviceId; e.s["founderName"] = m_deviceId;
    pushEvent(e, true); publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::addMember(std::string memberId, std::string name, std::string role) {
    if (memberId.empty()) return "member device id required";
    std::string r = role.empty() ? "editor" : role; for (auto &c : r) c = std::tolower(c);
    if (r != "admin" && r != "editor" && r != "viewer") return "role must be admin|editor|viewer";
    std::string g = adminGuard(); if (!g.empty()) return g;
    auto e = baseEvent("member.add", nextHlc());
    e.s["memberId"] = memberId; e.s["name"] = name.empty() ? memberId : name; e.s["role"] = r;
    pushEvent(e, true); publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::setMemberRole(std::string memberId, std::string role) {
    std::string r = role; for (auto &c : r) c = std::tolower(c);
    if (r != "admin" && r != "editor" && r != "viewer") return "role must be admin|editor|viewer";
    std::string g = adminGuard(); if (!g.empty()) return g;
    auto e = baseEvent("member.role", nextHlc());
    e.s["memberId"] = memberId; e.s["role"] = r;
    pushEvent(e, true); publishBudget(); return m_budgetJson;
}
std::string KymCoreImpl::removeMember(std::string memberId) {
    std::string g = adminGuard(); if (!g.empty()) return g;
    auto e = baseEvent("member.remove", nextHlc());
    e.s["memberId"] = memberId;
    pushEvent(e, true); publishBudget(); return m_budgetJson;
}

std::string KymCoreImpl::loadDemo() {
    if (!cur().log.empty()) return "budget already has data";
    const std::string m = currentMonth();
    std::string chk = addAccountEv("Checking", "checking", toMilli("30000"));
    addAccountEv("Visa", "creditCard", 0);
    addAccountEv("Revolut", "tracking", toMilli("420"), "EUR");
    std::string rent = addCategoryEv("Rent", "Bills");
    std::string util = addCategoryEv("Utilities", "Bills");
    std::string groc = addCategoryEv("Groceries", "Everyday");
    std::string dine = addCategoryEv("Dining", "Everyday");
    std::string fun = addCategoryEv("Fun Money", "Everyday");
    std::string save = addCategoryEv("Emergency Fund", "Goals");
    txnEv(chk, toMilli("45000"), m, kym::RTA_INFLOW);
    assignEv(rent, m, toMilli("18000")); assignEv(util, m, toMilli("3000"));
    assignEv(groc, m, toMilli("8000")); assignEv(dine, m, toMilli("3000"));
    assignEv(fun, m, toMilli("2000")); assignEv(save, m, toMilli("5000"));
    txnEv(chk, -std::llabs(toMilli("18000")), m, rent);
    txnEv(chk, -std::llabs(toMilli("2450")), m, groc);
    txnEv(findAccountId("Visa"), -std::llabs(toMilli("680")), m, dine);
    publishBudget(); return m_budgetJson;
}

// ---- read surface ----------------------------------------------------------
std::string KymCoreImpl::budgetJson() { return m_budgetJson; }
std::string KymCoreImpl::status() { return m_status; }
std::string KymCoreImpl::fingerprint() { return cur().fingerprint; }
std::string KymCoreImpl::logFingerprint() {
    std::vector<kym::rbsr::Item> items;
    for (auto &e : cur().log) items.push_back({e.hlc.wall, e.id});
    return kym::rbsr::fingerprint(items);
}

// ---- name maps + budget JSON ----------------------------------------------
void KymCoreImpl::rebuildNameMaps() {
    auto sv = [](const kym::Event &e, const char *k) -> std::string {
        auto it = e.s.find(k); return it == e.s.end() ? std::string() : it->second;
    };
    cur().accountName.clear(); cur().categoryName.clear(); cur().groupName.clear();
    cur().categoryGroup.clear(); cur().accountCurrency.clear(); cur().groupOrder.clear();
    for (const auto &e : kym::mergeEvents(cur().log)) {
        if (e.type == "group.create") {
            std::string id = sv(e, "groupId");
            if (!cur().groupName.count(id)) { cur().groupName[id] = sv(e, "name"); cur().groupOrder.push_back(id); }
        } else if (e.type == "account.create") {
            std::string id = sv(e, "accountId"); cur().accountName[id] = sv(e, "name");
            std::string c = sv(e, "currency"); cur().accountCurrency[id] = c.empty() ? cur().currency : c;
        } else if (e.type == "account.edit") {
            std::string id = sv(e, "accountId"); if (!sv(e, "name").empty()) cur().accountName[id] = sv(e, "name");
        } else if (e.type == "category.create") {
            std::string id = sv(e, "categoryId"); cur().categoryName[id] = sv(e, "name"); cur().categoryGroup[id] = sv(e, "groupId");
        } else if (e.type == "category.edit") {
            std::string id = sv(e, "categoryId");
            if (!sv(e, "name").empty()) cur().categoryName[id] = sv(e, "name");
            if (!sv(e, "groupId").empty()) cur().categoryGroup[id] = sv(e, "groupId");
        } else if (e.type == "category.delete") {
            std::string id = sv(e, "categoryId");
            cur().categoryName.erase(id); cur().categoryGroup.erase(id);
        } else if (e.type == "group.delete") {
            std::string id = sv(e, "groupId");
            cur().groupName.erase(id);
            cur().groupOrder.erase(std::remove(cur().groupOrder.begin(), cur().groupOrder.end(), id), cur().groupOrder.end());
        }
    }
}

// Set the month the ui is viewing (""=live calendar month). Folds asOf that
// month so Available reflects everything rolled forward up to it.
std::string KymCoreImpl::setViewMonth(std::string month) {
    cur().viewMonth = month;   // trust the ui's YYYY-MM (or "" to reset)
    publishBudget(); return m_budgetJson;
}

void KymCoreImpl::publishBudget() {
    rebuildNameMaps();
    // Default to the LIVE calendar month (not the latest month with data), so a
    // fresh month shows last month's Available rolled forward instead of being
    // stuck on the last month you touched. cur().viewMonth overrides for navigation.
    const std::string viewMonth = cur().viewMonth.empty() ? currentMonth() : cur().viewMonth;
    kym::BudgetState st = kym::computeState(cur().log, viewMonth);
    // The invariant is a GLOBAL "every unit of money is accounted for" identity —
    // fold WITHOUT asOf (latest month, ALL assignments included). Checking it
    // against the viewMonth fold made a future-month assignment break it
    // spuriously: that assignment lowers the global Ready-to-Assign but isn't in
    // the current month's category totals, so assets = categories + RTA stopped
    // tying out. `st` (viewMonth) drives the grid; the full fold drives the check.
    kym::Invariant inv = kym::checkInvariant(kym::computeState(cur().log));
    const std::string bc = cur().currency;
    auto nameOf = [](std::map<std::string, std::string> &m, const std::string &id) { auto it = m.find(id); return it == m.end() ? id : it->second; };
    auto rowFor = [&](const std::string &cat) -> std::pair<kym::Money, kym::Money> {
        kym::Money a = 0, act = 0;
        for (const auto &r : st.categoryMonths) if (r.categoryId == cat && r.month == st.currentMonth) { a = r.assigned; act = r.activity; }
        return {a, act};
    };

    // Earliest month carrying data — the ui stops back-navigation here (going
    // further just shows empty months). Future navigation is unbounded (budget
    // ahead). Derived from the folded per-category months.
    std::string earliest;
    for (const auto &r : st.categoryMonths)
        if (earliest.empty() || r.month < earliest) earliest = r.month;
    if (earliest.empty()) earliest = viewMonth;

    json root;
    root["currency"] = bc;
    root["currentMonth"] = st.currentMonth;
    root["viewMonth"] = viewMonth;
    root["isCurrentMonth"] = (viewMonth == currentMonth());
    root["liveMonth"] = currentMonth();
    root["earliestMonth"] = earliest;
    root["readyToAssign"] = money(st.readyToAssign, bc);
    root["readyToAssignRaw"] = (double)st.readyToAssign;
    root["isGroup"] = st.isGroup;
    json members = json::array();
    for (const auto &mem : st.members)
        members.push_back({{"id", mem.id}, {"name", mem.name}, {"role", mem.role}, {"active", mem.active}, {"you", mem.id == m_deviceId}});
    root["members"] = members;
    root["invariant"] = {{"ok", inv.ok}, {"assets", money(inv.assets, bc)}, {"categoriesAvail", money(inv.categoriesAvail, bc)}, {"diff", money(inv.diff, bc)}};

    json accs = json::array();
    for (const auto &a : st.accounts) {
        std::string ac = cur().accountCurrency.count(a.id) ? cur().accountCurrency[a.id] : bc;
        accs.push_back({{"id", a.id}, {"name", nameOf(cur().accountName, a.id)}, {"type", a.type},
                        {"onBudget", a.onBudget}, {"balance", money(st.balances.count(a.id) ? st.balances.at(a.id) : 0, ac)}});
    }
    root["accounts"] = accs;

    // Categories that carry any assignment/transaction history — those can only be
    // ARCHIVED (hidden, history preserved), never deleted; a history-free category
    // can be deleted outright. The view uses canDelete to pick delete vs archive.
    std::set<std::string> catsWithHistory;
    for (const auto &e : cur().log) {
        if (e.type == "assign" && e.s.count("categoryId")) catsWithHistory.insert(e.s.at("categoryId"));
        else if (e.type == "move") { if (e.s.count("fromCategoryId")) catsWithHistory.insert(e.s.at("fromCategoryId")); if (e.s.count("toCategoryId")) catsWithHistory.insert(e.s.at("toCategoryId")); }
        else if (e.type == "txn.create" && e.s.count("categoryId")) catsWithHistory.insert(e.s.at("categoryId"));
        for (const auto &sp : e.splits) catsWithHistory.insert(sp.categoryId);
    }
    json groups = json::array();
    for (const auto &gid : cur().groupOrder) {
        json cats = json::array();
        for (const auto &cid : st.categoryIds) {
            if ((cur().categoryGroup.count(cid) ? cur().categoryGroup[cid] : std::string()) != gid) continue;
            auto pr = rowFor(cid);
            kym::Money avail = st.categoryAvailable.count(cid) ? st.categoryAvailable.at(cid) : 0;
            std::string tgt; bool tgtOk = true;
            auto tit = st.targetProgress.find(cid);
            if (tit != st.targetProgress.end()) {
                tgtOk = tit->second.onTrack;
                tgt = tgtOk ? "\xF0\x9F\x8E\xAF funded" : ("\xF0\x9F\x8E\xAF need " + money(tit->second.needed, bc));
            }
            cats.push_back({{"id", cid}, {"name", nameOf(cur().categoryName, cid)},
                            {"assigned", money(pr.first, bc)}, {"assignedRaw", (double)pr.first},
                            {"activity", money(pr.second, bc)}, {"available", money(avail, bc)},
                            {"availableRaw", (double)avail}, {"negative", avail < 0},
                            {"target", tgt}, {"targetOnTrack", tgtOk},
                            {"archived", st.archivedCategories.count(cid) > 0}, {"canDelete", catsWithHistory.count(cid) == 0}});
        }
        groups.push_back({{"id", gid}, {"name", nameOf(cur().groupName, gid)}, {"categories", cats}});
    }
    // ORPHAN categories: a category whose group.create hasn't arrived (e.g. only
    // half of a two-event add synced across a flaky mesh) references a groupId
    // not in cur().groupOrder — the loop above skips it, making the category
    // invisible. Never drop a real category: gather orphans into reconstructed
    // groups (display name humanized from the slug id) so they always render.
    {
        std::set<std::string> known(cur().groupOrder.begin(), cur().groupOrder.end());
        std::map<std::string, json> orphanGroups;   // groupId -> categories array
        std::vector<std::string> orphanOrder;
        for (const auto &cid : st.categoryIds) {
            std::string gid = cur().categoryGroup.count(cid) ? cur().categoryGroup[cid] : std::string();
            if (gid.empty() || known.count(gid)) continue;   // rendered above (or truly ungrouped)
            if (!orphanGroups.count(gid)) { orphanGroups[gid] = json::array(); orphanOrder.push_back(gid); }
            auto pr = rowFor(cid);
            kym::Money avail = st.categoryAvailable.count(cid) ? st.categoryAvailable.at(cid) : 0;
            orphanGroups[gid].push_back({{"id", cid}, {"name", nameOf(cur().categoryName, cid)},
                {"assigned", money(pr.first, bc)}, {"assignedRaw", (double)pr.first},
                {"activity", money(pr.second, bc)}, {"available", money(avail, bc)},
                {"availableRaw", (double)avail}, {"negative", avail < 0},
                {"target", std::string()}, {"targetOnTrack", true},
                {"archived", st.archivedCategories.count(cid) > 0}, {"canDelete", catsWithHistory.count(cid) == 0}});
        }
        for (const auto &gid : orphanOrder) {
            // Humanize "grp:test-group-from-crib" -> "test group from crib".
            std::string nm = gid.rfind("grp:", 0) == 0 ? gid.substr(4) : gid;
            for (auto &c : nm) if (c == '-') c = ' ';
            groups.push_back({{"id", gid}, {"name", nm}, {"categories", orphanGroups[gid]}});
        }
    }
    root["groups"] = groups;

    json ccp = json::array();
    for (const auto &kv : st.creditCardPayments)
        ccp.push_back({{"account", kv.first}, {"name", nameOf(cur().accountName, kv.first)}, {"available", money(kv.second, bc)}});
    root["creditCardPayments"] = ccp;

    root["status"] = m_status;          // carried in the JSON so the ui gets them
    root["fingerprint"] = cur().fingerprint; // via budgetChanged (no separate getters)
    root["pairingCode"] = cur().haveKey ? b32encode(cur().identity.secret) : "";  // share to pair another device
    root["paired"] = m_nodeReady;       // connected to the household topic
    // Sync telemetry: rx/tx counters so "nothing is happening" is distinguishable
    // from "messages arrive but are all dropped". openFail>0 means traffic IS
    // reaching us but under a different household key.
    root["sync"] = { {"peers", m_peerCount}, {"rxSeen", m_rxSeen}, {"rxOpened", m_rxOpened},
                     {"rxOpenFail", m_rxOpenFail}, {"rxNew", m_rxNew}, {"rxDup", m_rxDup},
                     {"rxDropped", m_rxDropped}, {"tx", m_txTotal} };

    // --- Transaction list (expenses / income) for the ui TX view -------------
    // Light fold of the log's txn events (create + edit + sticky delete), newest
    // first. A leg on the rta-inflow pseudo-category is income; everything else is
    // an expense (amount < 0 = money out). Splits are summed to a single row.
    {
        struct Tx { std::string date, acctId, catId, author; long long amount = 0; bool del = false, seen = false; };
        std::map<std::string, Tx> txs; std::vector<std::string> order;
        auto apply = [](Tx &t, const kym::Event &e) {
            if (e.s.count("date")) t.date = e.s.at("date");
            if (e.s.count("accountId")) t.acctId = e.s.at("accountId");
            if (e.s.count("categoryId")) t.catId = e.s.at("categoryId");
            if (e.s.count("author")) t.author = e.s.at("author");   // last device to touch it
            if (e.n.count("amount")) t.amount = (long long)e.n.at("amount");
        };
        for (const auto &e : cur().log) {
            const std::string id = e.s.count("txnId") ? e.s.at("txnId") : e.id;
            if (e.type == "txn.create") { Tx &t = txs[id]; if (!t.seen) { t.seen = true; order.push_back(id); } apply(t, e); }
            else if (e.type == "txn.edit" && txs.count(id)) apply(txs[id], e);
            else if (e.type == "txn.delete" && txs.count(id)) txs[id].del = true;
        }
        json txns = json::array();
        for (auto it = order.rbegin(); it != order.rend(); ++it) {
            const Tx &t = txs[*it];
            if (t.del) continue;
            const bool income = (t.catId == kym::RTA_INFLOW);
            txns.push_back({ {"id", *it}, {"date", t.date}, {"account", nameOf(cur().accountName, t.acctId)},
                             {"category", income ? std::string("Income") : nameOf(cur().categoryName, t.catId)},
                             {"amountRaw", (double)t.amount}, {"amount", money(t.amount, bc)},
                             {"author", t.author}, {"kind", income ? "income" : "expense"} });
        }
        root["transactions"] = txns;
    }

    // --- Raw event log (dev debug view) --------------------------------------
    // Every event, newest first, with a flattened payload — for the ui debug panel.
    {
        json evs = json::array();
        for (size_t i = cur().log.size(); i-- > 0; ) {
            const auto &e = cur().log[i];
            json p = json::object();
            for (auto &kv : e.s) p[kv.first] = kv.second;
            for (auto &kv : e.n) p[kv.first] = (double)kv.second;
            for (auto &kv : e.b) p[kv.first] = kv.second;
            evs.push_back({ {"seq", (int)i}, {"type", e.type}, {"wall", (double)e.hlc.wall},
                            {"dev", e.hlc.dev}, {"id", e.id}, {"payload", p} });
        }
        root["events"] = evs;
    }

    // Multiple budgets: the switcher list + the current selection + its color, so
    // the view can make "which budget am I in" unmistakable (and colour the ops).
    {
        json bl = json::array();
        for (const auto &id : m_order) {
            auto it = m_budgets.find(id); if (it == m_budgets.end()) continue;
            const Budget &b = it->second;
            bl.push_back({ {"id", b.id}, {"name", b.name}, {"color", b.color},
                           {"current", id == m_current}, {"events", (int)b.log.size()} });
        }
        root["budgets"] = bl;
        root["currentBudget"] = m_current;
        root["currentBudgetName"] = m_budgets.count(m_current) ? m_budgets[m_current].name : std::string();
        root["currentBudgetColor"] = m_budgets.count(m_current) ? m_budgets[m_current].color : std::string("#7dd3fc");
        root["authorName"] = m_authorName;   // this device's attribution name ("" = off)
    }

    m_budgetJson = root.dump();
    budgetChanged(m_budgetJson);
}

// initial state — kym_core loads before the ui and may have published already).

// ---- log persistence -------------------------------------------------------
void KymCoreImpl::pushEvent(const kym::Event &e0, bool broadcast) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    // Stamp local authorship before the event is persisted/sent, so peers (and the
    // TX list) can attribute it. e.id is content-independent, so this doesn't
    // affect dedup. Only locally-authored events flow through pushEvent; received
    // ones keep the sender's author via ingestRaw.
    kym::Event e = e0;
    if (!m_authorName.empty() && !e.s.count("author")) e.s["author"] = m_authorName;
    // Multi-instance safety: Basecamp can run more than one kym_core instance
    // behind a ui plugin (distinct LOGOS_INSTANCE_IDs). They share the on-disk
    // log; merge it in BEFORE appending so a stale in-memory instance can't
    // clobber another instance's events when it saves. Deterministic ids +
    // dedup-by-id make the merge safe. loadPersistedLog no-ops if not persisting.
    loadPersistedLog(cur());
    if (cur().ids.count(e.id)) { m_rxDup++; return; }
    m_rxNew++;
    cur().log.push_back(e); cur().ids.insert(e.id);
    savePersistedLog(cur());
    if (broadcast && m_nodeReady) sealAndSend(cur(), e);
}
void KymCoreImpl::savePersistedLog(Budget &b) {
    if (b.dir.empty()) return;
    json arr = json::array();
    for (auto &e : b.log) arr.push_back(kym::encodeEventEnvelopeStd(e));  // each entry = an EVENT envelope string
    std::ofstream f(b.dir + "/log.json"); if (f) f << arr.dump();
}
void KymCoreImpl::loadPersistedLog(Budget &b) {
    if (b.dir.empty()) return;
    std::ifstream f(b.dir + "/log.json"); if (!f) return;
    std::stringstream ss; ss << f.rdbuf();
    auto arr = json::parse(ss.str(), nullptr, false);
    if (!arr.is_array()) return;
    for (auto &s : arr) {
        kym::Event e;
        if (s.is_string() && kym::decodeEventEnvelopeStd(s.get<std::string>(), e) && !b.ids.count(e.id)) {
            b.log.push_back(e); b.ids.insert(e.id);
        }
    }
}

// ---- household key + sync --------------------------------------------------
// Derive identity + topic + fingerprint from a 32-byte secret; optionally persist
// it to pair.key. Publishes + bootstraps delivery once the context is ready.
void KymCoreImpl::applySecret(Budget &b, const kym::Bytes &secret, bool persist) {
    b.identity = kym::deriveIdentity(secret);
    b.topic = kym::topicFor(b.identity);
    unsigned char h[32]; SHA256(b.identity.K.data(), b.identity.K.size(), h);
    b.fingerprint = std::string(kPgpEven[h[0]]) + " " + kPgpOdd[h[1]] + " " + kPgpEven[h[2]];
    b.haveKey = true;
    if (persist && !b.dir.empty()) {
        std::error_code ec; std::filesystem::create_directories(b.dir, ec);
        std::ofstream f(b.dir + "/pair.key", std::ios::binary);
        if (f) f.write(reinterpret_cast<const char *>(secret.data()), (std::streamsize)secret.size());
    }
    // If delivery is already up, join this budget's topic + reconcile it. Else the
    // first snapshot()/hub tick kicks bootstrapDelivery which subscribes them all.
    if (m_nodeReady) {
        b.subscribed = true;
        modules().delivery_module.subscribeAsync(b.topic, [](StdLogosResult) {});
        sendSummary(b);
    }
    if (m_ready) publishBudget();
    if (m_ready && !m_nodeReady) bootstrapDelivery();
}

std::string KymCoreImpl::setSecret(std::string secretHex) {
    kym::Bytes s = kym::fromHex(secretHex);
    if (s.size() != 32) return "secret must be 32 bytes (64 hex chars)";
    applySecret(cur(), s, false);
    return "";
}

// env KYM_HOUSEHOLD_SECRET (hex, first budget only) > pair.key file > generate a
// fresh household (this device becomes the host; the pairing code is in budgetJson).
void KymCoreImpl::loadOrCreateSecret(Budget &b) {
    kym::Bytes secret;
    // The env secret seeds only a budget with no key yet AND no persisted key —
    // used for tests / the first migrated budget, never to clobber a paired one.
    if (const char *hex = std::getenv("KYM_HOUSEHOLD_SECRET")) {
        std::string h(hex); if (h.size() >= 64) secret = kym::fromHex(h.substr(0, 64));
    }
    if (secret.size() != 32 && !b.dir.empty()) {
        std::ifstream f(b.dir + "/pair.key", std::ios::binary);
        if (f) { std::string raw((std::istreambuf_iterator<char>(f)), {});
            if (raw.size() >= 32) secret.assign(raw.begin(), raw.begin() + 32); }
    }
    if (secret.size() != 32) { secret.resize(32); RAND_bytes(secret.data(), 32); applySecret(b, secret, true); return; }
    applySecret(b, secret, false);
}

// ---- multiple budgets ------------------------------------------------------
static const char *kBudgetColors[] = {"#7dd3fc", "#a78bfa", "#4ade80", "#f472b6", "#fbbf24", "#fb7185"};

// A budget's colour derives from its household TOPIC (identical on every device
// that shares the secret) via FNV-1a — replicated byte-for-byte in the mobile app
// (mobile/src/lib/budgets.ts budgetColorForSeed) so both platforms pick the SAME
// palette entry for a household. Local budget ids differ per device, so they can't
// be the seed; the topic can.
static std::string budgetColorForSeed(const std::string &seed) {
    uint32_t h = 2166136261u;
    for (char c : seed) { h ^= (uint8_t)c; h *= 16777619u; }
    return kBudgetColors[h % 6];
}

std::string KymCoreImpl::newBudgetId() { return "b" + uuidHex().substr(0, 10); }

void KymCoreImpl::ensureBudgetLoaded(Budget &b) {
    if (!b.haveKey) loadOrCreateSecret(b);
    if (b.log.empty()) loadPersistedLog(b);
}

// Read budgets.json; migrate a legacy single budget (root/log.json + pair.key)
// into the first entry; load every budget's key + log; set the current selection.
void KymCoreImpl::loadBudgets() {
    fprintf(stderr, "KYMBUD loadBudgets START dataDir='%s'\n", m_dataDir.c_str());
    m_budgets.clear(); m_order.clear(); m_current.clear();
    auto addBudget = [&](const std::string &id, const std::string &name, const std::string &color, const std::string &dir) -> Budget & {
        Budget &b = m_budgets[id];
        b.id = id; b.name = name; b.dir = dir;
        b.color = color.empty() ? kBudgetColors[m_order.size() % 6] : color;
        m_order.push_back(id);
        loadOrCreateSecret(b);   // env/pair.key/fresh → sets b.topic
        // Deterministic colour from the household topic (matches mobile + all paired
        // devices). Overrides any stored/index colour once we have a key.
        if (b.haveKey && !b.topic.empty()) b.color = budgetColorForSeed(b.topic);
        loadPersistedLog(b);
        return b;
    };
    bool haveRegistry = false;
    if (!m_dataDir.empty()) {
        std::ifstream f(m_dataDir + "/budgets.json");
        if (f) {
            std::stringstream ss; ss << f.rdbuf();
            auto j = json::parse(ss.str(), nullptr, false);
            if (j.is_object() && j.contains("budgets") && j["budgets"].is_array()) {
                haveRegistry = true;
                for (const auto &e : j["budgets"]) {
                    if (!e.is_object() || !e.contains("id")) continue;
                    std::string id = e.value("id", std::string());
                    std::string name = e.value("name", std::string("Budget"));
                    std::string color = e.value("color", std::string());
                    // The FIRST/default budget lives at the ROOT (in-place migration);
                    // additional budgets live in <root>/<id>.
                    std::string dir = e.value("root", false) ? m_dataDir : (m_dataDir + "/" + id);
                    addBudget(id, name, color, dir);
                }
                m_current = j.value("current", std::string());
            }
        }
    }
    if (!haveRegistry) {
        // No registry: migrate a legacy single budget in place, or start fresh.
        // Either way the default budget's dir IS the root (its log.json/pair.key).
        addBudget("main", "My budget", kBudgetColors[0], m_dataDir);
    }
    if (m_current.empty() || !m_budgets.count(m_current)) m_current = m_order.empty() ? "" : m_order.front();
    if (m_budgets.empty()) { addBudget("main", "My budget", kBudgetColors[0], m_dataDir); m_current = "main"; }
    saveBudgets();
    fprintf(stderr, "KYMBUD loadBudgets DONE budgets=%zu current='%s' curLogLen=%zu\n",
            m_budgets.size(), m_current.c_str(), m_budgets.count(m_current) ? m_budgets[m_current].log.size() : 0);
}

void KymCoreImpl::saveBudgets() {
    if (m_dataDir.empty()) return;
    json arr = json::array();
    for (const auto &id : m_order) {
        auto it = m_budgets.find(id); if (it == m_budgets.end()) continue;
        const Budget &b = it->second;
        json e = {{"id", b.id}, {"name", b.name}, {"color", b.color}};
        if (b.dir == m_dataDir) e["root"] = true;   // the in-place default budget
        arr.push_back(e);
    }
    json reg = {{"budgets", arr}, {"current", m_current}};
    std::ofstream f(m_dataDir + "/budgets.json"); if (f) f << reg.dump(2);
}

std::string KymCoreImpl::listBudgets() {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    publishBudget();
    return m_budgetJson;
}

std::string KymCoreImpl::createBudget(std::string name) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (name.empty()) name = "Budget";
    std::string id = newBudgetId();
    Budget &b = m_budgets[id];
    b.id = id; b.name = name; b.color = kBudgetColors[m_order.size() % 6];
    b.dir = m_dataDir.empty() ? "" : (m_dataDir + "/" + id);
    m_order.push_back(id);
    loadOrCreateSecret(b);            // fresh household key (subscribes + reconciles if delivery is up)
    if (b.haveKey && !b.topic.empty()) b.color = budgetColorForSeed(b.topic);  // deterministic, cross-device
    m_current = id;                   // switch to the new one
    saveBudgets();
    publishBudget();
    return m_budgetJson;
}

std::string KymCoreImpl::selectBudget(std::string id) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (!m_budgets.count(id)) return "no such budget";
    m_current = id;
    saveBudgets();
    publishBudget();
    return m_budgetJson;
}

std::string KymCoreImpl::renameBudget(std::string id, std::string name) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (!m_budgets.count(id)) return "no such budget";
    if (!name.empty()) m_budgets[id].name = name;
    saveBudgets(); publishBudget();
    return m_budgetJson;
}

std::string KymCoreImpl::setBudgetColor(std::string id, std::string color) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (!m_budgets.count(id)) return "no such budget";
    if (!color.empty()) m_budgets[id].color = color;
    saveBudgets(); publishBudget();
    return m_budgetJson;
}

std::string KymCoreImpl::deleteBudget(std::string id) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    auto it = m_budgets.find(id);
    if (it == m_budgets.end()) return "no such budget";
    if (m_order.size() <= 1) return "can't delete the only budget";
    // Remove the budget's on-disk data (log + household key). Only for a NON-root
    // budget — the default/root budget lives at m_dataDir and we must not wipe that.
    const std::string dir = it->second.dir;
    m_budgets.erase(it);
    m_order.erase(std::remove(m_order.begin(), m_order.end(), id), m_order.end());
    if (m_current == id) m_current = m_order.front();
    if (!dir.empty() && dir != m_dataDir) { std::error_code ec; std::filesystem::remove_all(dir, ec); }
    saveBudgets(); publishBudget();
    return m_budgetJson;
}

// Join another device's household from its Crockford-base32 pairing code.
std::string KymCoreImpl::pairWithCode(std::string code) {
    // Accept a raw base32 code or a kym://pair?s=<code> deep link (from a QR).
    auto pos = code.find("s=");
    if (pos != std::string::npos && code.rfind("kym://", 0) == 0) code = code.substr(pos + 2);
    kym::Bytes s = b32decode(code);
    if (s.size() != 32) return "invalid pairing code";
    applySecret(cur(), s, true);   // re-key the CURRENT budget + persist; applySecret joins the topic + reconciles if delivery is up
    if (cur().haveKey && !cur().topic.empty()) cur().color = budgetColorForSeed(cur().topic);  // colour now matches the joined household
    saveBudgets();
    publishBudget();
    return "";
}

std::string KymCoreImpl::ingestSealed(std::string sealedHex) {
    if (!cur().haveKey) return "no household key set (call setSecret first)";
    kym::Bytes sealed = kym::fromHex(sealedHex);
    ingestRaw(cur().topic, std::string(sealed.begin(), sealed.end()));  // ingestRaw opens + dispatches
    return "";
}

void KymCoreImpl::bootstrapDelivery() {
    if (m_nodeReady) return;
    bool anyKey = false; for (auto &kv : m_budgets) if (kv.second.haveKey) { anyKey = true; break; }
    if (!anyKey) return;
    // In-progress guard. The hub loop (and the view's poll) call this on every
    // snapshot; until subscribe lands, m_nodeReady is false, so without this a
    // SECOND createNodeAsync fires ~8s into the FIRST node's startup and the two
    // overlapping createNode calls stomp each other — nwaku never finishes and the
    // callback returns a bare failure. (This is exactly why a one-shot `-c
    // createNode` succeeded but the polled hub never did.) Attempt one startup at a
    // time; the failure callbacks below clear the flag so a later poll can retry.
    if (m_deliveryStarting) return;
    m_deliveryStarting = true;
    // Register the receive handler before createNode — the position basecamp's GUI
    // receives with. (Headless/logoscore still shows "No external callbacks" and
    // doesn't deliver via this event path regardless of order; that's a separate
    // cross-module-event gap, tracked apart from the desktop.)
    modules().delivery_module.onMessageReceived(
        [this](const std::string &, const std::string &contentTopic, const LogosMap &payload, int64_t) {
            auto toWire = [](const LogosMap &v) -> std::string {
                if (v.is_string()) return v.get<std::string>();
                if (v.is_array()) {
                    std::string s; s.reserve(v.size());
                    for (const auto &c : v) if (c.is_number_integer()) s.push_back((char)c.get<int>());
                    return s;
                }
                if (v.is_object() && v.contains("_bytes") && v["_bytes"].is_string())
                    return b64decode(v["_bytes"].get<std::string>());
                return std::string();
            };
            std::string b64 = toWire(payload);
            if (b64.empty() && payload.is_object() && payload.contains("payload"))
                b64 = toWire(payload["payload"]);
            // Route to the budget that owns this content topic (each household has a
            // unique topic). ingestRaw opens with THAT budget's key + ingests there.
            if (!b64.empty()) ingestRaw(contentTopic, b64decode(b64));
        });
    // IMPORTANT: run entirely through the ASYNC delivery callers. The sync
    // createNode()/start() block on network setup (connecting to the logos.dev
    // Waku fleet); calling them from onContextReady() stalls this module's
    // "ready" signal, so the host never attaches the ui view (the budget window
    // never opens, and the host retry-respawns us). Chaining the *Async variants
    // lets onContextReady() return immediately; delivery connects in the
    // background and we flip m_nodeReady when the topic subscription lands.
    setStatus("Connecting...");
    const char *dlog = std::getenv("KYM_DELIVERY_LOG");
    LogosMap cfg = {{"logLevel", dlog ? std::string(dlog) : std::string("INFO")}, {"mode", "Core"}, {"preset", "logos.dev"}};
    // Diagnostic override: KYM_DELIVERY_CFG is a JSON object merged over the
    // default cfg, so a headless hub can try alternate WakuNodeConf keys (drop the
    // preset, disable rlnRelay, set a dataDir/ports) WITHOUT a rebuild while we pin
    // down why createNode fails under logoscore. Empty/unset → the default above.
    if (const char *ov = std::getenv("KYM_DELIVERY_CFG")) {
        auto j = json::parse(ov, nullptr, false);
        if (j.is_object()) for (auto it = j.begin(); it != j.end(); ++it) cfg[it.key()] = it.value();
    }
    fprintf(stderr, "KYM bootstrapDelivery cfg=%s\n", cfg.dump().c_str());
    // CHECK EVERY RESULT. These callbacks used to ignore StdLogosResult, so a
    // failed createNode/start still cascaded into "Connected · paired" — the ui
    // claimed to be online while the node was never up, which makes a silent
    // sync impossible to diagnose. A failure now stops the chain and says so.
    std::string cfgStr = cfg.dump();
    auto startNode = [this, cfgStr]() {
    modules().delivery_module.createNodeAsync(cfgStr, [this](StdLogosResult r) {
        fprintf(stderr, "KYMDBG createNode cb success=%d err=%s\n", (int)r.success, r.error.c_str());
        if (!r.success) { m_deliveryStarting = false; setStatus("Delivery error (createNode): " + r.error); return; }
        modules().delivery_module.startAsync([this](StdLogosResult r2) {
            fprintf(stderr, "KYMDBG start cb success=%d\n", (int)r2.success);
            if (!r2.success) { m_deliveryStarting = false; setStatus("Delivery error (start): " + r2.error); return; }
            try {
                m_nodeReady = true;
                setStatus("Connected · paired");
                // Subscribe EVERY budget's topic and reconcile each — all households
                // sync in the background, not just the one being viewed.
                for (auto &kv : m_budgets) {
                    Budget &b = kv.second;
                    if (!b.haveKey) continue;
                    b.subscribed = true;
                    modules().delivery_module.subscribeAsync(b.topic, [](StdLogosResult) {});
                    sendSummary(b);
                    // Arm the store-seed burst: maybeAutoResync (every ~30s) will push
                    // the whole log this many times, then stop — seeding the fleet store
                    // for phones that can't get a SYNC_REQ through. Re-armed on restart.
                    b.seedStoreRemaining = 3;
                    b.lastAutoResync = 0;   // let the first seed fire on the next tick
                }
                publishBudget();       // reflect "paired" now that the node is up
                refreshPeerCount();    // and start reporting who we can actually reach
                // Hub demo: seed a category into the CURRENT budget so a GUI peer sees hub→peer delivery.
                if (const char *seed = std::getenv("KYM_HUB_SEED_CATEGORY")) {
                    std::string name = seed, cid = "cat:" + slug(name);
                    if (!cur().categoryName.count(cid)) addCategory(name, "Everyday"); // creates + broadcasts
                    cur().seedCatId = cid; cur().seedTicks = 8;   // re-broadcast ~48s to beat the flaky shard
                    fprintf(stderr, "KYM hub seeded category '%s' (%s)\n", name.c_str(), cid.c_str());
                }
            } catch (const std::exception &ex) {
                fprintf(stderr, "KYMDBG start-cb EXCEPTION: %s\n", ex.what());
            } catch (...) { fprintf(stderr, "KYMDBG start-cb EXCEPTION (unknown)\n"); }
        });
    });
    };
    // Headless: register the receive-handler event, THEN delay createNode so the
    // onMessageReceived subscription IPC reaches the delivery_module process before
    // the node is built — otherwise nwaku comes up "No external callbacks to be
    // set" and delivered messages never reach kym_core (rxSeen stuck at 0). The
    // desktop host wires the event synchronously, so the GUI calls startNode now.
    if (std::getenv("KYM_HUB")) QTimer::singleShot(1500, startNode);
    else startNode();
}

// Peers we can actually reach. "Connected" only ever meant "subscribe() returned"
// — it is true with zero peers, so a silent sync looks identical to a healthy
// one. peerCount distinguishes "nobody answered my SYNC_REQ" from "I had nobody
// to ask". Best-effort: the id list is probed rather than hardcoded, and any
// failure just leaves the plain status alone.
void KymCoreImpl::refreshPeerCount() {
    if (!m_nodeReady) return;
    // Delivery exposes no direct peer count. getAvailableNodeInfoIDs() offers
    // [Version, Metrics, MyMultiaddresses, MyENR, MyPeerId, MyBoundPorts,
    // MyMixPubKey] - the numbers live in "Metrics" as Prometheus text. (The
    // "peerCount" string in liblogosdelivery.so is an internal name, NOT an
    // exposed id - probe the list, never hardcode.) Two gauges matter:
    //   libp2p_peers                          - transport peers we hold
    //   libp2p_gossipsub_peers_per_topic_mesh - peers actually in our gossip mesh
    // The mesh number is the one that decides whether a publish reaches anyone,
    // so a nonzero peer count with an empty mesh is still effectively offline.
    // ASYNC. getAvailableNodeInfoIDs()/getNodeInfo() are synchronous cross-module
    // calls: on the event-loop thread they block until delivery replies — up to the
    // 20s IPC timeout if delivery is mid-relay-processing — freezing every button
    // and stalling the heartbeat. (This, alongside the sync send(), WAS the "core
    // module stuck" bug.) Fetch Metrics async and parse in the callback, which
    // dispatches back on the event-loop thread; nothing here ever blocks it.
    modules().delivery_module.getNodeInfoAsync("Metrics", [this](StdLogosResult mR) {
        std::lock_guard<std::recursive_mutex> lk(m_mtx);
        if (!mR.success) return;
        const std::string metrics = mR.value.is_string() ? mR.value.get<std::string>() : mR.value.dump();
        parseAndApplyMetrics(metrics);
    });
}

void KymCoreImpl::parseAndApplyMetrics(const std::string &metrics) {
    auto gauge = [](const std::string &line) -> double {
        auto sp = line.rfind(' ');
        if (sp == std::string::npos) return -1;
        try { return std::stod(line.substr(sp + 1)); } catch (...) { return -1; }
    };
    long peers = -1, mesh = 0; bool sawMesh = false;
    std::istringstream ms(metrics);
    std::string ln;
    while (std::getline(ms, ln)) {
        if (!ln.empty() && ln.back() == '\r') ln.pop_back();
        if (ln.rfind("#", 0) == 0) continue;
        if (ln.rfind("libp2p_peers ", 0) == 0) {
            double v = gauge(ln); if (v >= 0) peers = (long)v;
        } else if (ln.rfind("libp2p_gossipsub_peers_per_topic_mesh", 0) == 0) {
            double v = gauge(ln); if (v >= 0) { mesh += (long)v; sawMesh = true; }
        }
    }
    // Hub diagnostics: capture the connection-related gauges verbatim so the
    // heartbeat shows whether the fleet link is healthy (peers held, dials
    // succeeding, discv5 populated) vs churning. Only meaningful headless.
    {
        std::istringstream ms2(metrics); std::string l2; std::string brief;
        while (std::getline(ms2, l2)) {
            if (!l2.empty() && l2.back() == '\r') l2.pop_back();
            if (l2.rfind("#", 0) == 0) continue;
            if (l2.rfind("libp2p_peers", 0) == 0 || l2.rfind("libp2p_gossipsub_peers", 0) == 0 ||
                l2.rfind("libp2p_total_dial", 0) == 0 || l2.rfind("libp2p_failed_dial", 0) == 0 ||
                l2.rfind("routing_table_nodes", 0) == 0 || l2.rfind("waku_", 0) == 0 ||
                l2.rfind("libp2p_open_streams", 0) == 0)
                brief += l2 + "\n";
        }
        m_metricsBrief = brief;
    }
    if (peers < 0) return;                    // metrics shape changed - stay quiet
    m_peerCount = peers;
    std::string st = "Connected · " + std::to_string(peers) + (peers == 1 ? " peer" : " peers");
    if (peers == 0) st = "Connected · no peers";
    if (sawMesh) st += " · mesh " + std::to_string(mesh);
    setStatus(st);
}

// Every drop below used to be a silent `return`, so "decrypt failed", "wrong
// envelope" and "nothing ever arrived" all looked identical. Count each reason
// and log it: m_rx* is folded into the budget JSON so the ui can show whether
// traffic is arriving at all.
void KymCoreImpl::ingestRaw(const std::string &contentTopic, const std::string &sealed) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (sealed.empty()) { m_rxDropped++; return; }
    // Route by content topic to the owning budget (each household = one topic). A
    // message on a topic we don't hold (a stray on the shared shard) is dropped.
    Budget *bp = budgetForTopic(contentTopic);
    if (!bp || !bp->haveKey) { m_rxDropped++; return; }
    Budget &b = *bp;
    m_rxSeen++;
    std::string js;
    try {
        kym::Bytes s(sealed.begin(), sealed.end());
        kym::Bytes pt = kym::open(b.identity, s, b.topic);
        js.assign(pt.begin(), pt.end());
    } catch (...) {
        // Not ours: wrong household key, or a foreign message on the same shard.
        m_rxOpenFail++;
        fprintf(stderr, "KYMRX open failed (%zu bytes) seen=%ld openFail=%ld\n",
                sealed.size(), m_rxSeen, m_rxOpenFail);
        return;
    }
    m_rxOpened++;

    // GUARD THE WHOLE HANDLER. A single malformed field from a peer (a bad
    // SUMMARY item, an odd EVENT) used to throw straight through this delivery
    // callback and take the module down — the ui then froze with no error (every
    // callCore hung). Now any exception just drops that one message; the module
    // stays alive and responsive.
    try {
    auto env = json::parse(js, nullptr, false);
    if (!env.is_object() || !env.contains("type") || !env["type"].is_string()) {
        m_rxDropped++;
        fprintf(stderr, "KYMRX bad envelope: %s\n", js.substr(0, 120).c_str());
        return;
    }
    const std::string type = env["type"].get<std::string>();
    fprintf(stderr, "KYMRX type=%s seen=%ld opened=%ld\n", type.c_str(), m_rxSeen, m_rxOpened);
    if (type == "SYNC_REQ") {   // legacy whole-log path (kept for old peers)
        if (!env.contains("from") || env["from"].get<std::string>() != m_deviceId)
            for (const auto &e : b.log) sealAndSend(b, e);
        return;
    }
    if (type == "SUMMARY") {
        // A peer's event-id set. Reconcile against ours; re-serve ONLY the events
        // it lacks. Nothing to send when the sets already match — the whole point.
        if (env.contains("from") && env["from"].get<std::string>() == m_deviceId) return; // ignore our own
        std::vector<kym::rbsr::Item> theirs, mine;
        if (env.contains("items") && env["items"].is_array())
            for (const auto &it : env["items"])
                if (it.is_object() && it.contains("w") && it["w"].is_number_integer()
                    && it.contains("i") && it["i"].is_string())
                    theirs.push_back({it["w"].get<int64_t>(), it["i"].get<std::string>()});
        loadPersistedLog(b);
        for (const auto &e : b.log) mine.push_back({e.hlc.wall, e.id});
        kym::rbsr::Diff d = kym::rbsr::reconcile(mine, theirs);
        std::set<std::string> peerNeeds(d.bNeeds.begin(), d.bNeeds.end());  // ids peer lacks (we hold)
        int sent = 0;
        for (const auto &e : b.log) if (peerNeeds.count(e.id)) { sealAndSend(b, e); sent++; }
        fprintf(stderr, "KYMRX SUMMARY peer_items=%zu peer_needs=%zu sent=%d we_lack=%zu\n",
                theirs.size(), peerNeeds.size(), sent, d.aNeeds.size());
        // d.aNeeds = ids WE lack. Re-summarize so this peer serves them back.
        if (!d.aNeeds.empty()) {
            int64_t now = (int64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
            if (now - b.lastSummaryTx >= 2000) sendSummary(b);
        }
        return;
    }
    if (type != "EVENT") { m_rxDropped++; return; }
    kym::Event e;
    if (!kym::decodeEventEnvelopeStd(js, e)) {
        m_rxDropped++;
        fprintf(stderr, "KYMRX undecodable EVENT: %s\n", js.substr(0, 120).c_str());
        return;
    }
    loadPersistedLog(b);             // merge shared log first (multi-instance safety)
    if (b.ids.count(e.id)) { m_rxDup++; return; }
    m_rxNew++;
    b.ids.insert(e.id); b.log.push_back(e);
    savePersistedLog(b);
    publishBudget();                 // ingested — refold + notify the UI; never re-broadcast
    } catch (const std::exception &ex) {
        m_rxDropped++;
        fprintf(stderr, "KYMRX handler exception (message dropped, module stays alive): %s\n", ex.what());
    } catch (...) {
        m_rxDropped++;
        fprintf(stderr, "KYMRX handler exception (unknown; message dropped)\n");
    }
}

void KymCoreImpl::sealAndSend(Budget &b, const kym::Event &e) {
    if (!m_nodeReady || !b.haveKey) return;
    kym::Bytes nonce(12); RAND_bytes(nonce.data(), 12);
    kym::Bytes sealed = kym::seal(b.identity, kym::strBytes(kym::encodeEventEnvelopeStd(e)), b.topic, nonce);
    deliverySend(b.topic, b64encode(std::string(sealed.begin(), sealed.end())));
}

// Publish a sealed payload, ROBUST to either delivery build (see header). Probes
// array→string once, caches the representation that didn't throw. KYM_SEND_ARRAY
// still forces the array shape (skips the probe). ASYNC/fire-and-forget: a sync
// send() would block the event-loop thread through a stalling lightpush and freeze
// the module (the "core stuck" bug); delivery reports outcomes via its own events.
void KymCoreImpl::deliverySend(const std::string &topic, const std::string &b64) {
    static const bool forceArray = std::getenv("KYM_SEND_ARRAY") != nullptr;
    auto attempt = [&](int repr) -> bool {
        try {
            LogosMap p = (repr == 1) ? bytesPayload(b64) : LogosMap(b64);
            modules().delivery_module.sendAsync(topic, p, [](StdLogosResult) {});
            return true;
        } catch (...) { return false; }
    };
    if (forceArray) { attempt(1); return; }
    if (m_sendRepr == 1 || m_sendRepr == 2) { if (attempt(m_sendRepr)) return; m_sendRepr = 0; }
    if (attempt(1)) { m_sendRepr = 1; return; }        // newer builds (current fleet)
    if (attempt(2)) { m_sendRepr = 2; return; }        // older builds (string payload)
    fprintf(stderr, "KYMTX deliverySend: no working payload representation\n");
}

void KymCoreImpl::sendSyncReq() {
    if (!m_nodeReady) return;
    m_txTotal++;
    fprintf(stderr, "KYMTX SYNC_REQ from=%s\n", m_deviceId.c_str());
    LogosMap env = {{"v", 1}, {"type", "SYNC_REQ"}, {"from", m_deviceId}};
    kym::Bytes nonce(12); RAND_bytes(nonce.data(), 12);
    kym::Bytes sealed = kym::seal(cur().identity, kym::strBytes(env.dump()), cur().topic, nonce);
    deliverySend(cur().topic, b64encode(std::string(sealed.begin(), sealed.end())));
}

// RBSR: broadcast our event-id set (each {w:hlc wall, i:id}) — small metadata,
// NOT the events. A peer reconciles it against its own set and re-serves only the
// events we lack (and we do the same when we see its summary). This is what
// replaces the whole-log re-broadcast: on a matched set nothing is sent at all.
// (One-round: we send the full id list. A future optimization sends range
// fingerprints instead and recurses, so even the summary is O(diff) not O(N).)
void KymCoreImpl::sendSummary(Budget &b) {
    if (!m_nodeReady || !b.haveKey) return;
    b.lastSummaryTx = (int64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    m_txTotal++;
    LogosMap items = LogosMap::array();
    for (const auto &e : b.log) items.push_back({{"w", e.hlc.wall}, {"i", e.id}});
    LogosMap env = {{"v", 1}, {"type", "SUMMARY"}, {"from", m_deviceId}, {"items", items}};
    kym::Bytes nonce(12); RAND_bytes(nonce.data(), 12);
    kym::Bytes sealed = kym::seal(b.identity, kym::strBytes(env.dump()), b.topic, nonce);
    deliverySend(b.topic, b64encode(std::string(sealed.begin(), sealed.end())));
    fprintf(stderr, "KYMTX SUMMARY items=%zu\n", b.log.size());
}

void KymCoreImpl::scheduleBackfill() {
    if (!m_nodeReady) return;
    for (const auto &e : cur().log) sealAndSend(cur(), e);   // legacy whole-log re-serve (old SYNC_REQ peers only)
}

// Encode the pairing URI as a QR matrix for the view's Canvas. Medium ECC:
// the pairing code is short, and M survives a phone camera at a screen angle.
std::string KymCoreImpl::pairingQr() {
    json out;
    if (!cur().haveKey) { out["ok"] = false; out["error"] = "no household key yet"; return out.dump(); }
    const std::string uri = "kym://pair?s=" + b32encode(cur().identity.secret);
    try {
        const qrcodegen::QrCode qr =
            qrcodegen::QrCode::encodeText(uri.c_str(), qrcodegen::QrCode::Ecc::MEDIUM);
        const int n = qr.getSize();
        json cells = json::array();
        for (int y = 0; y < n; ++y)
            for (int x = 0; x < n; ++x) cells.push_back(qr.getModule(x, y));
        out["ok"] = true;
        out["n"] = n;
        out["cells"] = std::move(cells);
        out["text"] = uri;
    } catch (const std::exception &e) {
        out["ok"] = false;
        out["error"] = std::string("qr encode failed: ") + e.what();
    }
    return out.dump();
}

std::string KymCoreImpl::snapshot() {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    // Lazily start delivery on the first read after the view attaches (safe
    // point: delivery_module is up). Async - returns immediately.
    bool anyKey = false; for (auto &kv : m_budgets) if (kv.second.haveKey) { anyKey = true; break; }
    if (anyKey && !m_nodeReady) bootstrapDelivery();
    // Re-read every budget's shared persisted log before folding (multi-instance
    // safety — writes/reads may land on different kym_core instances). Then run the
    // periodic RBSR reconcile for EACH budget so all households converge.
    for (auto &kv : m_budgets) { loadPersistedLog(kv.second); maybeAutoResync(kv.second); }
    // Converge on the persisted budget selection. Basecamp runs several kym_core
    // instances and round-robins calls across them; a selectBudget() lands on one,
    // so the others must re-read `current` from the shared registry or they'd keep
    // rendering a different (or, on a not-yet-migrated instance, empty) budget —
    // the "budget flickers every couple seconds" bug. Only switch to a budget this
    // instance actually holds, so cur() is never left pointing at nothing.
    if (!m_dataDir.empty()) {
        std::ifstream rf(m_dataDir + "/budgets.json");
        if (rf) {
            std::stringstream ss; ss << rf.rdbuf();
            auto j = json::parse(ss.str(), nullptr, false);
            if (j.is_object()) {
                std::string persisted = j.value("current", std::string());
                if (!persisted.empty() && m_budgets.count(persisted)) m_current = persisted;
            }
        }
    }
    refreshPeerCount();   // cheap local getter; keeps the peer indicator live
    // Hub seed: re-broadcast the seeded category + its group on the CURRENT budget
    // for a few polls, so a GUI peer receives it even if the first send dropped.
    if (cur().seedTicks > 0 && m_nodeReady && !cur().seedCatId.empty()) {
        std::string gid;
        for (auto &e : cur().log)
            if (e.type == "category.create" && e.s.count("categoryId") && e.s["categoryId"] == cur().seedCatId) {
                if (e.s.count("groupId")) gid = e.s["groupId"];
                sealAndSend(cur(), e);
            }
        for (auto &e : cur().log)
            if (!gid.empty() && e.type == "group.create" && e.s.count("groupId") && e.s["groupId"] == gid)
                sealAndSend(cur(), e);
        cur().seedTicks--;
        fprintf(stderr, "KYM hub seed re-broadcast (%d left) cat=%s grp=%s\n",
                cur().seedTicks, cur().seedCatId.c_str(), gid.c_str());
    }
    publishBudget();
    // Hub observability. A headless node has no view to show status, so when it is
    // the hub it drops a heartbeat file each poll: whether delivery came up (or the
    // error that stopped it), peers reached, log size, and rx/tx counters. This is
    // how the hub is health-checked and how a stuck delivery is diagnosed. Gated by
    // KYM_HUB so the desktop app never writes it. `ts` increasing == loop is live.
    if (std::getenv("KYM_HUB") && !m_dataDir.empty()) {
        json h;
        h["status"] = m_status; h["nodeReady"] = m_nodeReady; h["peers"] = m_peerCount;
        h["logLen"] = (int)cur().log.size(); h["device"] = m_deviceId; h["fingerprint"] = cur().fingerprint;
        h["rxSeen"] = m_rxSeen; h["rxOpened"] = m_rxOpened; h["rxNew"] = m_rxNew;
        h["rxDup"] = m_rxDup; h["rxOpenFail"] = m_rxOpenFail; h["rxDropped"] = m_rxDropped;
        h["txTotal"] = m_txTotal;
        h["metrics"] = m_metricsBrief;
        h["ts"] = (int64_t)std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        std::ofstream f(m_dataDir + "/hub.json"); if (f) f << h.dump();
    }
    return m_budgetJson;
}

// Re-broadcast the whole log + ask peers, at most every ~30s while connected.
// The logos.dev relay mesh on our shard is sparse and one-shot publishes get
// dropped; periodically re-serving lets a partial delivery finish over the next
// mesh window with no user action. Driven by the view's snapshot() poll (and any
// headless caller that ticks snapshot). RBSR set-reconciliation is the scalable
// replacement for re-sending the full log; fine at budget scale for now.
void KymCoreImpl::maybeAutoResync(Budget &b) {
    if (!m_nodeReady || !b.haveKey) return;
    int64_t now = (int64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    if (b.lastAutoResync != 0 && now - b.lastAutoResync < 30000) return;
    b.lastAutoResync = now;
    sendSummary(b);   // reconcile: peers send only the events we lack, and vice versa
    // Store-seed burst (NOT a perpetual rebroadcast). A phone can RECEIVE but its
    // publishes don't reliably propagate through the mesh, so it can't get a SYNC_REQ
    // to us to trigger a serve — it relies on store-pull instead, which needs the log
    // to actually be IN the fleet store. The store only keeps what was published to
    // relay, so we publish the whole log a FEW times right after the node comes up
    // (seedStoreRemaining, set on node-ready). That seeds the store for the retention
    // window; each hub restart re-seeds. After the burst we stop and leave ongoing
    // sync to live-event publishing, RBSR summaries, and serve-on-SYNC_REQ.
    if (b.seedStoreRemaining > 0) {
        b.seedStoreRemaining--;
        b.lastFullServe = now;
        for (const auto &e : b.log) sealAndSend(b, e);
    }
}

std::string KymCoreImpl::resync() {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (cur().haveKey && !m_nodeReady) bootstrapDelivery();
    publishBudget();                                  // recompute current state
    if (m_nodeReady) {
        // Sync means BOTH directions. This used to only re-broadcast our own log
        // (push), so there was no way to pull a peer's state on demand - the only
        // trigger for a fetch was restarting basecamp, which fires sendSyncReq()
        // from the subscribe callback. Ask first, then serve. Reconcile ALL budgets.
        for (auto &kv : m_budgets) sendSummary(kv.second);
    }
    return m_budgetJson;                              // hand the fresh budget back to the ui
}
