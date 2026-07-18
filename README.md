# KYM — Know Your Money

A **local-first, peer-to-peer, zero-based budget** on the Logos stack. They *Know Your Customer*; with KYM, **you know your money — and nobody else does.**

KYM is an envelope budget (a YNAB alternative) with no server and no cloud custody of your finances. A household shares one budget across devices that sync directly over **Logos Delivery (Waku)**, end-to-end encrypted. It has two halves:

- **`module/`** — the **KYM Basecamp module** (desktop, `ui_qml`, C++/Qt + QML, durable append-only event log). This is where the budget lives: category envelopes, the monthly budget grid, accounts, the transaction register, reconciliation, targets and reports. **Most features live here.**
- **`mobile/`** — the **KYM companion app** (React Native / Expo, Android-first). Its one job: **capture an expense in under 10 seconds** — amount-first quick-add plus **on-device receipt OCR** (snap → prefilled amount, merchant, date). Fully offline; syncs when it can.
- **`packages/contract/`** — the shared **wire contract**: event schema, money type (integer milliunits), Hybrid Logical Clock. Dependency-free, re-implementable in C++/Kotlin.
- **`packages/engine/`** — the **portable budget engine**: folds a merged event log into budget state (Ready to Assign, category Available/Activity, account balances) as a pure deterministic projection, and checks the zero-based invariant. The reference is TS; the module re-implements it in C++.
- **`packages/sync/`** — household crypto + the Delivery wire envelope + a transport-agnostic `SyncNode` (the real transports plug in under it).
- **`cli/`** — a full headless budget (envelopes, targets, import, categorize, reconcile, reports) plus a convergence demo proving two devices editing offline **fold to the same correct budget** after sync.
- **`docs/`** — [`plan.md`](docs/plan.md), [`architecture.md`](docs/architecture.md), [`data-model.md`](docs/data-model.md), [`sync.md`](docs/sync.md), [`research-notes.md`](docs/research-notes.md).

## The one hard problem, named up front

A household budget has **two or more concurrent writers by definition** — both partners record spending on their phones, offline, at the same time. Perun (our sibling project) documents that its last-write-wins sync *cannot* handle a second writer: two devices editing the same record "disagree permanently, with no error and no convergence." A run tracker can live with that. **A budget cannot** — silently losing money is the worst possible failure.

KYM is designed around this from line one. Recorded money is an **immutable append-only ledger** (an edit is a new event, never an overwrite); the budget plan is **commutative deltas** (moving money is a net-zero two-legged op, so concurrent edits *sum* instead of clobbering); and every balance is a **derived projection**, stored nowhere, recomputed identically on every device. Merges are a conflict-free union of events. See [`docs/data-model.md`](docs/data-model.md).

## Try it

```sh
npm install
npm test        # engine + sync tests, incl. a 200-trial convergence property test + golden vectors
npm run demo    # two partners edit one budget offline, then sync → identical result

# drive a real budget from the CLI (the JSON event log IS the Delivery wire format):
K="node cli/kym.mjs --file laptop.json"
$K init --currency CZK
$K account add Checking --type checking --balance 30000
$K account add Revolut --type tracking --balance 420 --currency EUR   # EUR held off-budget, no FX
$K category add Groceries --group Everyday
$K income 45000 --account Checking
$K assign Groceries 8000
$K target Groceries monthly 8000            # funding goal → 🎯 funded / need X
$K spend 1240.50 --account Checking --category Groceries --payee "Albert"
$K import airbank-export.csv --account Checking --format airbank   # local-first bank import (dedup)
$K categorize Albert Groceries              # bulk-categorize imported rows
$K reconcile Checking 63500 --adjust        # match the bank; book an adjustment if off
$K budget ; $K report ; $K networth
# then: cp laptop.json phone.json, edit each offline, and `kym sync` them → they converge.
```

Full command set: `init · account · category · income · spend · assign · move · target · import · categorize · reconcile · report · networth · budget · accounts · sync · log`.

## Install & distribute

**Basecamp module** — add this repository in Basecamp → Settings → Package Repositories, then install **KYM**:

```
https://raw.githubusercontent.com/vpavlin/kym/master/repo/logos-repo.json
```

Releases are cut by pushing a `module-v*` tag: CI (`.github/workflows/release-module.yml`) builds the portable `.lgx`, attaches it to a GitHub Release, and refreshes `repo/index.json` on `master`. Regenerate the index locally with `scripts/gen-repo-index.sh module-vX.Y.Z`.

**Mobile app** — Android APK via the self-hosted F-Droid repo (arm64). The APK is built and **signed locally** (`scripts/build-apk.sh` + `scripts/release-apk.sh`, tag `mobile-v*`) — the signing key never touches CI. On the LAN, `scripts/serve-lan.sh` serves both the Basecamp package repo and the F-Droid repo over one HTTPS host.

## Status

Phases 0–3 are substantially built; Phase 4 (budgeting depth) is well underway.

- **Engine + contract + sync core** — the deterministic fold + zero-based invariant, conflict-free merge, household crypto (ChaCha20-Poly1305, HMAC topic) and the transport-agnostic `SyncNode`. Guarded by unit tests, a 200-trial convergence property test, golden vectors, and **cross-language C++↔TS parity** (crypto 5/5, ingest 7/7).
- **Basecamp module** (`module/`) — C++/Qt + QML, mirrors the engine (24/24 parity), builds to a portable `.lgx`, renders the budget grid (with funding targets), and is wired to **`delivery_module`** for live sync + auto-backfill; the log persists as a durable hub.
- **Mobile** (`mobile/`) — Android-first Expo app: amount-first capture, offline balances via the shared engine, **two-way Delivery sync** (`liblogosdelivery`), and **on-device receipt OCR** (ML Kit, Czech-aware).
- **CLI** (`cli/`) — a full working budget: envelopes, targets, bank CSV/OFX import with dedup, categorize, reconcile, reports, net worth, and real file-based two-device sync.
- **Currency** — one budget currency (default CZK) + foreign accounts (EUR) held as off-budget tracking, no in-budget FX.
- **Pipeline** — Basecamp package repo + F-Droid repo + CI, aggregated on a common LAN host.

**Needs real hardware to verify:** the live phone↔Basecamp Delivery round-trip, the inbound native FFI event shape, and OCR accuracy on real receipts. Everything up to that line — logic, crypto, merge, builds — is green. See [`docs/plan.md`](docs/plan.md) and [`docs/sync.md`](docs/sync.md).

## Principle

Keep the phone thin, put the value in the Basecamp module. Money is never stored as a total — only as a fold over immutable facts. Storage/backup is off the sync hot path.
