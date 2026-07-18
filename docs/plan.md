# KYM on Logos — build plan (v1)

**Date:** 2026-07-18 · **Status:** drafting, iterating · No blockchain in scope.

Build **KYM (Know Your Money)** — a local-first, zero-based envelope budget — as two halves that sync over **Logos Delivery (Waku)**, mirroring Perun's proven shape but solving the problem Perun explicitly left open: **safe concurrent multi-writer sync of financial data.**

- **(A) KYM Basecamp module** — desktop `ui_qml` (C++/Qt + QML, SQLite). The budget: envelopes, monthly grid, accounts, register, reconciliation, targets, reports. **Where the value lives.**
- **(B) KYM Mobile** — React Native / Expo, Android-first. Fast expense capture + on-device receipt OCR. **Thin.**

Guiding principle: **keep the phone thin, put the value in the Basecamp module** — and **never store a balance, only fold immutable facts.**

---

## 1. Decisions (locked 2026-07-18)

1. **Stack matches Perun.** Basecamp module = C++/Qt6 + QML `ui_qml`, `interface: universal`, `.rep` contract + one backend, built via `logos-module-builder` Nix flake → `.lgx`, SQLite persistence, depends on `delivery_module`. Mobile = React Native/Expo (TS), Android-first, embeds `liblogosdelivery` via JNI (the `xAlisher/receiver-android` pattern). Reuse Perun's pairing/encryption code.
2. **Two-layer state model (the core decision).** Recorded money = an **immutable append-only event log** keyed by client-generated UUIDs (create/edit/delete are all appends). Budget plan (assignments, moves) = **commutative net-zero deltas**. All aggregates are **pure derived projections** over the merged log — stored nowhere. Merge = conflict-free union + idempotent dedup. See §4 and `data-model.md`. **This is what makes concurrent partner edits safe; it is non-negotiable.**
3. **Portable engine.** The fold from event-log → budget state is defined precisely in `data-model.md`, implemented as the reference in TS (`packages/engine/`), and re-implemented in C++ in the module. Both must produce byte-identical balances from the same log (validated by the invariant oracle). This is KYM's analogue of Perun's re-implementable track codec — except it is *logic*, not just a codec, so the spec is the contract.
4. **Money is integer milliunits** (currency × 1000), outflow negative, inflow positive, everywhere. No floats, ever.
5. **Invariants are surfaced, not enforced at merge.** "Ready to Assign = 0" and "category balance ≥ 0" are *global* properties that provably cannot be enforced from local-only state (two offline partners can each legitimately assign the last $100). They are recomputed after convergence and shown as **warning states** (negative RTA, red category) for humans to reconcile — exactly as YNAB itself tolerates.
6. **Ordering = Hybrid Logical Clock + node id** on every event, for causal ordering and deterministic tie-break. Per-field last-write-wins is allowed **only** for descriptive metadata (payee, memo, flags), never for numeric truth.
7. **Durability: the Basecamp module is the household's durable hub.** It holds the full event log in SQLite and can **re-serve (backfill)** events to a phone that reinstalls — fixing Perun's "phone is the only durable copy" gap via republish-on-demand over the existing envelope. Optional **Logos Storage / Codex** encrypted backup of the log is a later, module-side extra, off the hot path.
8. **Encryption/pairing reuse Perun's shipped approach** — QR-shared 32-byte household secret + pgp_words fingerprint; ChaCha20-Poly1305; topic derived via HMAC-SHA256 from the secret. One budget = one household PSK shared by all its devices. MLS/group crypto only if we later do cross-household sharing.
9. **No blockchain. No bank aggregator in v1** (privacy + scope). Import (CSV/OFX) and on-device capture are how transactions enter.

**Still open (provisional defaults in _italics_):** identity model (_household PSK now; per-device signing key for authorship/tie-break_); whether the phone runs the full engine or a thin projection (_full engine — it must show live balances offline_); Merkle-diff sync vs. naive replay for backfill (_naive replay v1, Merkle diff when logs grow_).

---

## 2. What carries over from Perun (verified by inspecting the repo)

- **The whole transport spine:** `delivery_module` v0.1.3 (`createNode/start/send(topic,payload)→reqId/subscribe`, base64 payloads both ways, **Waku 150 KB/message cap**), embedded on mobile as `liblogosdelivery` via JNI. Reuse the shared-singleton node handling, `messageReceived` **before** `start()`, defer bootstrap off `onContextReady()`, base64-decode payloads.
- **Pairing + encryption, shipped and working:** QR 32-byte secret + pgp_words fingerprint, ChaCha20-Poly1305 (`Ke = HKDF-SHA256(K,"kym/payload/v1")`, `nonce‖ciphertext`, `aad = topic`), topic via `HMAC-SHA256(K,"kym/topic/v1|"+epoch)`. Port near-verbatim from `docs/pairing-crypto.md`.
- **Module template:** `logos-tutorial` (tutorial-v4) / `forum-sample-app` — `ui_qml`, `interface: universal`, `.rep` + backend, `metadata.json` deps `["delivery_module"]`, build via `logos-module-builder`, package as `.lgx` (schema 0.3.0, Ed25519/`did:jwk`), `lgpm`. Perun's `module/` is a working reference to copy structure from (CMake, SQLite vendoring, QR card).
- **The chunking envelope + reassembly-by-(id,rev)** discipline, generalized to our event log (chunk large events; buffer by event UUID).

**What we deliberately do NOT carry over:** LWW-by-`rev`. Perun's own `wire-contract.md` proves it fails for a second writer (§"Multi-device — what works and what does not"). KYM replaces it with the append-only log + commutative deltas from the start.

## 3. Current Logos facts (from Perun, dated 2026-07-13/15)

- **Basecamp** modules are desktop Qt/QML plugins in isolated `logos_host` processes; host is **Linux/macOS** (iOS experimental, Android roadmap). `interface: universal` = Qt-free `std` types + LIDL codegen + `.rep` + one backend.
- **`delivery_module` v0.1.3**: payloads **base64 over FFI both directions**, **150 KB/message cap**. Node `logos-delivery` v0.38.1 exposes `liblogosdelivery` (the mobile embed). **No Store/history query in the FFI** — a fresh subscriber sees nothing already published → we need module-side backfill (decision §1.7).
- **`storage_module` v2.0.1**: REST `/api/storage/v1/data`; `logos-storage-nim` pre-alpha; public testnet paused → run our own node. Backup only, later.
- **Reuse sources:** `xAlisher/receiver-android` (RN + JNI), `forum-sample-app` + `logos-tutorial` (module template), Perun (`module/`, pairing-crypto), `logos-qt-mcp` (headless UI tests). Prior art for the state model: **Actual Budget** (open-source local-first YNAB alt; CRDT-messages→SQLite).

## 4. Architecture (summary — full detail in `architecture.md` + `data-model.md`)

```
KYM MOBILE (RN + liblogosdelivery JNI)            KYM BASECAMP MODULE (ui_qml, C++/Qt + QML)
──────────────────────────────────────           ───────────────────────────────────────────
 amount-first quick-add (<10s)                     delivery.subscribe(/kym/1/<household>/proto)
 on-device OCR (ML Kit) → editable prefill           → base64 decode → decrypt(householdKey)
 append events to local log (SQLite)                 → dedup by event UUID → append to SQLite log
 fold log → show balances offline                    → fold merged log → budget projection (C++)
 encrypt + chunk + delivery.send()  ──Delivery──►    → QML: monthly grid, register, targets, reports
 receive peers' events, merge, re-fold  ◄─Delivery── ── re-serve (backfill) log to reinstalled phones
                                                     [opt] Storage/Codex encrypted log backup (later)
```

**One expense, end to end:** phone captures amount (+OCR merchant/date) → creates a `txn.create` event (UUID, HLC, device id) → appends locally, balances update instantly offline → encrypts + `send()`s on `/kym/1/<household>/proto`. Every other device (the other partner's phone, the Basecamp) receives it, dedups by UUID, appends to its log, and re-folds. All devices converge to the same budget. No server; no balance ever transmitted — only immutable facts.

## 5. Wire contract + engine (built FIRST — `packages/contract/` + `packages/engine/` + `data-model.md`)

The single artifact both halves depend on; frozen before module/mobile work.
- **Event log:** every change is an event `{ v, id(uuid), type, hlc, dev, sig?, payload }`. Types: `account.create/edit/close`, `txn.create/edit/delete` (edit = superseding event, delete = tombstone), `category.create/edit/hide`, `assign` (set/delta a category-month budget), `move` (net-zero two-legged transfer between category-months).
- **Projection:** deterministic fold → `{ accounts[], categoryMonths[], readyToAssign, creditCardPayments[] }`. Reference in TS; spec authoritative.
- **Invariant oracle:** `Σ category.available + readyToAssign == Σ on-budget account balances`, checked after every fold in tests and after every merge in the apps.
- **Merge:** union of events by UUID (idempotent), HLC-ordered, then fold. Convergence = same event set → same state.
- **Encryption/chunking:** as Perun (§2).

## 6. Phased roadmap

- **Phase 0 — Contract + engine + convergence proof (NOW, target: tonight's prototype).** Freeze event schema, milliunits, HLC. Implement the reference engine (fold → budget state), the invariant oracle, and merge. `cli/` demo: two simulated devices apply concurrent offline edits (both assign, both spend, one moves money), sync logs, and **both converge to the same correct budget with the invariant holding**. Unit tests for cash/credit overspend, splits, transfers, credit-card relocation. *Exit: `npm test` green + demo prints identical convergent budgets from two divergent logs.*
- **Phase 1 — Basecamp module MVP.** Scaffold from `logos-tutorial`/Perun `module/`. Re-implement the engine fold in C++; SQLite event log; subscribe→decrypt→dedup→append→fold. QML: account list, monthly budget grid (Assigned/Activity/Available), transaction register, move-money. Headless `logos-qt-mcp` tests + a TS↔C++ fold parity test (same log → same balances). *Exit: module ingests the CLI's events and shows a correct budget grid.*
- **Phase 2 — Mobile capture MVP.** RN app: amount-first quick-add, local event log, offline balance display, pairing (QR/pgp_words port). *Exit: record an expense on the phone, see it locally.*
- **Phase 3 — liblogosdelivery on mobile + wire the bridge.** JNI (adapt receiver-android); encrypt + chunk + send; receive + merge on phone (both directions — the thing Perun never wired). *Exit: expense on phone → appears in Basecamp budget over Delivery, and Basecamp edits appear on phone. Two phones converge.*
- **Phase 4 — depth + capture polish.** On-device receipt OCR (ML Kit) → editable prefill; merchant→category learning; targets/goals, reconciliation, reports, scheduled txns; `.lgx` release; module-side backfill; optional Storage/Codex backup; iOS.

## 7. Data model (see `data-model.md` for the authoritative spec)

```ts
Money = number            // integer milliunits; $10.50 = 10500; outflow < 0, inflow > 0
HLC   = { wall, ctr, dev } // hybrid logical clock: wall-ms, same-ms counter, device id
Event = { v:1, id:UUID, type:EventType, hlc:HLC, dev:DeviceId, payload:… }

Account = { id, name, type:'checking'|'savings'|'cash'|'creditCard'|'lineOfCredit'|'tracking', onBudget, closed }
Txn     = { id, accountId, amount:Money, date, payeeId?, categoryId?|splits[], cleared:'uncleared'|'cleared'|'reconciled', approved, memo?, transferId? }
Category= { id, groupId, name, hidden, system? }         // system: 'rta-inflow' | 'ccp:<accountId>'
Assign  = { categoryId, month:'YYYY-MM', amount:Money }   // set the budgeted number for a category-month
Move    = { fromCategoryId, toCategoryId, month, amount:Money }  // net-zero, two legs

// All derived, never stored:
BudgetState = { accounts:{id→balance}, categoryMonths:{(cat,month)→{assigned,activity,available}},
                readyToAssign:Money, creditCardPayments:{accountId→available} }
```

## 8. Risks (ranked)

1. **Merge correctness of money** — the whole bet. Mitigated by: never LWW on amounts; append-only postings; balances = fold; invariant oracle as a continuous test; property-based convergence tests (random concurrent edit sequences must converge + preserve the invariant).
2. **TS↔C++ engine drift** — two implementations of the fold can diverge. Mitigated by a shared golden-vectors test: a set of (event log → expected balances) fixtures both implementations must pass.
3. **`liblogosdelivery` on mobile + bidirectional merge** — Perun only ever did phone→desktop, send-only. KYM needs phone↔phone↔desktop. Mitigated by spiking the JNI bridge early (Phase 0 side-task) and by the merge being commutative regardless of direction.
4. **Backfill / durability** — no Store in the FFI. Mitigated by module-side republish-on-demand + optional Storage backup; the append-only log makes re-serving trivial (just resend events).
5. **OCR wrong on bad receipts** — mitigated by always presenting OCR as *editable prefill*, a pre-OCR quality gate, and keeping the original image + raw OCR for re-parse.
6. **150 KB cap** — a single event is tiny; only bulk backfill needs chunking (reuse Perun's chunk envelope).
