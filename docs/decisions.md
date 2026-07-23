# KYM decision records

Lightweight ADR log — the load-bearing decisions and *why*, so they aren't buried in commits/issues. Newest last. Each: **what**, **why**, **status**.

## 1. Two-layer state: append-only ledger + commutative plan deltas (not LWW)
A household has ≥2 concurrent writers; last-write-wins silently loses money (Perun's documented failure). Recorded money = immutable append-only events (edit = superseding event, delete = tombstone); plan (assign/move) = commutative net-zero deltas; all balances = derived projections. Merge = conflict-free union. **Status: shipped, proven (200-trial convergence).** See `data-model.md`.

## 2. Money is integer milliunits, never float
Currency × 1000, outflow negative. No floating point in storage/transport/arithmetic. **Status: shipped.**

## 3. Invariants are surfaced, not enforced at merge
"Ready to Assign = 0" / "category ≥ 0" are global properties that can't be enforced from local state (two offline partners can each assign the last €100). Recompute post-merge, show as warnings — as YNAB does. **Status: shipped (invariant oracle).**

## 4. HLC + UUID for deterministic, idempotent merge
Every event carries a Hybrid Logical Clock (wall+ctr+deviceId) and a UUID. Ordering + tie-break are identical on every replica; dedup by UUID. **Status: shipped.** (Fixed a bug: the module's HLC device id was hardcoded → per-instance id now.)

## 5. Engine = TS reference, C++ mirror; guarded by parity + golden vectors
The fold is defined once (TS), re-implemented in C++ for the module. Kept in lockstep by golden-vector fixtures + a C++↔TS parity test — logic, not just a codec. **Status: shipped (24/24 parity).**

## 6. Wire = JSON + cross-language parity tests, NOT protobuf
Events are ~200 B (Waku cap 150 KB), so binary compactness buys nothing; and parity tests validate *semantics* (crypto + fold), not just struct shape. **Status: decided.** See `sync.md`.

## 7. Household crypto = shared PSK + ChaCha20-Poly1305; MLS later for groups
One 32-byte household key (QR + pgp-words pairing), HMAC-derived topic, AEAD with AAD=topic. Flat group, no revocation — fine for a household. Real groups (add/remove/revoke) need **MLS** (#12). **Status: PSK shipped; MLS planned.**

## 8. Currency: one budget currency + off-budget tracking FX accounts, no in-budget conversion
Budget in one currency (default CZK); foreign accounts (EUR) are off-budget tracking shown in their own currency; no exchange rate in the budget math. **Status: shipped.** See `kym-currency` decision + `data-model.md` §6.

## 9. Uncategorized asset activity flows to/from Ready to Assign
Imported/uncategorized spend from an on-budget asset account adjusts RTA (so the invariant holds and it shows as pending until categorized) — as YNAB does. **Status: shipped (TS + C++).**

## 10. Categorization is model-free first (learned from history), models second
`suggestCategory` ranks the user's own categories by how they categorized a payee before. Deterministic, private, improves with use. A small LLM/VLM only earns its keep on unknown merchants / line-item splits. **Status: learned categorizer shipped (CLI + MCP + mobile); model layers researched (`research-ocr-models.md`).**

## 11. Stack matches Perun
Basecamp module = C++/Qt + QML `ui_qml` (Nix `logos-module-builder` → `.lgx`); mobile = React Native/Expo, Android-first, `liblogosdelivery` via JNI; transport = Logos Delivery (Waku), `logos.dev` fleet. **Status: chosen and built to compiling artifacts; the Delivery transport binding is coded but not yet run on the real fleet/host (see `sync.md` status table).**

## 12. Durability: the desktop module is the household's durable hub
It holds the full event log and auto-re-serves (backfill on SYNC_REQ) to reinstalled phones — the *design* fix for Perun's "phone is the only durable copy" gap. **Status: implemented in the module, but the re-serve path has not been exercised over real Delivery, and it is still a single un-backed-up local copy — off-site backup (encrypted export / Codex) is unbuilt.**

## 13. AI assistant: LLM for language, engine for truth (MCP)
Tools return engine-computed values; the model routes/phrases and can't hallucinate numbers. Private with a local model. **Status: read-only MCP server shipped (#11).**

## 14. Business model: no open-core; non-custodial DeFi yield + voluntary licence
Fully open-source, nothing gated. Revenue = routing idle envelope money into Aave/vaults non-custodially for a fee cut, + a voluntary one-time licence; near-term Logos/IFT grant. **Status: decided; DeFi specifics under research (#10).** See `strategy.md`.

## 15. "Thin phone, value in Basecamp" — ASPIRATIONAL, not yet true
Intent: the desktop module is the full budgeting surface; the phone is fast capture. **Reality today: the module is a read-only viewer; the CLI is the full surface and mobile is the richer editor.** Closing this is the top parity gap. **Status: editor built + mock-validated, not yet run on the real host** — the module is coded as an editor (command bar + inline forms + click-to-assign; new SLOTs income/setTarget/reconcile) and renders in the offscreen mock harness, but the SLOTs have not been driven on the real Basecamp host. Remaining: categorize/import/report SLOTs, real-host verification, + a UX polish pass. See `parity.md`.

## 16. Group budgets: roles enforced on merge (not access-controlled at write)
A budget is personal until an opt-in `group.init`, after which each event carries an author (`hlc.dev` = member id) and the fold **admits** it only if that author's role allows it: `member.*` needs an active admin, budget edits need admin/editor, viewers/non-members are dropped. In an append-only p2p log you can't *prevent* a write, so enforcement is a deterministic filter applied identically on every device (order-independent, so convergence holds). Phase 1 trusts the author claim inside the shared household key; **per-member signatures** (anti-forgery) and **MLS re-key on removal** (so a removed member can't read new events) are later phases of #12. Note phase-1 removal is **soft**: a removed member who kept the shared key can still decrypt — hard revocation needs MLS (unbuilt; the decentralized-DS variant "de-MLS" is a Vac PoC/testnet coordinated by a smart contract, not adoptable as-is). **Status: phase 1 — engine (TS `admitEvents` + C++ mirror, parity-tested) and CLI shipped and tested (file-sync); desktop SLOTs + UI built but validated only in the mock render harness; live group sync unverified.** See `data-model.md` §10.

## 17. Serious reliability: headless hub + set-reconciliation, not blockchain
The sync foundation is: CRDT replication + a durable **always-on hub** for availability (no Store ⇒ someone must be online to re-serve) + **range-based set reconciliation** (Negentropy/RBSR) so backfill ships only the missing events, not the whole log. The hub can be **headless** — a Logos **core module** under `logoscore` (no Basecamp GUI), reusing the C++ backend; a self-hosted nwaku node can't be a rendezvous (createNode is preset-only), so the hub is an always-on KYM peer on the public fleet. It's an **availability** role, not a canonical authority — the log stays fully replicated. **Nomos/blockchain is rejected for now** (testnet; mainnet ~2027) and forever for per-event writes (wasteful, leaks cadence, and our CRDT doesn't need global ordering); permanence is Codex's job (when it matures), the only future chain use is optional **Merkle-root anchoring** for tamper-evidence. **Status: reconciliation algorithm built + tested (`packages/sync/src/reconcile.mjs`, 6 tests); headless hub + KYM-SYNC v2 wire/session + snapshots are planned (unverified on real hardware).** See `research-reliability.md`.

## 18. ui + core split: one engine/sync core, thin surfaces
The desktop was a monolithic `ui_qml` module (engine + sync + budget logic embedded in the QML backend), duplicated by a separate headless hub. Unified into **`kym_core`** — a Logos **core module** holding ALL of it (engine, crypto, wire, reconcile, delivery, budget/group/pairing logic), Qt-free. The desktop **`kym`** is now a thin `ui_qml` view whose backend just forwards SLOTs to `kym_core` and mirrors its `budgetChanged` event into the `.rep` PROP. **`kym_core` runs standalone under `logoscore` as the always-on hub AND behind the desktop UI** — one implementation, no drift. Payoff: MCP/AI added to `kym_core` (or its TS parity mirror) lands in every path for free. **Status: both modules build; `module-hub` retired; one header home in `kym_core/src`; all parity tests green.** Builder quirks worked around: header/metadata parsers choke on non-ASCII; the generated dependency-caller only surfaces action-style method names, so read state (`budgetJson`/`status`/`fingerprint`/`pairingCode`) is delivered via the `budgetChanged` event, seeded by `resync()`.

## 19. Pairing lives in kym_core (desktop + hub), wire-compatible with mobile
Pairing = sharing the 32-byte household secret. `kym_core` auto-generates + persists a secret on first run (`pair.key`; this device becomes the host), exposes its **Crockford-base32 pairing code** + pgp-words fingerprint in `budgetJson`, and `pairWithCode(code)` re-keys onto another device's household (accepts a raw code or a `kym://pair?s=...` QR link). The base32 codec is **byte-compatible with the mobile app** (`pairing_parity.cpp` 6/6 vs mobile's `identity.ts`), and the crypto (HKDF/topic/fingerprint) already matched — so a phone's code pairs a Basecamp and vice versa. The desktop QML gained a Pair panel (share code+fingerprint / paste-to-join). **Status: shipped on desktop (builds + panel renders); mobile can display its code but not yet JOIN (scan/paste) — the remaining half.** See parity audit.

## 20. Transaction edit/delete are append-only supersede/tombstone events, not mutations
Editing or deleting a txn does **not** touch the original event. `editTxn` appends a `txn.edit` carrying **only the changed keys** (empty arg = unchanged); `deleteTxn` appends a **sticky `txn.delete` tombstone**. The engine fold already reconstructed each txn as *create + edits + sticky-delete* (`kym_engine.hpp`), so balances re-derive for free and no "correction" event is ever needed. **Sync is unchanged** — both are ordinary log entries riding the same sealed-payload send + RBSR reconcile; idempotent, commutative, converges. Concurrent edits resolve **last-writer-wins by HLC**, and because edits are key-scoped, non-overlapping edits (one fixes the amount, the other the memo) both survive. **`editTxn` is deliberately lenient** — it does NOT gate on the txn existing locally, because in a synced budget a `txn.edit` can legitimately arrive before the `txn.create` it references and must still merge when the create lands (order-independent fold). Delete is terminal (the fold never un-sets `deleted`), so a late edit can't resurrect a deleted txn. API note: `editTxn(txnId, patchJson)` takes the change-set as **one JSON string** (`{"amount","account","category","date"}`), not N positional params — the module glue silently no-ops a method with too many args (a 5-arg version never fired; see `logos-dev-notes.md`). **Status: shipped (kym_core 0.6.3 / kym 0.5.8, LAN repo); editTxn/deleteTxn functionally verified under logoscore, edit sheet + row ✎ affordance render-verified.**

## 21. Shared-budget safety is per-budget membership, NOT per-transaction permission; attribution ≠ enforcement
A shared budget is **one household key** — every paired device is a full, equal writer on one log, so yes, either partner can edit or delete any txn in the shared budget. That is **correct** (it's how YNAB / a joint account / a shared doc works), not a leak. The protection boundary is **which budget a txn lives in**: things you don't want shared go in a **private budget** (a household whose pairing code you simply never share — a hard cryptographic boundary, already built by #decision-multibudget), and the shared budget (c) is fully mutual by design. We explicitly **reject per-transaction ACLs** — they'd need per-member signing keys + signature verification on every fold, pointless for a trusted couple, and would complicate the single-user multi-device path (all your own devices share your key and edit freely). What we add instead is **attribution, not permission**: each event is stamped with an optional author name (env `KYM_AUTHOR` or `<root>/author.txt` via `setAuthorName`, surfaced in `budgetJson` as top-level `authorName` + per-txn `author`), so the TX list can show "· Kristýna" — accountability without enforcement, and free for single-user (empty name = no tag). Author rides inside the event (`e.s["author"]`, stamped in `pushEvent` before persist/send), so it round-trips the wire to peers and survives reload. Real cryptographic per-member write-authorization (anti-forgery) remains a later phase of #16/#12 (per-member signatures + MLS re-key). **Status: shipped (kym_core 0.6.3 / kym 0.5.8); author stamping + wire round-trip + persistence verified under logoscore; TX-row tag + Settings "Your name" field render-verified.**
