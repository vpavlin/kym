# KYM sync design (v1)

How a household's devices stay in agreement over **Logos Delivery (Waku)** with no
server. This doc consolidates what is already built — the crypto, the wire, the
transport-agnostic `SyncNode`, and the merge/convergence guarantee — and points at
the tests that stand in for a formal wire spec. It sits below [`data-model.md`](data-model.md)
(§7–8 define merge & the envelope) and [`plan.md`](plan.md) (decisions §1.7–1.8);
read those for the *why* of the event model.

The one-line shape: **every change is an immutable event; a device seals it under the
household key and publishes it on the household topic; every peer opens it, dedups by
`id`, unions it into its log, and re-folds.** No balance is ever transmitted — only facts.

---

## 1. The household key model

One budget = one **32-byte pre-shared secret `S`**, carried device-to-device out of
band (the pairing QR). Every device in the household holds the same `S`; that shared
secret *is* the household identity. Everything else is derived from it, deterministically,
so all devices — the TS reference, the phone, and the C++ module — compute the same keys
and the same topic. The reference is [`packages/sync/src/crypto.mjs`](../packages/sync/src/crypto.mjs);
the C++ mirror is [`module/src/kym_crypto.hpp`](../module/src/kym_crypto.hpp).

```
K            = HKDF-SHA256(ikm=S, salt="kym-pair-v1", info="",              32)
Ke           = HKDF-SHA256(ikm=K, salt="",           info="kym/payload/v1", 32)
topic(epoch) = HMAC-SHA256(K, "kym/topic/v1|"+epoch)[0..15]        (16 bytes)
contentTopic = "/kym/1/" + hex(topic) + "/proto"
fingerprint  = pgpWords(SHA-256(K)[0..2])
```

- **`K`** — the household root key. Used to derive the content topic and the payload key.
- **`Ke`** — the AEAD content key. Separate from `K` so the wire key is never the same
  bytes as the topic-HMAC key.
- **`topic`** — the content topic is an **HMAC of `K`**, not a fixed string, so the topic
  *value* reveals nothing about the household and is unlinkable across households. (This
  hides the topic contents only; it does not hide transport **metadata** — that a message
  was sent, when, and from which network address — which is future work via Nym.) `epoch`
  (0 in phase 1) is the hook for future topic rotation.
- **`fingerprint`** — the first 3 bytes of `SHA-256(K)` rendered as pgp-words, shown on
  both screens during pairing so the two humans can confirm out loud they derived the same
  `K` (ports Perun's `request_pairing`→`confirm_sync`). A mismatch means a wrong/tampered QR.

**Seal / open** (`seal()` / `open()`): the wire payload is `nonce(12) ‖
ChaCha20-Poly1305(Ke, nonce, plaintext)`, with the tag appended and **`aad = the content
topic string`**. Binding the topic as AAD means a ciphertext can't be replayed onto a
different topic. `open()` throws on tag failure — a wrong household key (or a tampered
message) simply can't be read, which is exactly what the "outsider can't read the traffic"
test asserts. The PSK authenticates both ends, so v1 carries **no per-message signature**
(the `sig?` field is reserved for later per-device authorship).

HKDF is implemented directly over HMAC on the C++ side to match `@noble`'s empty-salt
semantics (an empty salt means an all-zero-length HMAC key) byte-for-byte — this is one of
the things the parity fixture pins.

---

## 2. The wire

The transport moves opaque sealed bytes. Inside the seal is a tiny JSON envelope
([`packages/sync/src/wire.mjs`](../packages/sync/src/wire.mjs), mirrored in
[`module/src/kym_wire.hpp`](../module/src/kym_wire.hpp)):

```
EVENT  → { v:1, type:"EVENT", event:{ v, id, type, dev, hlc:{wall,ctr,dev}, payload:{…} } }
CHUNK  → { id, seq, total, gz:<base64> }     // bulk backfill only
```

- **`encodeEvent(event)` / `decodeEvent(bytes)`** — one event per EVENT message. `decodeEvent`
  rejects any non-EVENT envelope.
- **Events are tiny.** A single event is far under Waku's **150 KB per-message cap**, so
  **live per-event sync never chunks** — one event, one seal, one `send()`.
- **`CHUNK`** is reserved for **bulk backfill** only, where re-serving a long history at once
  could exceed the cap. It reuses Perun's chunk envelope (`{id, seq, total, gz}`, reassembled
  by `id`). Not needed — and not used — on the live path.

Why one event per message and not a batch: it keeps dedup, ordering, and idempotent
re-delivery all keyed on a single `id`, and keeps every live message trivially under the cap.

---

## 3. `SyncNode` — the transport-agnostic core

[`packages/sync/src/node.mjs`](../packages/sync/src/node.mjs) is the whole safety-bearing
core of sync, deliberately **independent of any physical transport**. It owns the event log,
seals locally-authored events, and ingests peers' sealed events. A transport adapter just
moves the bytes it produces and hands back the bytes it receives.

```js
const node = new SyncNode(secret, { device: "A", log: seed });

node.append(event)   // add a locally-authored event to the log; returns its sealed wire bytes to publish
node.ingest(sealed)  // open + decode + dedup + union a peer's message; returns true iff it was new
node.backfill()      // re-seal the entire log (for a peer that just joined / reinstalled)
node.state(opts)     // fold the current log → BudgetState (computeState)
node.invariant(opts) // checkInvariant on the current state
```

Internally it holds `this.log` (HLC-ordered, deduped), a `Set` of seen `id`s for O(1)
idempotency, and a `Clock` primed from every event it has seen so locally-authored events
sort causally after everything it already knows. `append` and `ingest` are both idempotent:
re-appending a known `id`, or re-ingesting an already-seen message, is a no-op — which is
what makes Waku Store re-delivery harmless.

**The transports plug in *under* this core:**

- **Desktop module** — the C++ backend subscribes/publishes via `delivery_module`
  (`subscribe(topic, …)` / `send(topic, payload)`, base64 over the FFI). On an inbound
  message it runs the same open → decode → dedup → append → fold pipeline (the
  `kym_crypto.hpp` + `kym_wire.hpp` + `kym_engine.hpp` mirror of `SyncNode.ingest`).
- **Mobile** — React Native embeds `liblogosdelivery` via JNI (the `receiver-android`
  pattern); the JS side drives the same `SyncNode` API.

Because all the correctness lives in `SyncNode` + `@kym/engine`, the adapters are "just
move bytes" — the part most likely to differ per platform holds none of the money logic.

---

## 4. Merge & convergence

Merge is defined once, in the engine, and is what every peer runs after every ingest:

- **Union by `id`.** `mergeEvents(...logs)` ([`packages/engine/src/engine.mjs`](../packages/engine/src/engine.mjs))
  unions every log into one map keyed on event `id` — so re-delivery is a no-op and nothing is
  ever overwritten. **Commutative + associative + idempotent** ⇒ arrival order is irrelevant.
- **HLC ordering with a deterministic tie-break.** The union is sorted by
  `compareHlc` ([`packages/contract/src/hlc.mjs`](../packages/contract/src/hlc.mjs)):
  `wall`, then `ctr`, then `dev` lexicographically. The `dev` tiebreak makes the total order
  **identical on every replica**, independent of wall-clock skew. Wall time orders events; it
  never touches money.
- **Derived-projection invariant.** State is a pure fold of the ordered log — nothing is
  stored. After every fold, `checkInvariant` asserts
  `Σ on-budget asset balances == Σ category available (incl. CCP) + Ready to Assign`. A
  non-zero difference is, by construction, a bug in the fold.

**The correctness guarantee is carried by tests, not by a schema.** Two of them are the load-bearing proofs:

- [`packages/engine/test/convergence.test.mjs`](../packages/engine/test/convergence.test.mjs)
  — 200 trials of random concurrent offline edit streams from 3 devices, folded in multiple
  shuffled arrival orders (with duplicates), all asserted to converge to identical state **and**
  hold the invariant. This is the "no edit is ever lost on merge, all replicas agree" property.
- [`packages/engine/test/golden.test.mjs`](../packages/engine/test/golden.test.mjs) +
  `fixtures/golden.json` — committed (event log → expected `BudgetState`) vectors that lock the
  fold's exact output, so any accidental change is a failing test and a TS↔C++ drift signal.
- [`packages/sync/test/sync.test.mjs`](../packages/sync/test/sync.test.mjs) — the same §9
  two-device scenario driven **through real encryption** over a mock Delivery bus: two `SyncNode`s
  edit offline, publish, ingest, and converge to the data-model §9 result; plus idempotent
  re-delivery and the wrong-key-can't-read cases.

### Why JSON + parity tests instead of protobuf

KYM's wire is JSON, and the "spec" the two implementations agree on is a set of
**cross-language parity fixtures**, not an IDL:

- [`module/test/crypto_parity.cpp`](../module/test/crypto_parity.cpp) reads a TS-generated
  fixture and asserts the C++ crypto reproduces `K`/`Ke`/`topic`, **opens** a TS-sealed
  message back to the original plaintext, and **re-seals** it to byte-identical ciphertext.
- [`module/test/sync_ingest.cpp`](../module/test/sync_ingest.cpp) reads a stream of TS-sealed
  EVENT messages (the §9 scenario) + expected numbers, and asserts the C++ open → decode → fold
  path reproduces the TS budget exactly.

This is a deliberate trade. A binary IDL would buy compactness and a shape contract — but
**size is a non-issue here** (events are tiny, live sync never approaches the 150 KB cap), and a
shape contract validates *structure*, not *meaning*. What can actually break KYM is **semantic
drift**: the C++ HKDF using different empty-salt semantics, the fold rounding differently, the
HLC tiebreak ordering two events the other way. Byte-level parity fixtures catch exactly those —
they assert the two implementations produce the *same keys, same ciphertext, and same folded
balances*, which a protobuf schema never could. JSON also keeps the envelope readable and the
port trivial. If a size problem ever appears (bulk backfill), the CHUNK path already gzips.

---

## 5. Backfill & durability

`liblogosdelivery` exposes **no Store/history query** in its FFI: a fresh subscriber sees only
messages published *while it is subscribed*. So a phone that reinstalls, or a newly-paired device,
would otherwise start from nothing.

The **desktop module is the household's durable hub.** It holds the full event log in SQLite and
is the natural always-available peer. `SyncNode.backfill()` re-seals the entire log so the hub can
**republish-on-demand** to a peer that has a gap — the reinstalled phone catches up purely from the
hub's re-served events. Because the log is append-only and merge is idempotent, re-serving is
trivially safe: the peer simply unions in whatever it was missing and dedups the rest.

- v1: naive "re-send the log" (`backfill()` returns every sealed event).
- **v2 (algorithm built): range-based set reconciliation** (`packages/sync/src/reconcile.mjs`) — peers exchange small fingerprints over sorted ranges of their event-id set and transfer only the missing events (~d/n of resend-all bandwidth in the common case). The pure algorithm is implemented + tested; the wire/session layer that carries it over Delivery is planned. See `research-reliability.md` and ADR #17.

This is the fix for Perun's "the phone is the only durable copy of a run" gap. An optional
Logos **Storage/Codex** encrypted backup of the log is a later, module-side, off-hot-path extra.

### Reliability assumptions (be explicit — these are the load-bearing conditions)
1. **At least one durable, usually-online holder per budget** (the hub) — no Store means catch-up needs a peer that has the events; two devices *never* online together can't sync. The hub can be **headless** (a Logos core module under `logoscore`, no Basecamp GUI — ADR #17), and is an **availability** role, not a canonical authority (the log stays fully replicated; no copy is "more correct").
2. **No delivery guarantee from the network.** An event published while everyone else is offline lives only on the sender until it re-serves; if the sender then loses its data first, that event is gone. (The hub's durability mitigates this; phones are less durable.)
3. **New device = empty** until it backfills from a reachable holder (a signed **snapshot** to avoid replaying all history is planned).
4. **A self-hosted Waku/nwaku node cannot be a rendezvous** — `createNode` takes only a named preset, no custom bootstrap — so the hub is a KYM peer on the public fleet/topic, not private infrastructure.
5. **None of the live transport/hub path is verified on real hardware yet.** The convergence *math* and the reconciliation *algorithm* are proven in tests; their *delivery* is not.

---

## 6. Status

| Piece | State |
|---|---|
| **Sync core** (`SyncNode`: append / ingest / backfill, seal/open, wire) | **Done** — `packages/sync/`, `sync.test.mjs` green |
| **Household crypto** (HKDF K/Ke, HMAC topic, ChaCha20-Poly1305, pgp-words fp) | **Done** — TS reference + C++ mirror |
| **Merge & convergence** (union-by-id, HLC order, invariant) | **Done** — 200-trial property test + golden vectors |
| **Crypto parity (TS ↔ C++)** | **Done — 5/5 checks** (`module/test/crypto_parity.cpp`) |
| **Sync ingest parity (TS ↔ C++)** | **Done — 7/7 checks** (`module/test/sync_ingest.cpp`) |
| **`delivery_module` transport (desktop)** | **Pending** — wire the C++ ingest path onto `delivery_module` subscribe/send |
| **`liblogosdelivery` JNI (mobile)** | **Pending** — embed on Android, drive `SyncNode` from RN (bidirectional) |
| **Set-reconciliation backfill (algorithm, TS)** | **Done** — `packages/sync/src/reconcile.mjs`, `reconcile.test.mjs` (6 tests, incl. 200-trial property) |
| **Set-reconciliation (C++ mirror)** | **Done** — `module/src/kym_reconcile_std.hpp`, `reconcile_parity.cpp` (8/8): **byte-identical fingerprints + same diff as TS** (cross-language interop). Wired into the hub (`logFingerprint`). |
| **Qt-free wire codec** (headless hub / core reconciler) | **Done** — `module/src/kym_wire_std.hpp`, `wire_std_parity.cpp` (34/34) decodes TS JSON + round-trips |
| **Headless hub ingest path** (open→decode→dedup→fold) | **Done** — `module-hub/` builds headless; `hub_ingest.cpp` (10/10) |
| **Two-instance convergence** (hub crypto+wire+reconcile+fold) | **Done — over a *simulated* transport** — `hub_sync.cpp` (16/16): two peers with divergent offline edits reconcile, exchange only the diff, converge to identical state + invariant + fixpoint. The Waku hop is stubbed by a byte pipe (real `delivery_module` unverified). |
| **Headless hub Delivery transport** | **Code-complete, builds** — `module-hub` `onContextReady` → `onMessageReceived`/`createNode`/`subscribe`/`send` (std `LogosMap`/base64), EVENT + SYNC_REQ dispatch, naive re-serve backfill. Not yet run over a live `delivery_module`. |
| **Delivery payload = base64/JSON** (hub↔desktop interop) | **Aligned + built** — core module gets the std delivery API (JSON payload); the Qt desktop backend now base64s too (`kym_wire_std.hpp::b64encode`), so both surfaces are wire-compatible by construction. Unverified on the wire. |
| **KYM-SYNC v2 RBSR session over Delivery** | **Pending** — multi-round NEG_OPEN/NEG_MSG state machine on top of the working transport (naive re-serve works today) |
| **Signed snapshot bootstrap** | **Pending** — cold-start devices load folded state + reconcile only the tail |
| **Headless hub (core module under `logoscore`)** | **Loads headless — verified locally** — `module-hub/` runs under `logoscore` with `delivery_module` dependency-injected (`run-logoscore.sh`, 2026-07-18). Transport callback + `delivery_module` runtime bring-up still pending. |
| **Topic rotation (epoch > 0)** | **Pending** — derivation supports it; not yet exercised |

The transport-agnostic core and the cross-language wire/crypto/fold are proven; what remains is
binding that core to the two real Delivery transports (the C++ `delivery_module` adapter and the
mobile JNI bridge — plan.md Phases 1 and 3).
