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

## Try it (Phase 0 — working today)

```sh
npm install
npm test        # engine unit tests + a 200-trial convergence property test
npm run demo    # two partners edit one budget offline, then sync → identical result

# drive a real budget from the CLI (append-only event log = the wire format):
node cli/kym.mjs --file laptop.json init --device laptop
node cli/kym.mjs --file laptop.json account add Checking --type checking --balance 2000
node cli/kym.mjs --file laptop.json category add Groceries --group Everyday
node cli/kym.mjs --file laptop.json income 3000 --account Checking
node cli/kym.mjs --file laptop.json assign Groceries 400
node cli/kym.mjs --file laptop.json spend 54.30 --account Checking --category Groceries --payee "Corner Shop"
node cli/kym.mjs --file laptop.json budget
# then: cp laptop.json phone.json, edit each offline, and `kym sync` them → they converge.
```

## Status

Phase 0 **done**: the portable engine, wire contract, convergence proof, and a usable CLI budget all work (`npm test` green; concurrent offline edits converge with the zero-based invariant holding). Phase 1 (the Basecamp C++/QML module mirroring this engine) and the mobile capture app follow. See [`docs/plan.md`](docs/plan.md).

## Principle

Keep the phone thin, put the value in the Basecamp module. Money is never stored as a total — only as a fold over immutable facts. Storage/backup is off the sync hot path.
