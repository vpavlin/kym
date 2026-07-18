# KYM — feature parity across surfaces

Honest status of what each surface can actually *do* today, the intended target, and the gaps. (Snapshot 2026-07; keep updated.)

## Surfaces
- **CLI** (`cli/kym.mjs`) — the reference, most-complete surface today.
- **Mobile** (`mobile/`) — the thin capture app (by design), currently the richest *interactive* surface.
- **Desktop / Basecamp module** (`module/`) — intended as the full budgeting surface; **today a read-only viewer**.

## Matrix

| Capability | CLI | Mobile | Desktop |
|---|:--:|:--:|:--:|
| View grid (envelopes, targets, CCP, invariant) | ✓ | ✓ | ✓ |
| Add / manage accounts | ✓ | ✓ | backend SLOT, **no UI** |
| Add / manage categories | ✓ | ✓ | backend SLOT, **no UI** |
| Capture expense (manual) | ✓ | ✓ | SLOT, **no UI** |
| Receipt OCR | — | ✓ | ✗ |
| Assign to categories | ✓ | ✓ | SLOT, **no UI** |
| Move money between categories | ✓ | ✗ | SLOT, **no UI** |
| Targets — set | ✓ | ✗ | ✗ (grid *displays* them) |
| Categorize (learned) | ✓ | ✓ | ✗ |
| Reconcile | ✓ | ✗ | ✗ |
| Bank CSV/OFX import | ✓ | ✗ | ✗ |
| Reports / net worth | ✓ | balances only | ✗ |
| Currency CZK/EUR + tracking | ✓ | ✓ | ✓ |
| Delivery sync + backfill | file-sync | ✓ | ✓ |
| Pairing (QR / fingerprint) | — | ✓ | fingerprint shown |
| Group budgets | ✗ | ✗ | ✗ (planned #12) |

## The headline gap (decision #15)
The design intent — *"thin phone, value in Basecamp"* — is **not yet true**. Real usability today is **CLI ⟩ Mobile ⟩ Desktop**, the inverse. The Basecamp module is a strong *viewer* (the grid, targets, invariant all render, and Delivery sync works), but its QML has almost no **edit controls**, and the backend is missing SLOTs for `target`, `reconcile`, `categorize`, `report`, `import`. So you can *watch* a budget in Basecamp but not *run* one there.

## To reach the intended target
1. **Desktop editor UI** (the priority): QML controls wired to the existing SLOTs (add account/category, capture, assign, move) + add the missing backend SLOTs (`setTarget`, `reconcile`, `categorize`, `report`, `importCsv`) and their UI. This makes Basecamp the full budgeting surface.
2. **Mobile depth** (optional, per the thin-phone principle): decide which of move/targets/reconcile belong on the phone. Capture + review + glance is the core; the rest can stay desktop/CLI.
3. **CLI** stays the complete reference + automation surface.

## Not built (tracked)
- **Group budgets** — #12 (membership, roles, MLS revocation, expense splitting). Only the flat-household shared key exists today.
- **Bank auto-import** (aggregator) — #8. CSV import (manual export) is done.
- **AI assistant write-tools + on-device model** — #9. Read-only MCP done (#11).
- **DeFi savings** — #10 (see `research-defi.md`).
