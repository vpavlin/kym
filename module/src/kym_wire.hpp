// kym_wire.hpp — (de)serialize a kym::Event <-> the Delivery EVENT envelope,
// matching packages/sync/src/wire.mjs + the event shape in @kym/contract.
// Qt-based (QJson); shared by the backend and the sync ingest parity test.
//
//   envelope = { v:1, type:"EVENT", event:{ v,id,type,dev,hlc:{wall,ctr,dev},
//                                           payload:{…} } }
#pragma once
#include <QJsonObject>
#include <QJsonArray>
#include <QJsonDocument>
#include <QByteArray>
#include <cmath>
#include "kym_engine.hpp"

namespace kym {

inline QJsonObject eventToJson(const Event &e) {
  QJsonObject payload;
  for (const auto &kv : e.s) payload[QString::fromStdString(kv.first)] = QString::fromStdString(kv.second);
  for (const auto &kv : e.n) payload[QString::fromStdString(kv.first)] = (double)kv.second;
  for (const auto &kv : e.b) payload[QString::fromStdString(kv.first)] = kv.second;
  if (e.hasSplits) {
    QJsonArray sp;
    for (const auto &s : e.splits)
      sp.append(QJsonObject{{"categoryId", QString::fromStdString(s.categoryId)}, {"amount", (double)s.amount}});
    payload["splits"] = sp;
  }
  QJsonObject hlc{{"wall", (double)e.hlc.wall}, {"ctr", (double)e.hlc.ctr}, {"dev", QString::fromStdString(e.hlc.dev)}};
  return QJsonObject{{"v", 1}, {"id", QString::fromStdString(e.id)}, {"type", QString::fromStdString(e.type)},
                     {"dev", QString::fromStdString(e.hlc.dev)}, {"hlc", hlc}, {"payload", payload}};
}

inline Event eventFromJson(const QJsonObject &o) {
  Event e;
  e.id = o.value("id").toString().toStdString();
  e.type = o.value("type").toString().toStdString();
  const QJsonObject h = o.value("hlc").toObject();
  e.hlc = HLC{(int64_t)std::llround(h.value("wall").toDouble()),
              (int64_t)std::llround(h.value("ctr").toDouble()),
              h.value("dev").toString().toStdString()};
  const QJsonObject p = o.value("payload").toObject();
  for (auto it = p.begin(); it != p.end(); ++it) {
    const std::string k = it.key().toStdString();
    const QJsonValue v = it.value();
    if (it.key() == "splits" && v.isArray()) {
      e.hasSplits = true;
      for (const auto &s : v.toArray()) {
        const QJsonObject so = s.toObject();
        e.splits.push_back({so.value("categoryId").toString().toStdString(),
                            (int64_t)std::llround(so.value("amount").toDouble())});
      }
    } else if (v.isDouble()) {
      e.n[k] = (int64_t)std::llround(v.toDouble());
    } else if (v.isBool()) {
      e.b[k] = v.toBool();
    } else if (v.isString()) {
      e.s[k] = v.toString().toStdString();
    }
  }
  return e;
}

// event -> plaintext bytes ready to seal (the EVENT envelope).
inline QByteArray encodeEventEnvelope(const Event &e) {
  return QJsonDocument(QJsonObject{{"v", 1}, {"type", "EVENT"}, {"event", eventToJson(e)}})
      .toJson(QJsonDocument::Compact);
}

// plaintext bytes (after open) -> event. Returns false on a non-EVENT envelope.
inline bool decodeEventEnvelope(const QByteArray &bytes, Event &out) {
  QJsonParseError err{};
  const QJsonDocument doc = QJsonDocument::fromJson(bytes, &err);
  if (err.error != QJsonParseError::NoError || !doc.isObject()) return false;
  const QJsonObject env = doc.object();
  if (env.value("type").toString() != "EVENT") return false;
  out = eventFromJson(env.value("event").toObject());
  return true;
}

} // namespace kym
