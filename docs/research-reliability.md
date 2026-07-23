# Serious reliability for KYM sync — research & recommendation

**Question (from the maintainer):** with Logos Messaging (Waku/Delivery) not exposing Store, how do we keep devices — and multiple people — reliably up to date without wasting bandwidth? Does the hub need to be a full Basecamp UI app, or can it be headless? Should we use the Logos blockchain (Nomos) to record budgets permanently?

This synthesizes three parallel research threads (headless hub, bandwidth-efficient sync, blockchain anchoring) into one recommendation, and records what has already been implemented.

---

## TL;DR

1. **Headless hub: yes.** The always-on "hub" does **not** need the Basecamp GUI. Convert KYM's backend into a Logos **core (service) module** run under `logoscore` headless on a cheap Linux box. It reuses the existing engine/crypto/wire and the exact `delivery_module` calls; only the packaging changes. Prove it with a throwaway spike first (the one load-bearing assumption is unverified). A self-hosted **nwaku node cannot** be a KYM rendezvous today (createNode takes a fixed preset, no custom bootstrap) — so the hub is just an **always-on KYM peer on the public fleet/topic**.
2. **Efficient sync: yes, and the core is already built.** Replace "resend the whole log" with **range-based set reconciliation** (Negentropy/RBSR — the approach Waku itself chose). Peers exchange tiny fingerprints, recursively split only where they disagree, and transfer **only the missing events**. The pure algorithm is implemented and tested now (`packages/sync/src/reconcile.mjs`); the wire/session layer that carries it over Delivery is the next step (no FFI change needed).
3. **Blockchain (Nomos): no — not now, and never per-event.** Nomos is testnet (mainnet ~2027); writing every event on-chain is wasteful and leaks spend cadence, and our CRDT doesn't need the global ordering a chain sells. **Permanence is Codex's job (also pre-mainnet), availability is the hub's job, ordering we don't need.** The only compelling future use is occasional **Merkle-root anchoring** for tamper-evidence — deferrable to post-mainnet.

The layered answer: **CRDT replication (today) + an always-on headless hub (near-term) + set-reconciliation backfill (core built) + Codex snapshots (when it matures) + optional Nomos anchoring (post-mainnet, optional).**

---

## 1. The constraint that shapes everything

KYM state is an **order-independent fold over a union-by-`id` set of append-only events**. Two devices with the same *set* of event-ids compute identical budgets; merge is commutative/associative/idempotent. This is the *easy* case for reconciliation — and it means **the only sync problem is: "how does a device get the events it's missing?"**

The transport (Waku/Delivery) is **broadcast pub/sub with no history query** (the `liblogosdelivery`/`delivery_module` binding exposes no Store). A device that's offline when an event is published simply misses it. So:

- **Live edits** reach whoever is online.
- **Catch-up** requires a peer that *has* the events to **re-serve** them — there is no server holding them in between.
- Therefore a device needs a **durable, usually-online counterpart** to reconcile against: the **hub**. This is an *availability* role, **not** a canonical/authority role — the log is fully replicated and no copy is "more correct."

## 2. Headless hub (thread 1)

**Finding:** the GUI requirement is specific to the current `ui_qml` module type (it needs Basecamp's MDI host to render its QML tab). Logos has a separate **core module** type that is headless by design, receives dependency modules (`delivery_module`) injected the same way, and runs under **`logoscore`** — the headless CLI runtime — with no GUI. `delivery_module` is itself a core module, so it already runs in exactly that context. KYM's sync path (`kym_backend.cpp`) talks to Delivery only through `modules().delivery_module.*` and creates the node in `mode: "Core"` against the `logos.dev` preset — no QML dependency.

**Recommendation: a `module-hub/` core module** (drop the QML view + `.rep`, keep `kym_backend` + engine/crypto/wire headers), deployed as a systemd **user** service — the durable-service pattern already proven on Perun's LAN box.

**Rejected:** a self-hosted **nwaku** rendezvous. `createNode` accepts only a **named preset** (`logos.dev`/`logos.test`/`twn`), with **no custom bootstrap/ENR** field — KYM clients can't be pointed at a private node. Combined with no Store-query binding, self-hosted Waku infrastructure buys KYM nothing today. The hub must be a KYM peer on the shared fleet/topic.

**Authoring surface (was an open question — now resolved via the pinned builder's templates/skills):** a core module is `type:"core"`, `interface:"universal"`, built with `mkLogosModule`. You write **only an impl class** (`src/*_impl.{h,cpp}`) deriving `LogosModuleContext`; its public methods are the API, `modules()` reaches injected dependencies, `onContextReady()` is the setup hook, events go in a `logos_events:` section, and the code is **Qt-free (std::string)** — the plugin glue is generated. KYM's engine header is already Qt-free, so it drops straight in. This is **built and proven** in `module-hub/` (§6 phase 2).

**Load-bearing unknown — now largely resolved by actually running it (2026-07-18, x86_64 Linux, no GUI).** `logoscore -m … -l capability_module,delivery_module,kym_hub -c "kym_hub.getStatus()"` was run on this machine (`module-hub/run-logoscore.sh`). Observed: logoscore **resolved the capability→delivery→kym_hub dependency order and loaded `kym_hub` headless** in a process-isolated `logos_host`, with `delivery_module` as its resolved dependency, and the hub's API method was **dispatched via `-c`** (round-trip into the isolated process succeeded). So "a core module loads headless with `delivery_module` injected" is **observed, not inferred** — the earlier "needs hardware" hedge was wrong for this part.

**Correct invocation (per the Logos release docs):** a persistent **daemon** plus separate client calls — `logoscore -m ./modules -D &` then `logoscore call <module> <method>` (newer cores) or `logoscore -c "<module>.<method>(args)"` (the 0.2.0 core here). A *one-shot* `-l … -c …` loads and dispatches but doesn't coordinate `capability_module` tokens, so method **returns marshal to `false`** — which is what we saw (the load/inject is real; the return value needs the daemon). `module-hub/run-logoscore.sh` uses the daemon form.

**Version:** the `logos-core`/`logoscore` used is from the **same pinned builder rev as the hub + desktop module** — logos-cpp-sdk **0.2.0**, the SDK behind Basecamp 0.2.0 (manifest `manifestVersion: 0.2.0`). Matching versions avoids cross-module IPC skew; do not mix a newer core with 0.2.0-built modules.

**What is still NOT verified (real, narrower blockers):**
- **Reading a method's return value here** needs the daemon to persist; this ephemeral sandbox tears down the daemon across (and within) tool invocations, so the string return wasn't captured *in this environment* — an environment limit, not a code defect. On the actual always-on host the daemon+call pattern is the deployment anyway.
- **`delivery_module` doesn't come up in a bare sandbox** — first a nix-vs-system **Qt 6.9 clash** (fix: prepend nix Qt dirs, as the run script does), then a further early exit (it links `libpq`/Postgres and expects fleet/config). Bringing the transport up is a *delivery-module* ops task.
- **A real fleet round-trip** still needs `delivery_module` running + a publishing peer.
**Next step:** wire the Delivery bootstrap into `onContextReady` (createNode/subscribe/on → `ingestSealed`), and stand up `delivery_module`'s runtime (nix Qt + its store/fleet config).

## 3. Bandwidth-efficient sync (thread 2)

**Finding:** the right algorithm is **Negentropy / Range-Based Set Reconciliation (RBSR)** — parameter-free, degrades gracefully across the whole difference range, and is exactly what Waku itself chose for Store Sync. KYM's data is already in its shape: every event carries an HLC `{wall, ctr, dev}`, i.e. the `(timestamp, id)` tuple RBSR orders on. (Minisketch/IBLT need a difference-size estimate and a decode cliff; MST/prolly trees solve history-independence we don't need.)

**Protocol (KYM-SYNC v2), star topology against the hub:** peers exchange a **fingerprint over sorted ranges** of their event-id set; where fingerprints disagree, split into sub-ranges and recurse; where a range is small, exchange id lists. Each side ends knowing the **exact set of ids it's missing**, then only those events are transferred as ordinary sealed `EVENT`s. ~2–4 round trips; no tuning.

**Implemented now (`packages/sync/src/reconcile.mjs`, 6 tests):** the pure algorithm — `reconcile(eventsA, eventsB)` returns the exact symmetric difference (`aNeeds`/`bNeeds`) plus control-plane cost, with **zero transport dependency**. Verified: exact diff on identical sets, missing tails, two-sided divergence, and a 200-trial random property test; convergence + invariant after transferring only the diff. Measured bandwidth vs "resend all" (1000-event log, ~150 B/event):

| Missing events | Rounds | Reconcile bytes | vs resend-all |
|---:|---:|---:|---:|
| 0 (synced) | 1 | 32 B | 0.02% |
| 5 | 3 | ~2 KB | 1.4% |
| 50 | 3 | ~10 KB | 6.9% |
| 500 (half) | 3 | ~98 KB | 65.5% |

i.e. **~d/n of the current bandwidth in the common (near-synced) case**, degrading gracefully — never catastrophically — as divergence grows.

**Hub transport wired (code-complete, builds headless).** The hub's `onContextReady` now bootstraps Delivery — `onMessageReceived`/`createNode`/`subscribe`/`send` — dispatches EVENT vs SYNC_REQ, and re-serves the log on backfill. Two boundary questions are **resolved**: (1) a **core module gets the std delivery API** (`nlohmann::json` `LogosMap`, not Qt), so the hub is genuinely Qt-free; (2) the FFI carries the payload as **base64 in JSON**, and since the Qt desktop backend passed *raw* bytes, both surfaces were made to **base64** (`kym_wire_std.hpp::b64encode`) so hub↔desktop are wire-compatible by construction. Both modules build; **not yet run over a live `delivery_module`.**

**Still to build:** the `NEG_OPEN`/`NEG_MSG` RBSR session state machine on top of the working transport (naive re-serve works today), in the C++ backend and mobile bridge; and a **signed snapshot** so a new device loads folded state + reconciles only the tail. **Not** NIP-77 wire-compatible yet. Log truncation/GC is a **separate, riskier** step gated on a per-field merge audit — deferred; snapshot-as-cache + keep-the-full-log is always correct because the fold is order-independent.

## 4. Blockchain / permanence (thread 3)

**Finding:** Nomos (now "Logos Blockchain") is **pre-mainnet testnet** in 2026 (public testnets Mar/Jun 2026; mainnet *expected* early 2027, and roadmaps slip). It provides consensus/ordering + data *availability* (NomosDA) — **not archival storage**. The three things people conflate:

| Need | Solved by | Nomos? |
|---|---|---|
| **Permanence** (bytes survive device loss) | Codex, or replication | No |
| **Availability** (retrievable now) | always-on hub / replica | No |
| **Ordering** (canonical sequence) | a blockchain | Yes — but our CRDT **doesn't need it** |
| **Tamper-evidence** (history wasn't rewritten) | anchor a Merkle root on-chain | **Yes — the one unique fit** |

**Recommendation:**
- **Now:** do **not** build on Nomos. Solve availability/durability with boring infrastructure — the **always-on hub** (§2), and eventually **Codex snapshots** (encrypt → store, once Codex reaches mainnet with real durability guarantees).
- **Never:** every-event-on-chain — wasteful, leaks spend timing/volume publicly, and discards the CRDT's whole point.
- **Later, optional (post-mainnet):** periodic **Merkle-root anchoring** — fold the log daily/weekly, write *just the root hash* on-chain for tamper-evidence / a dispute reference. A trust nicety, not a functional requirement.
- On-chain **group/key coordination** (de-MLS style) is overkill for a 2–5 device household; revisit only for large adversarial groups. Note even Vac's de-MLS keeps key material **off-chain** on Waku.

## 5. Honest caveats

- **Everything Logos here is pre-mainnet** (`logos.dev` is a dev network; the module framework, `logoscore`, Codex, Nomos are all experimental and moving). Treat as subject to breaking change.
- **The headless-injection assumption is unverified** — spike it before converting (§2).
- **Reconciliation needs both peers live at once** (no Store ⇒ it's a real-time conversation). The always-on hub satisfies this; two devices that are *never* online together still can't sync. Live one-way gossip continues meanwhile.
- **Broadcast fanout:** with no unicast, control messages are seen by all members. Fine for a household in star-against-hub; a large all-to-all "Circle" would strain it (would want true unicast, unavailable).
- **Fingerprints are probabilistic (128-bit).** Mitigated by the count field + cryptographic hash, and by KYM's existing `checkInvariant` cross-check after every fold. For money, keep that belt-and-suspenders check.
- **Snapshot trust** rests on a signature + eventual cross-check (you can't cheaply prove `state == fold(covered)` without the events). Bias to snapshot-as-cache; keep the full log; defer GC.
- These are **design decisions and a partial implementation** — none of the transport/hub path has run on real hardware yet. The reconciliation *algorithm* is proven in tests; its *delivery* is not.

## 6. Phased plan

1. **(built)** Set-reconciliation algorithm + tests — TS `reconcile.mjs` (6 tests) **and** a Qt-free C++ mirror `kym_reconcile_std.hpp` (`reconcile_parity.cpp` 8/8: byte-identical fingerprints + same diff as TS, so a TS peer and the C++ hub interoperate). Wired into the hub (`logFingerprint` = the opening RBSR message).
2. **(built + loads headless under logoscore)** Headless core-module hub `module-hub/`: a `type:"core"` universal module builds via `mkLogosModule` to a headless `kym_hub_plugin.so`, reusing the Qt-free engine + a new **Qt-free wire codec** (`kym_wire_std.hpp`, parity-tested vs TS JSON — `wire_std_parity.cpp` 34/34) + Qt-free crypto. Its `ingestSealed` path (open → decode → dedup → fold) is tested framework-free (`hub_ingest.cpp` 10/10, incl. wrong-key rejection). **And it was actually run:** `logoscore` loads it headless with `delivery_module` dependency-injected (see §2). **Still to verify:** the Delivery *transport callback* in `onContextReady` (createNode/subscribe/on → feed `ingestSealed`), `delivery_module`'s own runtime bring-up, and a real fleet round-trip. Also learned: universal-API methods return JSON-serializable types (`std::string`), not `int`.
3. **KYM-SYNC v2 wire+session** over Delivery (envelopes + state machine), replacing broadcast resend-all; C++ + mobile.
4. **Signed snapshot** bootstrap for cold-start devices.
5. **Codex snapshot backup** when Codex matures.
6. **(optional, post-mainnet)** Merkle-root anchoring on Nomos for tamper-evidence.
7. **(later, audited)** log compaction/GC.

See ADR #17 in `docs/decisions.md`. Sources are in the three research-thread transcripts; key references: Negentropy (hoytech), RBSR (Meyer, SRDS 2023), Waku Store-Sync (lip.logos.co), Logos module framework / `logoscore`, Nomos & Codex roadmaps (blog.nomos.tech, blog.codex.storage).
