#pragma once
#include <string>
#include <vector>
#include <set>
#include <map>
#include <mutex>

class QTimer;
#include "logos_module_context.h"
#include "kym_engine.hpp"
#include "kym_crypto.hpp"
#include "kym_wire_std.hpp"
#include "kym_reconcile_std.hpp"

/**
 * KymCoreImpl - the KYM engine + sync as a headless Logos CORE module. It owns the
 * append-only event log, folds it through the shared std-only engine, drives all
 * budget mutations, and syncs over delivery_module. It runs BOTH standalone under
 * logoscore (the always-on hub) AND behind the desktop `kym` ui_qml view, which
 * calls these methods and renders budgetJson() - so there is ONE implementation
 * of the engine/sync, not a ui copy + a hub copy.
 *
 * Universal authoring model: public methods are the API (return JSON-serializable
 * std::string), no Q_OBJECT/QML; the plugin glue is generated from this header.
 */
class KymCoreImpl : public LogosModuleContext {
public:
    ~KymCoreImpl() override;
    // --- read surface (the UI renders these) ---
    std::string budgetJson();     // the folded BudgetState as JSON (grid, RTA, members, invariant...)
    std::string status();         // human status line
    std::string fingerprint();    // 3-word household pairing fingerprint (pgp words)

    // --- sync primitives (also used headless / by tests) ---
    std::string setSecret(std::string secretHex);   // derive identity + topic from a 32-byte hex secret
    std::string ingestSealed(std::string sealedHex);// open -> decode -> dedup -> append (test/manual)
    std::string logFingerprint();                   // RBSR opening message over the whole log

    // --- budget mutations (return "" on success or an error string) ---
    std::string addAccount(std::string name, std::string type, std::string balance);
    std::string addCategory(std::string name, std::string group);
    // Create an (empty) category group by name — the desktop's inline "+ group"
    // needs this; groups were previously only born as a side effect of the first
    // category in them (ensureGroup). Idempotent: an existing name is a no-op.
    std::string addGroup(std::string name);
    // Delete an EMPTY category/group. deleteCategory refuses if the category has any
    // assignments or transactions; deleteGroup refuses if it still holds categories
    // — so no money is ever orphaned. Emits category.delete / group.delete.
    std::string deleteCategory(std::string name);
    std::string deleteGroup(std::string name);
    // Archive a category with history: hide it from the active list but keep every
    // transaction/assignment. Requires the category's Available to be 0 (empty the
    // balance first). Reversible via unarchiveCategory.
    std::string archiveCategory(std::string name);
    std::string unarchiveCategory(std::string name);
    // Edit or delete a recorded transaction WITHOUT mutating history. editTxn
    // appends a txn.edit carrying only the changed fields (empty arg = unchanged;
    // category "Income" retargets the RTA inflow); deleteTxn appends a sticky
    // txn.delete tombstone. Balances re-derive through the fold and both ride the
    // normal sync path — just more append-only events, LWW by HLC on conflict.
    std::string editTxn(std::string txnId, std::string patchJson);
    std::string deleteTxn(std::string txnId);
    // Set this device's attribution name (persisted to <root>/author.txt). Stamped
    // on every event this device authors so a shared budget shows who did what.
    std::string setAuthorName(std::string name);
    // Rename this device (persisted to <root>/device.txt). It's the SDS sender +
    // the CRDT event author "dev"; must stay unique per device.
    std::string setDeviceId(std::string name);
    // Month navigation. The view folds `asOf` a chosen month so past/future months
    // show correct rolled-forward Available (the engine already carries balances
    // month to month). "" resets to the live calendar month. Assign/move target
    // whatever month the ui is showing.
    std::string setViewMonth(std::string month);
    std::string assign(std::string category, std::string month, std::string amount);
    std::string spend(std::string amount, std::string account, std::string category);
    std::string income(std::string amount, std::string account);
    std::string setTarget(std::string category, std::string targetType, std::string amount, std::string month);
    std::string reconcile(std::string account, std::string actual);
    std::string moveMoney(std::string fromCategory, std::string toCategory, std::string month, std::string amount);
    std::string loadDemo();
    std::string resync();
    // Dispatchable read: returns the folded budget JSON (status/fingerprint/
    // pairingCode folded in). The pure-QML view polls this instead of relying on
    // the budgetChanged event, which the deployed basecamp does not deliver to
    // QML. No side effects - safe to call on a timer.
    std::string snapshot();

    // Dispatchable read: the pairing URI (kym://pair?s=<code>) rendered as a QR
    // MATRIX -> {"ok":true,"n":N,"cells":[bool...]} (row-major, true = dark).
    // The view draws it on a Canvas: the QML sandbox blocks image data URIs, and
    // basecamp's `qr` core is Qt-free (logos.callModule returns null for it), so
    // we encode here with the same vendored MIT encoder qr-basecamp uses. That
    // keeps QR pairing dependency-free - nothing extra for the user to install.
    std::string pairingQr();

    // --- group budgets ---
    std::string groupInit(std::string name);
    std::string addMember(std::string memberId, std::string name, std::string role);
    std::string setMemberRole(std::string memberId, std::string role);
    std::string removeMember(std::string memberId);

    // --- pairing (share/join a household) ---
    // Join another device's household from its pairing code (Crockford base32,
    // wire-compatible with the mobile app). Re-keys, persists, re-subscribes.
    // Operates on the CURRENT budget.
    std::string pairWithCode(std::string code);

    // --- multiple budgets ---
    // A "budget" is a household (own log + own household key). Privacy = who you
    // share the pairing code with; a budget you never share the code for stays
    // private (still paired across your own devices + hub). All budgets sync in
    // the background; mutations/reads target the CURRENT one. These return the
    // fresh budget JSON (so the view re-renders), or "" / an error string.
    // NOTE: keep these declarations free of trailing // comments — the module glue
    // generator skips any method with a trailing comment on its declaration line.
    std::string listBudgets();
    std::string createBudget(std::string name);
    // Join a shared household from a pairing code as a NEW budget entry (does NOT
    // re-key the current budget, unlike pairWithCode). Switches to it if already held.
    std::string joinBudget(std::string name, std::string code);
    std::string selectBudget(std::string id);
    std::string renameBudget(std::string id, std::string name);
    std::string setBudgetColor(std::string id, std::string color);
    std::string deleteBudget(std::string id);

protected:
    void onContextReady() override;

logos_events:
    // Emitted with the fresh budget JSON whenever the log changes - the ui view
    // subscribes and re-renders (replaces the .rep PROP auto-sync).
    void budgetChanged(const std::string& budgetJson);
    // Emitted with a status string on connection-state / lifecycle changes.
    void statusChanged(const std::string& status);

private:
    // Per-budget state. Everything belonging to ONE household/budget lives here;
    // kym_core holds several at once (m_budgets), renders/edits the "current" one
    // (cur()), and syncs ALL of them in the background. The old single-budget
    // members (m_log, m_id, …) are now cur().log, cur().identity, … via cur().
    // Defined up here so the per-budget method declarations below can name it.
    struct Budget {
        std::string id, name, color, dir;
        std::vector<kym::Event> log;
        std::set<std::string> ids;
        kym::Identity identity;
        std::string topic, fingerprint;
        bool haveKey = false, subscribed = false;
        std::map<std::string, std::string> accountName, categoryName, groupName, categoryGroup, accountCurrency;
        std::vector<std::string> groupOrder;
        std::string currency = "CZK";
        int64_t wall = 0, ctr = 0;
        std::string viewMonth;                       // "" = live month, else the YYYY-MM viewed
        int64_t lastAutoResync = 0, lastSummaryTx = 0, lastFullServe = 0;
        long missing = 0;            // events WE lack per the last reconcile (d.aNeeds)
        int64_t lastReconcile = 0;   // ms of the last SUMMARY we processed
        // Store-seed burst: on each node-ready we publish the whole log a few times
        // (over the first ~90s, then stop) so the fleet store captures it and a phone
        // that can't get its own SYNC_REQ through the mesh can still store-pull the
        // history. NOT a perpetual rebroadcast — decremented to 0 and left there.
        int seedStoreRemaining = 0;
        std::string seedCatId; int seedTicks = 0;    // hub demo seed (per budget)
    };

    // event builders + helpers
    kym::HLC nextHlc();
    std::string currentMonth() const;
    std::string ensureGroup(const std::string& name);
    std::string addAccountEv(const std::string& name, const std::string& type, kym::Money bal, const std::string& currency = "");
    std::string addCategoryEv(const std::string& name, const std::string& group);
    void assignEv(const std::string& catId, const std::string& month, kym::Money amt);
    void moveEv(const std::string& fromId, const std::string& toId, const std::string& month, kym::Money amt);
    void txnEv(const std::string& acctId, kym::Money amt, const std::string& month, const std::string& catId);
    std::string findAccountId(const std::string& name) const;
    std::string findCategoryId(const std::string& name) const;
    std::string adminGuard();
    void pushEvent(const kym::Event& e, bool broadcast);
    void rebuildNameMaps();
    void publishBudget();                  // recompute budgetJson + emit budgetChanged
    void setStatus(const std::string& s);

    // delivery — routed per budget. ingestRaw matches the wire contentTopic to the
    // owning budget; sealAndSend/sendSummary seal with that budget's key + topic.
    void bootstrapDelivery();
    void ingestRaw(const std::string& contentTopic, const std::string& sealed);
    void sealAndSend(Budget& b, const kym::Event& e);
    void sendSyncReq();
    // Publish a sealed (base64) payload on a topic, ROBUST to either delivery build:
    // newer builds want a JSON byte array and throw "type must be array, but is
    // string" on a string; older builds want a string. We probe once (array→string),
    // cache the representation that didn't throw, and reuse it. Wire bytes are
    // identical — this only picks the in-process IPC shape. Prevents the SIGABRT that
    // an env-only gate (KYM_SEND_ARRAY) left on GUI hosts that can't set env.
    void deliverySend(const std::string& topic, const std::string& sealedB64);
    int m_sendRepr = 0; // 0=unprobed, 1=byte array, 2=string
    // Join a budget's transport: a Reliable Channel (SDS) when KYM_USE_CHANNELS is
    // set, else a raw content-topic subscription. channelId == the budget's derived
    // topic (every household device shares one channel); senderId = our device id.
    void joinBudgetTransport(Budget& b);
    // RBSR reconcile: broadcast our event-id set (id+hlc) so a peer can compute
    // and send back ONLY the events we're missing — replaces re-sending the whole
    // log. See kym_reconcile_std.hpp / packages/sync/src/reconcile.mjs.
    void sendSummary(Budget& b);
    // Poll delivery for the live peer count and fold it into the status string.
    // Async: refreshPeerCount() fires getNodeInfoAsync and parseAndApplyMetrics
    // handles the reply on the event-loop thread — never a blocking call.
    void refreshPeerCount();
    void parseAndApplyMetrics(const std::string &metrics);
    long m_peerCount = -1;
    std::string m_metricsBrief;   // raw connection gauges for the hub heartbeat
    // Periodic auto-resync (per budget): flaky mesh drops one-shot sends, so we
    // re-summarize every ~30s while connected — see Budget::lastAutoResync.
    void maybeAutoResync(Budget &b);
    // Receive/send accounting - surfaced in the budget JSON so a silent sync is
    // visible in the ui instead of looking exactly like an idle one. Delivery-wide
    // (counts across all budgets).
    long m_rxSeen = 0, m_rxOpened = 0, m_rxOpenFail = 0, m_rxNew = 0, m_rxDup = 0,
         m_rxDropped = 0, m_txTotal = 0;
    void scheduleBackfill();
    void loadPersistedLog(Budget &b);
    void savePersistedLog(Budget &b);
    void loadOrCreateSecret(Budget &b);                 // env > pair.key file > generate a fresh household
    void applySecret(Budget &b, const kym::Bytes& secret, bool persist);  // derive id/topic/fingerprint
    std::string m_dataDir;   // ROOT dir (~/.kym-core); each budget lives in <root>/<id>

    std::map<std::string, Budget> m_budgets;   // id -> budget
    std::vector<std::string> m_order;          // budget ids in display order
    std::string m_current;                     // the selected budget's id
    Budget &cur() { return m_budgets[m_current]; }
    const Budget &cur() const {
        auto it = m_budgets.find(m_current);
        static const Budget kEmpty{};
        return it == m_budgets.end() ? kEmpty : it->second;
    }
    Budget *budgetForTopic(const std::string &t) { for (auto &kv : m_budgets) if (kv.second.topic == t) return &kv.second; return nullptr; }
    // budget registry (budgets.json) + per-budget helpers
    void loadBudgets();                        // read budgets.json (+ migrate a legacy single budget)
    void saveBudgets();                        // persist the registry (ids, names, colors, current)
    std::string newBudgetId();
    void ensureBudgetLoaded(Budget &b);        // load its log + key from disk if not yet in memory

    std::string m_deviceId = "kym-core", m_budgetJson = "{}", m_status = "Starting...";
    std::string m_authorName;   // human attribution name stamped on locally-authored events ("" = off)
    bool m_nodeReady = false, m_ready = false;
    // loam_core receive+status handlers are registered once (not per bootstrap retry).
    bool m_loamWired = false;
    // True while a createNode→start→subscribe chain is in flight, so the poll
    // (hub loop / view) can't launch a second, overlapping delivery startup.
    bool m_deliveryStarting = false;

    // Concurrency. The delivery receive callback (ingestRaw) runs on delivery's
    // own thread, while the host thread — and, for a headless hub, the self-drive
    // loop below — call snapshot()/mutations. They all touch m_log/m_ids, so the
    // shared log is guarded at its choke points (ingestRaw, pushEvent, snapshot,
    // resync). Recursive so a public call can nest into an already-locked helper
    // on the same thread without deadlocking.
    std::recursive_mutex m_mtx;

    // Headless hub self-drive. A GUI stays synced because its QML view polls
    // snapshot() forever on a Timer (which lazily starts delivery, reloads the
    // shared log, and runs the periodic RBSR reconcile). A headless node has no
    // such poll. CRUCIAL: the delivery module's async calls (createNodeAsync,
    // send) only work when issued from the host's Qt event-loop thread — issuing
    // them from a worker std::thread leaves the callback undispatched and
    // createNode hangs. So the hub driver must be a QTimer on the main thread (the
    // same mechanism the QML Timer uses), NOT a std::thread. Gated by KYM_HUB so
    // the desktop app is completely unaffected.
    QTimer *m_hubTimer = nullptr;
};
