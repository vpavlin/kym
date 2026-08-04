# KYM — Know Your Money

A **local-first, peer-to-peer, zero-based budget** on the Logos stack. They *Know Your Customer*; with KYM, **you know your money, and it stays end-to-end encrypted between your household's own devices.**

KYM is an envelope budget (a YNAB alternative) with no server and no cloud custody of your finances. A household shares a budget across devices that sync directly over **Logos Delivery (Waku)**, end-to-end encrypted. You can hold **several budgets at once** — e.g. yours, your partner's, and a shared one — each its own household.

## Layout

- **`kym_core/`** — the **core module** (a Logos *universal* module, C++, Qt-free). This is KYM: the append-only event log, the budget engine, crypto, the Delivery wire codec, range-based reconciliation, and all budget / transaction / pairing / **multi-budget** logic. It runs in **two places from one codebase** — behind the desktop view, *and* standalone under `logoscore` as an **always-on headless hub** (availability without a server). No logic is duplicated.
- **`module/`** — the desktop **`kym` view** (Basecamp `ui_qml`, pure QML). A thin surface that calls `kym_core` and renders its budget JSON: the monthly grid, envelopes, accounts, the transaction list, reconciliation, targets, multi-budget switcher, and sharing.
- **`mobile/`** — the **companion app** (React Native / Expo, Android-first). Its one job: **capture an expense in under 10 seconds** — amount-first quick-add plus **on-device receipt OCR** (snap → prefilled amount, merchant, date). Also a full offline budget view, transaction edit/delete, multiple budgets, and share/join. **Syncs directly with the rest of the household over SDS Reliable Channels — proven end-to-end on real arm64 hardware** (both directions, live and after offline edits).
- **`packages/contract/`** — the shared **wire contract**: event schema, money type (integer milliunits), Hybrid Logical Clock. Dependency-free, re-implemented in C++.
- **`packages/engine/`** — the **portable budget engine** (TS reference): folds a merged event log into budget state (Ready to Assign, category Available/Activity, account balances) as a pure deterministic projection, and checks the zero-based invariant. `kym_core` mirrors it in C++, guarded by golden vectors.
- **`packages/sync/`** — household crypto (ChaCha20-Poly1305, HMAC topic) + the Delivery wire envelope + range-based set reconciliation (Negentropy/RBSR).
- **`cli/`** — a full headless budget (envelopes, targets, import, categorize, reconcile, reports) plus a convergence demo proving two devices editing offline **fold to the same correct budget** after sync.
- **`docs/`** — [`architecture.md`](docs/architecture.md), [`data-model.md`](docs/data-model.md), [`sync.md`](docs/sync.md), [`decisions.md`](docs/decisions.md) (the decision log / ADRs), [`logos-dev-notes.md`](docs/logos-dev-notes.md) (hard-won Basecamp/Delivery gotchas), [`plan.md`](docs/plan.md), [`test-guide.md`](docs/test-guide.md).

## The one hard problem, named up front

A household budget has **two or more concurrent writers by definition** — both partners record spending on their phones, offline, at the same time. Perun (our sibling project) documents that its last-write-wins sync *cannot* handle a second writer: two devices editing the same record "disagree permanently, with no error and no convergence." A run tracker can live with that. **A budget cannot** — silently losing money is the worst possible failure.

KYM is designed around this from line one. Recorded money is an **immutable append-only ledger** (an edit is a superseding event, a delete is a tombstone — never an overwrite); the budget plan is **commutative deltas** (moving money is a net-zero two-legged op, so concurrent edits *sum* instead of clobbering); and every balance is a **derived projection**, stored nowhere, recomputed identically on every device. Merges are a conflict-free union of events. See [`docs/data-model.md`](docs/data-model.md) and decisions [#20/#21](docs/decisions.md).

## Households & multiple budgets

A **budget is a household**: its own 32-byte secret → its own Delivery topic → its own event log. A device can hold several at once, and they **all sync in the background**; you edit the *current* one. Privacy is simply *who you share the pairing code with* — a budget whose code you never share stays private (but still pairs across your own devices + hub).

- **Share a budget** — show its QR / code on another device (your laptop, a partner, a Basecamp). They start empty and **sync it from scratch**. Each budget is shared separately; a device you don't share it with never sees it.
- **Colour per household** — a budget's colour is derived deterministically from its topic, so the *same* household shows the *same* colour on every device.
- **Access is per-budget, not per-transaction** — anyone with the code has full read/write (like a shared account). Per-member roles/signatures are deferred to a future MLS-based layer (libchat); the current model is intentionally simple.

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

**Desktop (Basecamp)** — install two packages, **`kym_core`** (the core module) and **`kym`** (the view). Add a package repository in Basecamp → Settings → Package Repositories:

```
https://raw.githubusercontent.com/vpavlin/kym/master/repo/logos-repo.json
```

Releases are cut by pushing a `module-v*` tag: CI builds the portable `.lgx` and refreshes `repo/index.json`. During active development the packages are also served from a **self-hosted LAN repo** (both modules rebuilt with `regen.sh` and served over HTTPS), which is how the maintainer's Basecamp installs day to day.

**Mobile app** — Android APK via a self-hosted **F-Droid** repo (arm64). The APK is built and **signed locally** (`scripts/build-apk.sh`) — the signing key never touches CI.

## Status

The engine, contract, crypto, merge, and both module builds are green and cross-checked. **Cross-device sync works headless today** — an always-on `kym_core` hub, rebuilt against the fixed cpp-sdk, ingests a live Basecamp's edits two-way. The **mobile Delivery transport is still being stabilised on real hardware.**

- **Engine + contract + sync core** — deterministic fold + zero-based invariant, conflict-free merge, household crypto and range-based reconciliation. Guarded by unit tests, a 200-trial convergence property test, golden vectors, and **cross-language C++↔TS parity** (crypto, wire, reconcile, engine).
- **`kym_core` + desktop view** — one C++ core behind the `kym` view *and* as a headless `logoscore` hub. Multiple budgets, transaction **edit/delete**, category **archive/delete**, author **attribution**, and per-budget **sharing** are built and shipped. The view is validated both in an offscreen render harness and on a real Basecamp; the **two-way headless hub is proven on the current cpp-sdk** (it converges with a live Basecamp).
- **Mobile** — Android-first Expo app: amount-first capture with a note field, ML-Kit OCR, offline balances via the shared engine, multiple budgets with a colour-coded switcher, share/**join** (scan a QR), transaction edit/delete, and attribution. Runs on a real arm64 phone; the **light-client Delivery receive path (Waku filter) is being debugged** — send works, but the fleet doesn't always serve the phone's filter subscription ("filter 0"), so two-way phone sync is not yet reliably confirmed.
- **CLI** — a full working budget with real file-based two-device sync.
- **Currency** — one budget currency (default CZK) + foreign accounts held as off-budget tracking, no in-budget FX.

**Needs real hardware to finish:** the mobile phone↔fleet receive path (filter service), and OCR accuracy on real receipts. See [`docs/plan.md`](docs/plan.md), [`docs/sync.md`](docs/sync.md), and [`docs/test-guide.md`](docs/test-guide.md).

## Principle

One engine, thin surfaces. Money is never stored as a total — only as a fold over immutable facts. Availability comes from an always-on peer (the hub), not a server. Storage/backup is off the sync hot path.

## License

Dual-licensed under either **MIT** ([LICENSE-MIT](LICENSE-MIT)) or **Apache-2.0** ([LICENSE-APACHE](LICENSE-APACHE)) at your option — matching the Logos / Basecamp ecosystem.
