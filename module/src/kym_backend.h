#pragma once

#include <QString>
#include <QMap>
#include <QStringList>
#include <vector>

#include "rep_kym_source.h"
#include "logos_ui_plugin_context.h"

#include "kym_engine.hpp"

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
  QString addAccount(QString name, QString type, QString balance) override;
  QString addCategory(QString name, QString group) override;
  QString assign(QString category, QString month, QString amount) override;
  QString spend(QString amount, QString account, QString category) override;
  QString moveMoney(QString fromCategory, QString toCategory, QString month, QString amount) override;

protected:
  void onContextReady() override;

private:
  std::vector<kym::Event> m_log;
  // id -> display name, and category id -> group id, so JSON can carry names.
  QMap<QString, QString> m_accountName, m_categoryName, m_groupName, m_categoryGroup;
  QStringList m_groupOrder;
  qint64 m_wall = 0, m_ctr = 0;

  kym::HLC nextHlc();
  QString currentMonth() const;
  void publishBudget();

  QString ensureGroup(const QString &name);
  QString addAccountEv(const QString &name, const QString &type, kym::Money bal);
  QString addCategoryEv(const QString &name, const QString &group);
  void assignEv(const QString &catId, const QString &month, kym::Money amt);
  void moveEv(const QString &fromId, const QString &toId, const QString &month, kym::Money amt);
  void txnEv(const QString &acctId, kym::Money amt, const QString &month, const QString &catId);

  QString findAccountId(const QString &name) const;
  QString findCategoryId(const QString &name) const;
};
