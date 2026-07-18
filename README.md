# KYM — Know Your Money

A **local-first, peer-to-peer, zero-based budget** on the Logos stack. They *Know Your Customer*; with KYM, **you know your money — and nobody else does.**

KYM is an envelope budget (a YNAB alternative) with no server and no cloud custody of your finances. A household shares one budget across devices that sync directly over **Logos Delivery (Waku)**, end-to-end encrypted. It has two halves:

- **`module/`** — the **KYM Basecamp module** (desktop, `ui_qml`, C++/Qt + QML, SQLite). This is where the budget lives: category envelopes, the monthly budget grid, accounts, the transaction register, reconciliation, targets and reports. **Most features live here.**
- **`mobile/`** — the **KYM companion app** (React Native / Expo, Android-first). Its one job: **capture an expense in under 10 seconds** — amount-first quick-add plus **on-device receipt OCR** (snap → prefilled amount, merchant, date). Fully offline; syncs when it can.
- **`packages/contract/`** — the shared **wire contract**: event schema, money type (integer milliunits), Hybrid Logical Clock. Dependency-free, re-implementable in C++/Kotlin.
- **`packages/engine/`** — the **portable budget engine**: folds a merged event log into budget state (Ready to Assign, category Available/Activity, account balances) as a pure deterministic projection, and checks the zero-based invariant. The reference is TS; the module re-implements it in C++.
- **`cli/`** — a headless demo that simulates two devices editing offline and proves they **converge to the same correct budget** after sync.
- **`docs/`** — [`plan.md`](docs/plan.md), [`architecture.md`](docs/architecture.md), [`data-model.md`](docs/data-model.md), [`research-notes.md`](docs/research-notes.md).

## The one hard problem, named up front

A household budget has **two or more concurrent writers by definition** — both partners record spending on their phones, offline, at the same time. Perun (our sibling project) documents that its last-write-wins sync *cannot* handle a second writer: two devices editing the same record "disagree permanently, with no error and no convergence." A run tracker can live with that. **A budget cannot** — silently losing money is the worst possible failure.

KYM is designed around this from line one. Recorded money is an **immutable append-only ledger** (an edit is a new event, never an overwrite); the budget plan is **commutative deltas** (moving money is a net-zero two-legged op, so concurrent edits *sum* instead of clobbering); and every balance is a **derived projection**, stored nowhere, recomputed identically on every device. Merges are a conflict-free union of events. See [`docs/data-model.md`](docs/data-model.md).

## Status

Early. The portable engine + contract + convergence demo are the first milestone (Phase 0). The Basecamp module and mobile app follow. See [`docs/plan.md`](docs/plan.md).

## Principle

Keep the phone thin, put the value in the Basecamp module. Money is never stored as a total — only as a fold over immutable facts. Storage/backup is off the sync hot path.
