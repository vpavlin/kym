#include "kym_backend.h"
#include "money_format.hpp"

#include <QDate>
#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QUuid>
#include <QRegularExpression>
#include <QPair>
#include <cmath>

// --- small helpers ---------------------------------------------------------

// Parse a human amount ("10.50", "-3") to integer milliunits (× 1000). UI edge.
static kym::Money toMilli(const QString &in) {
  QString s = in.trimmed();
  bool neg = s.startsWith('-');
  s.remove(QRegularExpression("[^0-9.]"));
  if (s.isEmpty()) return 0;
  const auto parts = s.split('.');
  qint64 whole = parts.value(0).isEmpty() ? 0 : parts.value(0).toLongLong();
  QString frac = (parts.size() > 1 ? parts.value(1) : QString()) + "000";
  qint64 fracMilli = frac.left(3).toLongLong();
  qint64 v = whole * 1000 + fracMilli;
  return neg ? -v : v;
}

// Display milliunits in a currency (rounding is display-only, never stored).
static QString money(kym::Money m, const QString &ccy) {
  return QString::fromStdString(kym::formatMoney(m, ccy.toStdString()));
}

static QString slug(const QString &name) {
  QString s = name.toLower();
  s.replace(QRegularExpression("[^a-z0-9]+"), "-");
  s.replace(QRegularExpression("(^-|-$)"), "");
  return s.isEmpty() ? QUuid::createUuid().toString(QUuid::WithoutBraces).left(8) : s;
}

kym::HLC KymBackend::nextHlc() {
  qint64 t = QDateTime::currentMSecsSinceEpoch();
  if (t > m_wall) { m_wall = t; m_ctr = 0; } else { m_ctr++; }
  return kym::HLC{m_wall, m_ctr, std::string("basecamp")};
}

QString KymBackend::currentMonth() const { return QDate::currentDate().toString("yyyy-MM"); }

// --- event builders (also record id->name so JSON can carry names) ---------

static kym::Event baseEvent(const QString &type, const kym::HLC &hlc) {
  kym::Event e;
  e.id = QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString();
  e.type = type.toStdString();
  e.hlc = hlc;
  return e;
}

QString KymBackend::ensureGroup(const QString &name) {
  for (auto it = m_groupName.begin(); it != m_groupName.end(); ++it)
    if (it.value().compare(name, Qt::CaseInsensitive) == 0) return it.key();
  QString gid = "grp:" + slug(name);
  auto e = baseEvent("group.create", nextHlc());
  e.s["groupId"] = gid.toStdString();
  e.s["name"] = name.toStdString();
  m_log.push_back(e);
  m_groupName[gid] = name;
  m_groupOrder << gid;
  return gid;
}

QString KymBackend::addAccountEv(const QString &name, const QString &type, kym::Money bal, const QString &currency) {
  QString id = "acct:" + slug(name);
  QString ccy = currency.isEmpty() ? m_currency : currency.toUpper();
  auto e = baseEvent("account.create", nextHlc());
  e.s["accountId"] = id.toStdString();
  e.s["name"] = name.toStdString();
  e.s["accountType"] = type.toStdString();
  e.s["startDate"] = QDate::currentDate().toString(Qt::ISODate).toStdString();
  e.s["currency"] = ccy.toStdString();
  e.n["startingBalance"] = bal;
  e.b["onBudget"] = (type != "tracking");
  m_log.push_back(e);
  m_accountName[id] = name;
  m_accountCurrency[id] = ccy;
  return id;
}

QString KymBackend::addCategoryEv(const QString &name, const QString &group) {
  QString gid = ensureGroup(group.isEmpty() ? "General" : group);
  QString id = "cat:" + slug(name);
  auto e = baseEvent("category.create", nextHlc());
  e.s["categoryId"] = id.toStdString();
  e.s["groupId"] = gid.toStdString();
  e.s["name"] = name.toStdString();
  m_log.push_back(e);
  m_categoryName[id] = name;
  m_categoryGroup[id] = gid;
  return id;
}

void KymBackend::assignEv(const QString &catId, const QString &month, kym::Money amt) {
  auto e = baseEvent("assign", nextHlc());
  e.s["categoryId"] = catId.toStdString();
  e.s["month"] = month.toStdString();
  e.s["mode"] = "delta";
  e.n["amount"] = amt;
  m_log.push_back(e);
}

void KymBackend::moveEv(const QString &fromId, const QString &toId, const QString &month, kym::Money amt) {
  auto e = baseEvent("move", nextHlc());
  e.s["fromCategoryId"] = fromId.toStdString();
  e.s["toCategoryId"] = toId.toStdString();
  e.s["month"] = month.toStdString();
  e.n["amount"] = amt;
  m_log.push_back(e);
}

void KymBackend::txnEv(const QString &acctId, kym::Money amt, const QString &month, const QString &catId) {
  auto e = baseEvent("txn.create", nextHlc());
  e.s["txnId"] = QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString();
  e.s["accountId"] = acctId.toStdString();
  e.n["amount"] = amt;
  e.s["date"] = (month + "-15T12:00:00Z").toStdString();
  e.s["categoryId"] = catId.toStdString();
  m_log.push_back(e);
}

QString KymBackend::findAccountId(const QString &name) const {
  for (auto it = m_accountName.begin(); it != m_accountName.end(); ++it)
    if (it.value().compare(name, Qt::CaseInsensitive) == 0) return it.key();
  return QString();
}
QString KymBackend::findCategoryId(const QString &name) const {
  for (auto it = m_categoryName.begin(); it != m_categoryName.end(); ++it)
    if (it.value().compare(name, Qt::CaseInsensitive) == 0) return it.key();
  return QString();
}

// --- SLOTs -----------------------------------------------------------------

QString KymBackend::addAccount(QString name, QString type, QString balance) {
  if (name.isEmpty()) return "account name required";
  addAccountEv(name, type.isEmpty() ? "checking" : type, toMilli(balance));
  publishBudget();
  return "";
}

QString KymBackend::addCategory(QString name, QString group) {
  if (name.isEmpty()) return "category name required";
  addCategoryEv(name, group);
  publishBudget();
  return "";
}

QString KymBackend::assign(QString category, QString month, QString amount) {
  QString id = findCategoryId(category);
  if (id.isEmpty()) return "unknown category: " + category;
  assignEv(id, month.isEmpty() ? currentMonth() : month, toMilli(amount));
  publishBudget();
  return "";
}

QString KymBackend::spend(QString amount, QString account, QString category) {
  QString acc = findAccountId(account), cat = findCategoryId(category);
  if (acc.isEmpty()) return "unknown account: " + account;
  if (cat.isEmpty()) return "unknown category: " + category;
  txnEv(acc, -std::llabs(toMilli(amount)), currentMonth(), cat);
  publishBudget();
  return "";
}

QString KymBackend::moveMoney(QString fromCategory, QString toCategory, QString month, QString amount) {
  QString f = findCategoryId(fromCategory), t = findCategoryId(toCategory);
  if (f.isEmpty()) return "unknown category: " + fromCategory;
  if (t.isEmpty()) return "unknown category: " + toCategory;
  moveEv(f, t, month.isEmpty() ? currentMonth() : month, toMilli(amount));
  publishBudget();
  return "";
}

QString KymBackend::loadDemo() {
  if (!m_log.empty()) return "budget already has data";
  const QString m = currentMonth();
  // A Czech household month in CZK, with a EUR account tracked off-budget.
  QString chk = addAccountEv("Checking", "checking", toMilli("30000"));
  addAccountEv("Visa", "creditCard", 0);
  addAccountEv("Revolut", "tracking", toMilli("420"), "EUR");
  QString rent = addCategoryEv("Rent", "Bills");
  QString util = addCategoryEv("Utilities", "Bills");
  QString groc = addCategoryEv("Groceries", "Everyday");
  QString dine = addCategoryEv("Dining", "Everyday");
  QString fun = addCategoryEv("Fun Money", "Everyday");
  QString save = addCategoryEv("Emergency Fund", "Goals");
  txnEv(chk, toMilli("45000"), m, QString::fromStdString(kym::RTA_INFLOW)); // salary
  assignEv(rent, m, toMilli("18000"));
  assignEv(util, m, toMilli("3000"));
  assignEv(groc, m, toMilli("8000"));
  assignEv(dine, m, toMilli("3000"));
  assignEv(fun, m, toMilli("2000"));
  assignEv(save, m, toMilli("5000"));
  txnEv(chk, -std::llabs(toMilli("18000")), m, rent);
  txnEv(chk, -std::llabs(toMilli("2450")), m, groc);
  txnEv(findAccountId("Visa"), -std::llabs(toMilli("680")), m, dine); // on the credit card
  publishBudget();
  return "";
}

// --- bootstrap + publish ----------------------------------------------------

void KymBackend::onContextReady() {
  setStatus("KYM ready");
  if (m_log.empty()) loadDemo();
  setReady(true);
  publishBudget();
}

void KymBackend::publishBudget() {
  kym::BudgetState st = kym::computeState(m_log);
  kym::Invariant inv = kym::checkInvariant(st);

  auto rowFor = [&](const std::string &cat) -> QPair<kym::Money, kym::Money> {
    kym::Money a = 0, act = 0;
    for (const auto &r : st.categoryMonths)
      if (r.categoryId == cat && r.month == st.currentMonth) { a = r.assigned; act = r.activity; }
    return {a, act};
  };

  const QString bc = m_currency; // budget currency for all envelope/RTA figures

  QJsonObject root;
  root["currency"] = bc;
  root["currentMonth"] = QString::fromStdString(st.currentMonth);
  root["readyToAssign"] = money(st.readyToAssign, bc);
  root["readyToAssignRaw"] = (double)st.readyToAssign;

  QJsonObject invo;
  invo["ok"] = inv.ok;
  invo["assets"] = money(inv.assets, bc);
  invo["categoriesAvail"] = money(inv.categoriesAvail, bc);
  invo["diff"] = money(inv.diff, bc);
  root["invariant"] = invo;

  QJsonArray accs;
  for (const auto &a : st.accounts) {
    QJsonObject o;
    QString id = QString::fromStdString(a.id);
    QString ac = m_accountCurrency.value(id, bc); // account's own currency (EUR tracking etc.)
    o["id"] = id;
    o["name"] = m_accountName.value(id, id);
    o["type"] = QString::fromStdString(a.type);
    o["onBudget"] = a.onBudget;
    o["balance"] = money(st.balances.count(a.id) ? st.balances.at(a.id) : 0, ac);
    accs.append(o);
  }
  root["accounts"] = accs;

  QJsonArray groups;
  for (const QString &gid : m_groupOrder) {
    QJsonObject g;
    g["id"] = gid;
    g["name"] = m_groupName.value(gid, gid);
    QJsonArray cats;
    for (const auto &cidStd : st.categoryIds) {
      QString cid = QString::fromStdString(cidStd);
      if (m_categoryGroup.value(cid) != gid) continue;
      auto [a, act] = rowFor(cidStd);
      kym::Money avail = st.categoryAvailable.count(cidStd) ? st.categoryAvailable.at(cidStd) : 0;
      QJsonObject c;
      c["id"] = cid;
      c["name"] = m_categoryName.value(cid, cid);
      c["assigned"] = money(a, bc);
      c["activity"] = money(act, bc);
      c["available"] = money(avail, bc);
      c["negative"] = avail < 0;
      cats.append(c);
    }
    g["categories"] = cats;
    groups.append(g);
  }
  root["groups"] = groups;

  QJsonArray ccp;
  for (const auto &kv : st.creditCardPayments) {
    QString id = QString::fromStdString(kv.first);
    QJsonObject o;
    o["account"] = id;
    o["name"] = m_accountName.value(id, id);
    o["available"] = money(kv.second, bc);
    ccp.append(o);
  }
  root["creditCardPayments"] = ccp;

  setBudgetJson(QString::fromUtf8(QJsonDocument(root).toJson(QJsonDocument::Compact)));
}
