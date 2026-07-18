#pragma once

#include <QString>
#include <QMap>
#include <QStringList>
#include <QVariantList>
#include <vector>
#include <set>

#include "rep_kym_source.h"
#include "logos_ui_plugin_context.h"

#include "kym_engine.hpp"
#include "kym_crypto.hpp"

/**
 * @brief UI backend for KYM (universal authoring model).
 *
 * Holds the budget as an append-only event log (docs/data-model.md). Every SLOT
 * appends events; the folded BudgetState (via the std-only kym_engine.hpp — the
 * same fold parity-tested against the TS reference) is republished as JSON for
 * the QML grid. No balance is ever stored — only folded. MVP keeps the log in
 * memory; SQLite persistence + Delivery sync are the next steps in issue #1.
 */
class KymBackend : public KymSimpleSource, public LogosUiPluginContext {
public:
  QString loadDemo() override;
  QString resync() override;
  QString addAccount(QString name, QString type, QString balance) override;
  QString addCategory(QString name, QString group) override;
  QString assign(QString category, QString month, QString amount) override;
  QString spend(QString amount, QString account, QString category) override;
  QString moveMoney(QString fromCategory, QString toCategory, QString month, QString amount) override;

protected:
  void onContextReady() override;

private:
  std::vector<kym::Event> m_log;
  std::set<std::string> m_eventIds;         // dedup (local + ingested)
  // id -> display name, and category id -> group id, so JSON can carry names.
  QMap<QString, QString> m_accountName, m_categoryName, m_groupName, m_categoryGroup;
  QStringList m_groupOrder;
  QMap<QString, QString> m_accountCurrency; // accountId -> currency code
  QString m_currency = "CZK";               // the single budget currency
  qint64 m_wall = 0, m_ctr = 0;

  // --- Delivery sync ---
  QString m_dataDir;
  QString m_deviceId = "basecamp";           // per-instance id (HLC tiebreak + backfill dedup)
  bool m_nodeReady = false;
  bool m_backfillPending = false;            // debounce backfill re-serves
  kym::Identity m_id;                        // household key (from the shared secret)
  QString m_topic;                           // derived content topic
  void bootstrap();                          // delivery node + subscribe
  void loadOrCreateSecret();                 // household secret + device id in the data dir
  void sealAndSend(const kym::Event &e);     // encrypt + delivery.send one event
  void sendSyncReq();                        // ask peers to re-serve their logs
  void scheduleBackfill();                   // debounced resync() in response to a peer's request
  void ingestSealed(const QByteArray &sealed); // open -> decode -> merge -> refold
  void rebuildNameMaps();                    // re-derive name maps from the log (after ingest)
  void loadPersistedLog();
  void savePersistedLog();

  kym::HLC nextHlc();
  QString currentMonth() const;
  void publishBudget();
  // Append a locally-authored or ingested event; dedups, persists, and (if the
  // node is up and `broadcast`) publishes it over Delivery.
  void pushEvent(const kym::Event &e, bool broadcast);

  QString ensureGroup(const QString &name);
  QString addAccountEv(const QString &name, const QString &type, kym::Money bal, const QString &currency = QString());
  QString addCategoryEv(const QString &name, const QString &group);
  void assignEv(const QString &catId, const QString &month, kym::Money amt);
  void moveEv(const QString &fromId, const QString &toId, const QString &month, kym::Money amt);
  void txnEv(const QString &acctId, kym::Money amt, const QString &month, const QString &catId);

  QString findAccountId(const QString &name) const;
  QString findCategoryId(const QString &name) const;
};
