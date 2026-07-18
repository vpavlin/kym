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
Basecamp module = C++/Qt + QML `ui_qml` (Nix `logos-module-builder` → `.lgx`); mobile = React Native/Expo, Android-first, `liblogosdelivery` via JNI; transport = Logos Delivery (Waku), `logos.dev` fleet. **Status: shipped.**

## 12. Durability: the desktop module is the household's durable hub
It holds the full event log and auto-re-serves (backfill on SYNC_REQ) to reinstalled phones — fixing Perun's "phone is the only durable copy" gap. **Status: shipped (module).**

## 13. AI assistant: LLM for language, engine for truth (MCP)
Tools return engine-computed values; the model routes/phrases and can't hallucinate numbers. Private with a local model. **Status: read-only MCP server shipped (#11).**

## 14. Business model: no open-core; non-custodial DeFi yield + voluntary licence
Fully open-source, nothing gated. Revenue = routing idle envelope money into Aave/vaults non-custodially for a fee cut, + a voluntary one-time licence; near-term Logos/IFT grant. **Status: decided; DeFi specifics under research (#10).** See `strategy.md`.

## 15. "Thin phone, value in Basecamp" — ASPIRATIONAL, not yet true
Intent: the desktop module is the full budgeting surface; the phone is fast capture. **Reality today: the module is a read-only viewer; the CLI is the full surface and mobile is the richer editor.** Closing this (a desktop editor UI + missing SLOTs) is the top parity gap. **Status: open.** See `parity.md`.
