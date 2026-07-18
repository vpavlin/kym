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
| Assign to categories | ✓ | ✓ | ✓ (+ click a category) |
| Move money between categories | ✓ | ✗ | ✓ |
| Targets — set | ✓ | ✗ | ✓ |
| Reconcile | ✓ | ✗ | ✓ |
| Categorize (learned) | ✓ | ✓ | ✗ (SLOT TODO) |
| Bank CSV/OFX import | ✓ | ✗ | ✗ (SLOT TODO) |
| Reports / net worth | ✓ | balances only | ✗ (TODO) |
| Currency CZK/EUR + tracking | ✓ | ✓ | ✓ |
| Delivery sync + backfill | file-sync | ✓ | ✓ |
| Pairing (QR / fingerprint) | — | ✓ | fingerprint shown |
| Group budgets | ✗ | ✗ | ✗ (planned #12) |

## Status of the headline gap (decision #15)
**Largely closed.** The Basecamp module is now an editor: a command bar (+ Expense, + Income, Assign, Move, Target, Reconcile, + Account, + Category, Sync) with inline forms wired to the backend SLOTs via `logos.watch`, plus click-a-category-to-assign. New SLOTs added: `income`, `setTarget`, `reconcile` (+ `assignedRaw` in the JSON for editable cells). So "value lives in Basecamp" is now real for core budgeting.

Remaining desktop items (smaller): `categorize`, `importCsv`, and `report`/`net worth` SLOTs + UI; and a UX polish pass (dropdowns instead of typed names, keyboard nav, inline cell editing) — see the UI/UX audit + `research-ux.md` (#TBD).

## Mobile (per the thin-phone principle)
Capture + OCR + auto-categorize + review + glance is the core and is done. Move / targets / reconcile / reports can stay on desktop+CLI unless the UX audit says otherwise.

## Not built (tracked)
- **Group budgets** — #12 (membership, roles, MLS revocation, expense splitting). Only the flat-household shared key exists today.
- **Bank auto-import** (aggregator) — #8. CSV import (manual export) is done.
- **AI assistant write-tools + on-device model** — #9. Read-only MCP done (#11).
- **DeFi savings** — #10 (see `research-defi.md`).
