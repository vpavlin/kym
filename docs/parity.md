# KYM — feature parity across surfaces

Honest status of what each surface can actually *do* today, the intended target, and the gaps. (Snapshot 2026-07; keep updated.)

## Surfaces
- **CLI** (`cli/kym.mjs`) — the reference, most-complete surface.
- **Mobile** (`mobile/`) — the thin capture app (by design): capture + OCR + review + glance.
- **Desktop / Basecamp module** (`module/`) — now an **editor** (command bar + inline forms + click-to-assign), the intended full budgeting surface.

## Matrix

| Capability | CLI | Mobile | Desktop |
|---|:--:|:--:|:--:|
| View grid (envelopes, targets, CCP, invariant) | ✓ | ✓ | ✓ |
| Add / manage accounts | ✓ | ✓ | ✓ (command bar) |
| Add / manage categories | ✓ | ✓ | ✓ |
| Capture expense / income | ✓ | ✓ | ✓ |
| Receipt OCR | — | ✓ | ✗ (desktop VLM planned) |
| Assign to categories | ✓ | ✓ (tap envelope) | ✓ (+ click a category) |
| Move money between categories | ✓ | ✓ (tap envelope → pick dest) | ✓ |
| Targets — set | ✓ | ✓ (tap envelope) | ✓ |
| Reconcile | ✓ | ✓ (tap account) | ✓ |
| Categorize (learned) | ✓ | ✓ | ✗ (SLOT TODO) |
| Bank CSV/OFX import | ✓ | ✗ | ✗ (SLOT TODO) |
| Reports / net worth | ✓ | ✓ net worth; spending report in engine | ✗ (engine ready; no QML view) |
| Currency CZK/EUR + tracking | ✓ | ✓ | ✓ |
| Delivery sync + backfill | file-sync | 🟡 phone-side ran (earlier); round-trip unverified | 🟡 wired, unverified on host |
| Pairing (QR / fingerprint) | — | 🟡 coded | fingerprint shown |
| Group budgets — membership + roles | ✓ (file-sync) | 🟡 Setup card (built, tsc-clean) | 🟡 UI built, mock-validated |
| Pairing (share/join household) | — | ✓ show code/QR + join (paste/URI) | ✓ share code+fingerprint + join (base32 mobile-parity 6/6) |

## Status of the headline gap (decision #15)
**Runs on the real Basecamp host — the budget editor opens and renders.** The desktop module was re-architected as a **pure-QML `ui_qml` view over the `kym_core` core module** (no C++ backend / `.rep`): the view calls `kym_core` through `logos.callModule("kym_core", action, [args])` and reads state by polling a `snapshot()` action (basecamp 1.0.0 does not deliver module events to QML). Verified live under Xvfb: the KYM tab opens on click and shows the real folded budget (RTA in Kč, "invariant holds", "Paired ✓"); mutations reach and persist correctly in `kym_core`. The blocker that had kept the view from opening was a manifest/version skew, not the UI — see `logos-dev-notes.md` ("The ACTUAL blocker was the manifest `main` field"): basecamp 1.0.0 loads the QML from `manifest.main.<variant>` (the pinned builder emits `main:{}` and uses `view`), so the published `.lgx` is post-processed to set `main` (baked into `~/vpavlin-home/regen.sh`).

**Known open item:** live reflection of a *fresh* edit in the view is intermittent under the test host — writes and the polling read appear to land on different `kym_core` instances (basecamp may run the dependency as more than one instance); the edit persists correctly but may not repaint until re-read. Needs confirmation on a clean single-instance host. See `logos-dev-notes.md` ("Basecamp may run a dependency module as MULTIPLE instances").

Remaining desktop items (smaller): `categorize`, `importCsv`, and `report`/`net worth` actions + UI; member-management controls; and a UX polish pass — see `research-ux.md`.

## Mobile (per the thin-phone principle)
Capture + auto-categorize + review + glance is built; the app has **run on a real arm64 phone in earlier builds**. Full budgeting is now on the phone too, through the **same shared engine**: tap an envelope to **assign** / **set a /mo target** / **move** money to another envelope, tap an account to **reconcile** to your bank balance, and an **Expense/Income** toggle on Capture books income to Ready-to-Assign. All five ops are wired to `BudgetContext` and covered by `packages/engine/test/mobile-ops-parity.test.mjs` (5 tests, green). Still unverified on-device: OCR real-receipt accuracy, the **current** build, and the phone↔Basecamp round-trip (Basecamp untested) — the ops are engine-tested but the RN screens haven't been re-run on a device.

## Group budgets (#12) — phase 1
- **Built + tested (engine/CLI):** opt-in `group.init`; roles admin/editor/viewer; admission enforced on merge in the engine (TS `admitEvents` + C++ mirror, parity-tested); CLI (`group init`, `member add|role|remove`, `members`) — verified across three budgets via **file-sync**; `isGroup`/`members` in the folded state & backend JSON. See data-model.md §10.
- **Built, mock-validated only:** desktop SLOTs + command bar + members strip (rendered in the harness, not run on the real host). Live group sync over the real Waku transport is **not verified**.
- **Mobile:** a "Group budget" card on the Setup screen — make-a-group, members list with roles + your own role, and (for admins) add / change-role / remove members by device id. Built + `tsc`-clean; **not yet run on a device**.
- **Remaining (later phases):** per-member signatures (so a member can't forge another's author); MLS group keys + revocation/re-key; expense splitting & settle-up; mobile UI for membership.

## Not built (tracked)
- **Bank auto-import** (aggregator) — #8. CSV import (manual export) is done.
- **AI assistant write-tools + on-device model** — #9. Read-only MCP done (#11).
- **DeFi savings** — #10 (see `research-defi.md`).
