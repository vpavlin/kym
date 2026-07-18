#include "kym_backend.h"
#include "money_format.hpp"
#include "kym_wire.hpp"
#include "pgp_words.h"

#include <QDate>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTimer>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QUuid>
#include <QRegularExpression>
#include <QPair>
#include <cmath>

#include <openssl/rand.h>
#include <openssl/sha.h>

#include "logos_sdk.h"

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
  pushEvent(e, true);
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
  pushEvent(e, true);
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
  pushEvent(e, true);
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
  pushEvent(e, true);
}

void KymBackend::moveEv(const QString &fromId, const QString &toId, const QString &month, kym::Money amt) {
  auto e = baseEvent("move", nextHlc());
  e.s["fromCategoryId"] = fromId.toStdString();
  e.s["toCategoryId"] = toId.toStdString();
  e.s["month"] = month.toStdString();
  e.n["amount"] = amt;
  pushEvent(e, true);
}

void KymBackend::txnEv(const QString &acctId, kym::Money amt, const QString &month, const QString &catId) {
  auto e = baseEvent("txn.create", nextHlc());
  e.s["txnId"] = QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString();
  e.s["accountId"] = acctId.toStdString();
  e.n["amount"] = amt;
  e.s["date"] = (month + "-15T12:00:00Z").toStdString();
  e.s["categoryId"] = catId.toStdString();
  pushEvent(e, true);
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

QString KymBackend::resync() {
  if (!m_nodeReady) return "node not ready";
  for (const auto &e : m_log) sealAndSend(e);
  return "";
}

void KymBackend::onContextReady() {
  setStatus("Starting…");
  loadOrCreateSecret();       // household key -> m_id, m_topic, fingerprint
  loadPersistedLog();         // durable local copy (this instance is a hub)
  // Seed a demo only for a truly fresh, solo budget. A paired peer sets
  // KYM_NO_DEMO=1 so two instances don't seed divergent demo ids.
  if (m_log.empty() && !qEnvironmentVariableIsSet("KYM_NO_DEMO")) loadDemo();
  // Defer the delivery bootstrap off the context-ready callback (Perun gotcha).
  QTimer::singleShot(0, [this]() {
    bootstrap();
    setReady(true);
    publishBudget();
  });
}

// ---- Delivery sync ---------------------------------------------------------

void KymBackend::pushEvent(const kym::Event &e, bool broadcast) {
  if (m_eventIds.count(e.id)) return;        // idempotent (dedup by UUID)
  m_log.push_back(e);
  m_eventIds.insert(e.id);
  savePersistedLog();
  if (broadcast && m_nodeReady) sealAndSend(e);
}

void KymBackend::sealAndSend(const kym::Event &e) {
  QByteArray env = kym::encodeEventEnvelope(e);
  kym::Bytes nonce(12);
  RAND_bytes(nonce.data(), 12);
  kym::Bytes sealed = kym::seal(m_id, kym::Bytes(env.begin(), env.end()), m_topic.toStdString(), nonce);
  QByteArray payload(reinterpret_cast<const char *>(sealed.data()), (int)sealed.size());
  modules().delivery_module.send(m_topic, payload);
}

void KymBackend::ingestSealed(const QByteArray &sealed) {
  kym::Bytes s(sealed.begin(), sealed.end());
  kym::Bytes pt;
  try {
    pt = kym::open(m_id, s, m_topic.toStdString());  // not ours / tampered -> throws
  } catch (...) {
    return;
  }
  QByteArray bytes(reinterpret_cast<const char *>(pt.data()), (int)pt.size());
  kym::Event e;
  if (!kym::decodeEventEnvelope(bytes, e)) return;
  if (m_eventIds.count(e.id)) return;        // already have it (Store replay)
  pushEvent(e, /*broadcast=*/false);         // ingested — never re-broadcast
  publishBudget();
}

void KymBackend::bootstrap() {
  modules().delivery_module.on("messageReceived", [this](const QVariantList &data) {
    if (data.size() < 3) return;
    ingestSealed(data.at(2).toByteArray());
  });
  modules().delivery_module.on("connectionStateChanged", [this](const QVariantList &data) {
    if (!data.isEmpty() && m_nodeReady) setStatus(data.at(0).toString());
  });

  const QJsonObject cfg{{"logLevel", "INFO"}, {"mode", "Core"}, {"preset", "logos.dev"}};
  const QString cfgJson = QString::fromUtf8(QJsonDocument(cfg).toJson(QJsonDocument::Compact));
  LogosResult created = modules().delivery_module.createNode(cfgJson);
  if (created.success) modules().delivery_module.start();     // may already be running
  modules().delivery_module.subscribe(m_topic);
  m_nodeReady = true;
  setStatus(QStringLiteral("Connected · paired"));
}

void KymBackend::loadOrCreateSecret() {
  m_dataDir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/kym";
  QDir().mkpath(m_dataDir);

  kym::Bytes secret;
  const QByteArray envHex = qgetenv("KYM_HOUSEHOLD_SECRET");   // test override: shared key
  if (envHex.size() >= 64) {
    secret = kym::fromHex(QString::fromLatin1(envHex.left(64)).toStdString());
  } else {
    const QString path = m_dataDir + "/pair.key";
    QFile f(path);
    if (f.open(QIODevice::ReadOnly)) {
      const QByteArray raw = f.read(32);
      f.close();
      if (raw.size() == 32) secret = kym::Bytes(raw.begin(), raw.end());
    }
    if (secret.size() != 32) {
      secret.resize(32);
      RAND_bytes(secret.data(), 32);
      QSaveFile out(path);
      if (out.open(QIODevice::WriteOnly)) {
        out.write(QByteArray(reinterpret_cast<const char *>(secret.data()), 32));
        out.commit();
        QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
      }
    }
  }
  m_id = kym::deriveIdentity(secret);
  m_topic = QString::fromStdString(kym::topicFor(m_id));
  unsigned char h[32];
  SHA256(m_id.K.data(), m_id.K.size(), h);
  setFingerprint(QStringLiteral("%1 %2 %3").arg(kPgpEven[h[0]]).arg(kPgpOdd[h[1]]).arg(kPgpEven[h[2]]));
}

void KymBackend::savePersistedLog() {
  if (m_dataDir.isEmpty()) return;
  QJsonArray arr;
  for (const auto &e : m_log) arr.append(kym::eventToJson(e));
  QSaveFile f(m_dataDir + "/log.json");
  if (f.open(QIODevice::WriteOnly)) {
    f.write(QJsonDocument(arr).toJson(QJsonDocument::Compact));
    f.commit();
  }
}

void KymBackend::loadPersistedLog() {
  QFile f(m_dataDir + "/log.json");
  if (!f.open(QIODevice::ReadOnly)) return;
  const QJsonDocument doc = QJsonDocument::fromJson(f.readAll());
  f.close();
  if (!doc.isArray()) return;
  for (const auto &v : doc.array()) {
    kym::Event e = kym::eventFromJson(v.toObject());
    if (!m_eventIds.count(e.id)) { m_log.push_back(e); m_eventIds.insert(e.id); }
  }
}

// Re-derive display name maps from the log so INGESTED accounts/categories (not
// created by our own builders) also render with their names.
void KymBackend::rebuildNameMaps() {
  auto sv = [](const kym::Event &e, const char *k) -> QString {
    auto it = e.s.find(k);
    return it == e.s.end() ? QString() : QString::fromStdString(it->second);
  };
  m_accountName.clear(); m_categoryName.clear(); m_groupName.clear();
  m_categoryGroup.clear(); m_accountCurrency.clear(); m_groupOrder.clear();
  for (const auto &e : kym::mergeEvents(m_log)) {
    if (e.type == "group.create") {
      QString id = sv(e, "groupId");
      if (!m_groupName.contains(id)) { m_groupName[id] = sv(e, "name"); m_groupOrder << id; }
    } else if (e.type == "account.create") {
      QString id = sv(e, "accountId");
      m_accountName[id] = sv(e, "name");
      QString c = sv(e, "currency");
      m_accountCurrency[id] = c.isEmpty() ? m_currency : c;
    } else if (e.type == "account.edit") {
      QString id = sv(e, "accountId");
      if (!sv(e, "name").isEmpty()) m_accountName[id] = sv(e, "name");
    } else if (e.type == "category.create") {
      QString id = sv(e, "categoryId");
      m_categoryName[id] = sv(e, "name");
      m_categoryGroup[id] = sv(e, "groupId");
    } else if (e.type == "category.edit") {
      QString id = sv(e, "categoryId");
      if (!sv(e, "name").isEmpty()) m_categoryName[id] = sv(e, "name");
      if (!sv(e, "groupId").isEmpty()) m_categoryGroup[id] = sv(e, "groupId");
    }
  }
}

void KymBackend::publishBudget() {
  rebuildNameMaps();   // pick up names of ingested (peer-created) accounts/categories
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
      QString tgt; bool tgtOk = true;
      auto tit = st.targetProgress.find(cidStd);
      if (tit != st.targetProgress.end()) {
        tgtOk = tit->second.onTrack;
        tgt = tgtOk ? QStringLiteral("\U0001F3AF funded")
                    : QStringLiteral("\U0001F3AF need %1").arg(money(tit->second.needed, bc));
      }
      c["target"] = tgt;
      c["targetOnTrack"] = tgtOk;
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
