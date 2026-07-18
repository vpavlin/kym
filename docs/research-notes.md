# KYM research notes

Curated from a multi-agent research pass (2026-07-18) over YNAB's model/features, mobile fast-capture UX, local-first p2p conflict resolution for ledger data, and on-device OCR. Raw findings: [`research-raw.json`](research-raw.json).

## 1. What KYM is copying from YNAB (the model)

YNAB is zero-based, digital-envelope budgeting. The model rests on one invariant: **every dollar in on-budget accounts is either assigned to a category (its "Available") or waiting in the single global "Ready to Assign" pool.** The four rules are the UX framing of that: (1) give every dollar a job → drive RTA to 0 using only money on hand; (2) embrace true expenses → accumulate Available across months (sinking funds); (3) roll with the punches → move money between categories; (4) age your money → build a buffer.

Rules a faithful clone must enforce (→ encoded in [`data-model.md`](data-model.md)):
- **Milliunits.** All money is integer × 1000; outflow negative, inflow positive. Never floats.
- **The monthly grid**: per (category, month), only **Assigned** is user-editable; **Activity** (Σ categorized txns) and **Available** are derived. `Available = carryover + Assigned + Activity`.
- **Rollover**: positive Available rolls forward; **negative does not** (category resets toward 0; the shortfall is handled globally).
- **Ready to Assign** is a single global derived number = income − all assigned − cash overspending. Can be negative. Not per-month.
- **Overspending branches on funding account type**: cash overspend hits next month's RTA; credit overspend becomes debt in that card's Credit Card Payment category and does **not** touch RTA.
- **Credit cards**: each on-budget card has an auto **Credit Card Payment** category. A funded card purchase relocates budgeted money (spending category → payment category), net-zero; the card account goes into debt. System categories (`Inflow: RTA`, per-card payment) are non-deletable/non-editable.
- **Transactions**: splits (subtransactions sum to parent), transfers (mirrored linked pair, budget-neutral between on-budget accounts), cleared/uncleared/**reconciled** (locked), a separate `approved` gate for imports.

## 2. Feature split (what lives where)

**Basecamp (most features)** — category/grid management, the monthly grid editor, move-money, accounts, full register (splits/transfers), credit-card payment engine, reconciliation, targets/goals, and later: reports (spending/trends/income-v-expense), Age of Money, scheduled/recurring, CSV/OFX import with dedup, payee rename rules, multi-currency, off-budget/net-worth.

**Mobile (thin, fast capture)** — amount-first quick-add (amount is the only required field; everything else defaulted), OS fast-open surfaces (widget/App Shortcut/Siri), **offline-first** (save from local state, never block on network), a **review inbox** to enrich partial captures later, and **on-device receipt OCR**. Later: Wallet/tap-to-pay auto-capture, bank SMS parsing, voice entry.

**Shared** — milliunit money, the two-layer event model, derived aggregates, HLC ordering, UUID dedup, payee as a first-class entity, three-value cleared enum.

## 3. Local-first p2p — the load-bearing research

This is where a budget differs hardest from a run tracker, and where the research was decisive.

- **Naive LWW on a monetary amount or a stored balance is a structural lost update.** Two offline peers editing concurrently silently destroy money with no error. Highest-severity failure mode. (Perun's own docs confirm this happens with a second writer.)
- **Fix — a hybrid two-layer model** (adopted): Layer 1 recorded money = immutable append-only event log keyed by UUIDs (create/edit/delete all appends → merge is conflict-free union); Layer 2 the plan = commutative delta/move ops (concurrent edits sum). **All aggregates are pure projections over the merged log — stored nowhere** → invariants are automatically consistent across replicas after convergence, no repair logic.
- **The global invariants (RTA=0, balance≥0) cannot be enforced at merge time** from local-only state (two partners can each legitimately assign the last $100 offline). Do not treat them as merge constraints — recompute as projections and **surface as warning states** for human reconciliation (exactly YNAB's tolerated red/negative states).
- **Determinism**: HLC (wall + same-ms counter + node id) so all replicas order + tie-break identically; projection is a pure function of the ordered set. Validate with the invariant identity as a test oracle.
- **Idempotency**: durable unique index on the client UUID (in-memory dedup sets are empty mid-replay → duplicates slip through). Bank-imported rows lack a shared UUID → dedup on a fingerprint (date+amount+payee+account).
- **Prior art**: **Actual Budget** — an open-source local-first YNAB alternative — uses a CRDT message-log → SQLite pattern. Directly validates the approach.

**Rejected alternatives**: pure-CRDT-everywhere (opaque counters can't itemize auditable postings; field-LWW still loses concurrent amounts) and a single flat event log without the delta plan layer (absolute assignment `set`s would clobber concurrent plan edits).

## 4. On-device OCR (mobile, offline)

- **Capture**: native document scanner — iOS `VNDocumentCameraViewController` (VisionKit), Android `CameraX` / ML Kit Document Scanner — for deskew/crop.
- **OCR**: iOS Vision `VNRecognizeText`, Android **ML Kit Text Recognition v2**. Fully offline, no server.
- **Extraction**: deterministic heuristics — amount near "TOTAL", date regexes, merchant from the top block — producing an **editable prefill**, never final truth. Persist the original image + raw OCR text/bboxes/confidence for later re-parse.
- **Category**: static merchant→category keyword map + a per-user learned override table (upgrade to an on-device TFLite/Core ML classifier later).
- **Quality gate** before OCR (blur/resolution/char-size) to cheaply raise accuracy.
- **Risk**: OCR is wrong on a meaningful fraction of receipts (faded thermal, wrapped lines, foreign formats) → always editable prefill + one-tap confirm; user corrections become training data.

For KYM v1, the honest target is: **snap a receipt → prefilled amount + merchant + date, editable, offline.** Line-item extraction and learned categorization are progressive enhancements.

## 5. Direct consequences for KYM (design decisions taken)

1. Two-layer append-only + commutative-plan model — [`data-model.md`](data-model.md) §1.
2. Milliunits everywhere; balances never stored, always folded.
3. Invariant as a test oracle + display warning, never a merge gate.
4. HLC + UUID dedup for deterministic, idempotent merge.
5. Basecamp module = durable hub + backfill re-serve (fixes Perun's durability gap).
6. Mobile = amount-first + editable-OCR-prefill + offline-first + review inbox.
