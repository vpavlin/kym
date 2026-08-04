# KYM architecture

KYM is a local-first, p2p, zero-based envelope budget on the Logos stack. Two apps, one shared budget, no server. This doc covers the component layout and the data flow; the *why* of the state model is in [`data-model.md`](data-model.md), the roadmap in [`plan.md`](plan.md).

## Components

```
┌──────────────────────────────┐         Logos Delivery (Waku)          ┌──────────────────────────────────┐
│ KYM MOBILE (RN / Expo)       │   /kym/1/<household>/proto (E2E enc)   │ KYM BASECAMP MODULE (ui_qml)     │
│ Android-first                │◄─────────────────────────────────────►│ desktop, C++/Qt + QML            │
│                              │                                        │                                  │
│  quick-add (amount-first)    │        SDS Reliable Channels           │  delivery_module · SDS channels  │
│  on-device OCR (ML Kit)      │                                        │  SQLite: append-only event log   │
│  local event log (SQLite)    │                                        │  engine fold (C++) → BudgetState │
│  engine fold (TS) → balances │                                        │  QML: grid / register / reports  │
│  liblogosdelivery via JNI    │                                        │  backfill re-serve · [opt] backup│
└──────────────────────────────┘                                        └──────────────────────────────────┘
        shares  packages/contract (event schema, milliunits, HLC)  and  packages/engine (the fold)
        TS is the reference; C++ re-implements the identical fold (golden-vector + invariant parity)
```

- **`packages/contract/`** — dependency-free TS: event types, `Money` (milliunits), HLC create/compare, envelope + topic derivation. Re-implementable in C++/Kotlin. Frozen first.
- **`packages/engine/`** — the pure fold `applyLog(events) → BudgetState` + `checkInvariant(state)` + `merge(a, b)`. No I/O, no platform deps — the same code runs in Node (CLI), in the phone (via RN's JS), and is mirrored in C++ in the module.
- **`cli/`** — headless harness that instantiates two in-memory devices, applies divergent offline edits, merges, and asserts convergence + invariant. This is the Phase-0 prototype and the living proof of the core claim.
- **`module/`** — the Basecamp desktop app (most features). C++ backend (`.rep` + one backend class), QML views, SQLite log, `delivery_module` dependency. Built via `logos-module-builder` → `.lgx`. Structure copied from Perun's `module/`.
- **`mobile/`** — the thin capture app. RN/Expo, `liblogosdelivery` JNI (receiver-android pattern), on-device OCR.

## Data flow (one expense)

1. Phone: user types amount (OCR may prefill amount/merchant/date from a receipt photo — always editable).
2. Phone: build `txn.create` event `{id:uuid, hlc, dev, amount, accountId, categoryId?, date, …}`; append to local SQLite log; **re-fold → balances update instantly, offline.**
3. Phone: encrypt event (household key) → `delivery.send('/kym/1/<household>/proto', payload)`. If offline, it queues; save is never blocked on network.
4. Every other device receives it → base64-decode → decrypt → **dedup by event `id`** → append to its log → re-fold. Converged.
5. No balance is ever transmitted. Only immutable facts move. Any device can be offline for arbitrarily long and still converge on reconnect (union of events).

**Transport:** the send/receive in steps 3–4 runs over **SDS Reliable Channels** (`channelCreate`/`channelSend`/`onChannelMessageReceived`) — the household topic is one channel, KYM's sealed envelope is the payload (no-op channel encryption), SDS handles ordering/retransmit and our RBSR reconcile backstops it. Desktop, headless hub, and the mobile app are all bound to this transport and verified end-to-end on real hardware. See decisions [#22](decisions.md) (why channels) and [#23](decisions.md) (the four fixes mobile needed).

## Why the module is the "hub"

`liblogosdelivery` exposes no history/Store query, so a fresh subscriber sees only messages published while subscribed. The desktop module is the natural always-available holder of the **full event log** (SQLite) and can **re-serve** it to a reinstalled phone or a newly-added device (republish-on-demand). This fixes Perun's "the phone is the only durable copy" gap. Optional Logos **Storage/Codex** encrypted backup of the log is a later, module-side, off-hot-path extra.

## Trust & crypto

One budget = one **household PSK** (32 bytes), shared device-to-device by QR + pgp_words fingerprint (ported from Perun's working pairing). Channel encryption is ChaCha20-Poly1305 with a topic derived from the PSK, so neither the message content nor the topic *value* is exposed (transport metadata — timing/traffic — is a separate, unsolved layer, future work via Nym). Every device in the household is a full read/write peer. Cross-household sharing (splitting a bill with friends) would need group crypto (MLS) and is out of v1 scope.

## Platform targets (match Perun)

- **Basecamp module:** Linux + macOS (the `logos_host` targets). Built with Nix.
- **Mobile:** Android-first on real arm64 hardware (per the Perun lesson: emulators don't exercise the native Delivery path). iOS later, when `liblogosdelivery`'s iOS build matures.

## Testing strategy

- **Engine:** unit tests per YNAB rule (cash/credit overspend, splits, transfers, CC relocation, rollover); **property-based convergence** (random concurrent edit streams must converge and preserve the invariant); **golden vectors** (event log → expected `BudgetState`) shared with the C++ module to prevent TS↔C++ drift.
- **Module:** `logos-qt-mcp` headless UI tests; two-instance `--user-dir` E2E over real Delivery.
- **Mobile:** on real arm64 device for the JNI/Delivery path.
