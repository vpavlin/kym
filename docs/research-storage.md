# Research — Logos Storage (Codex) as durable encrypted backup for KYM (2026)

From a source-verified pass on the current state of **Logos Storage** (the network
formerly called **Codex**) and how it fits KYM's two concrete storage needs. KYM is
local-first and self-custody: the event log is already append-only and encryptable under
the household key, so any external store only ever sees ciphertext. The question is
whether Codex can be KYM's **durable off-device backup** — the thing that saves a
household when every one of its own devices dies — and whether that can become the first
paid service (`strategy.md` — "encrypted Codex backup we can't read").

## Bottom line

Codex is the **right long-term home** for KYM's backup, and the design fit is clean —
but in 2026 it is **not yet a network you can lean on for a durability promise.** The
public incentivized testnet was **paused in Aug 2025**, the project **rebranded to Logos
Storage**, and it re-emerged inside the unified **Logos Testnet v0.1** (v0.1.2 by
Apr 2026) as an **explicitly experimental, early-stage** environment — no mainnet, no
live marketplace, no incentives, and **no built-in encryption** (encryption is a
*mainnet-launch* feature, still unshipped). So today "Codex backup" means **we run the
node(s)** and the network's ZK-proof / erasure-coding durability guarantees are mostly
designed, not yet operating at production strength. The honest 2026 path is: **ship
local encrypted export/import now**, add a **self-hosted Codex-node backup** as an
opt-in, and reserve the **hosted "backup we can't read" paid tier** for when Codex
reaches incentivized-testnet/mainnet maturity.

---

## 1. What KYM would use it for

1. **Durable encrypted backup of the append-only event log (primary).** Today the
   desktop module is the household's only durable copy — a household-hub SQLite/JSON log
   (`sync.md` §5). If all devices die, the budget is gone. Codex would hold an off-site
   copy of the **already-encrypted** log so a household can restore from zero devices.
2. **Large-file offload (secondary).** Receipt images exceed Waku's **150 KB
   per-message cap** (`sync.md` §2, `research-notes.md`), so they can't ride the sync
   topic. Encrypt the image, upload to Codex, and carry only the small **CID** in an
   event on the Waku topic — the same "Waku moves the pointer, Codex holds the bytes"
   split the Codex team itself demonstrates (see §3).

Both keep KYM's privacy invariant intact: **Codex only ever sees ciphertext**, because
the log and receipts are sealed under the household key before they leave the device.

---

## 2. Current state of Logos Storage / Codex (2026, cited)

**Rebrand.** Codex is being renamed to **Logos Storage** across repos, docker images and
docs; the X handle is now "Logos Storage (prev. Codex)" and the rename is tracked in
`logos-storage-nim#1396`. Expect both names in the wild through 2026.
[[github.com/logos-storage/logos-storage-nim#1396]], [[x.com/Codex_storage]]

**Network status — the decisive caveat.** In **August 2025** the team **paused the
Codex testnet** to "shift focus to core design and specifications… stronger foundations
and revisiting core architecture." It has since re-launched inside the **unified Logos
Testnet v0.1** (Storage + Messaging + Blockchain together), reaching **v0.1.2** with a
"Testnet v0.1 retrospective" by **20 Apr 2026** — described as "an early, experimental
development environment for early-stage testing." As of the Apr 2026 Logos weekly
report there is **no mainnet, no marketplace, and no incentives** live; work is on core
infrastructure (block-download throughput, NAT traversal/Autonat, Nim 2.2.8, Mix hidden
services). [[linkedin.com/…codex-testnet-paused]], [[blog.codex.storage/codex-august-updates-2]],
[[roadmap.logos.co/reports/weekly/2026-04-20]], [[logos.co/testnet-v01-faqs]]

**Durability model (designed).** Codex's pitch is *tunable* durability from **erasure
coding** (original + parity blocks dispersed across distinct nodes, never co-located) +
**zero-knowledge storage proofs** (proof of data possession / retrievability, so a
provider must keep proving it still holds the data) + **lazy repair** + a **permissionless
storage marketplace** (clients post requests, providers bid, contracts priced by a free
market). A CTMC reliability model backs the durability analysis. This is what
distinguishes it from bare IPFS — but note these are the **design guarantees**; the
incentivized network that would *enforce* them is not yet live.
[[docs.codex.storage/learn/whitepaper]], [[blog.codex.storage/protocol-breakdown-how-the-codex-p2p-network-works]],
[[blog.codex.storage/the-codex-roadmap-for-2025-and-beyond]]

**Encryption — Codex does NOT encrypt for you.** The networks are "transparent and open
by default… access control needs to be implemented separately." Client-side
**encryption capabilities are a listed *mainnet-launch* feature**, not shipped in the
current testnet. **KYM must encrypt before upload** — which we already do (household
key), so this is a fit, not a gap. [[blog.codex.storage/building-a-censorship-resistant-file-sharing-app-with-codex-and-waku]],
[[blog.codex.storage/the-codex-roadmap-for-2025-and-beyond]]

**How you use it today: run your own node.** A user runs a Codex node locally; it dials
a **bootstrap node** to join the network. Nodes can also be deployed on Akash rather than
a local box. With no public incentivized network, **self-hosting is the only reliable
option in 2026** — the same conclusion Perun reached ("run your own delivery + storage
node/gateway", `perun/docs/research-notes.md`). [[docs.codex.storage/…local-two-client-test]],
[[blog.codex.storage/deploying-a-codex-node-on-akash-network]]

**REST / module API surface (what we'd actually call).**
- Raw Codex REST: **`POST /v1/data`** streams a file in and returns a **CID**;
  **`GET /v1/data/{cid}/network`** (fetch to local) and **`GET
  /v1/data/{cid}/network/stream`** (download content); manifest endpoints pull just the
  dataset manifest. The manifest is itself a CID-addressed block in the node's Repo
  Store. [[api.codex.storage]], [[github.com/logos-storage/logos-storage-nim/blob/master/openapi.yaml]]
- Inside the Logos/Basecamp stack this is wrapped by **`storage_module` v2.0.1** (Jul
  2025) over **`logos-storage-nim` v0.4.1 (pre-alpha)**, REST base path **`/api/storage/v1/data`**
  (was `/api/codex/v1/data`). Module methods: lifecycle `init/start/stop/destroy`;
  upload `uploadUrl` / `uploadInit/Chunk/Finalize`; download `downloadToUrl` /
  `downloadChunks` (base64) / `downloadManifest`; `exists/fetch/remove/space/manifests/importFiles`;
  `togglePrivateQueries(bool)` (Mix). Declared as a `metadata.json` dependency
  (`["storage_module"]`) alongside `delivery_module`; flake input
  `github:logos-co/logos-storage-module`. (`perun/docs/research-notes.md`,
  `perun/docs/plan.md`, `logos-tutorial/logos-developer-guide.md`)
- **No mobile client.** Storage has no phone binding — consistent with KYM's design
  where the **phone never touches Storage** and only the desktop module does (§4).

**SDKs for a non-module path:** `logos-storage-js` (JS SDK) and `logos-storage-py-api-client`
exist if KYM ever wants to talk to a Codex node directly from the TS reference rather than
through the C++ module. [[github.com/logos-storage/logos-storage-js]]

---

## 3. Integration approach for KYM

The shape mirrors the Codex team's own **Codex + Waku** reference app (CypherShare):
**Waku carries the small pointer, Codex holds the big bytes.** KYM already runs the Waku
half (household topic, sealed events); Codex slots under the desktop module, **off the
sync hot path.**

**Where it runs.** The **desktop module owns Codex, exclusively** — it is already the
household's durable hub (`sync.md` §5) and the always-on peer. The phone stays thin: no
CID client, no node, it only captures and pushes (same split Perun locked in). Backup is
a **module-side, best-effort extra**, never on the live per-event path.

**Backup flow (event log).**
1. Module folds/serializes the current append-only log (or a compacted snapshot).
2. **Seal it under the household key** — reuse `seal()` / `Ke` from `crypto.mjs` /
   `kym_crypto.hpp` (`sync.md` §1). Ciphertext only leaves the device.
3. `storage_module.uploadUrl` the ciphertext → receive a **CID / manifest**.
4. **Persist the CID as a restore pointer** — as a first-class event in the log (so it
   syncs to every device via Waku and is itself covered by the next backup) and/or in
   module settings. The manifest CID is the single thing needed to restore.
5. Re-run on a schedule / on meaningful log growth. Because the log is append-only,
   backups are monotone; keep the last N CIDs so a corrupt/incomplete upload never
   orphans the only copy.

**Restore flow.** New/wiped household device → obtain the restore CID (from a surviving
peer's synced pointer, or manually pasted during pairing) → `storage_module.downloadManifest`
+ `downloadChunks` → **open under the household key** → you now hold the full sealed log →
feed it straight into `SyncNode` as seed. This composes **cleanly with the existing
SYNC_REQ / `backfill()` path** (`sync.md` §5): Codex restore and hub re-serve produce the
**same thing** — a set of sealed events unioned by `id`. Merge is commutative +
idempotent, so it does not matter whether an event arrives from Codex or from a peer's
backfill; duplicates dedup, nothing is lost. Codex is simply a **cold, deviceless source
of backfill** for the case where *no* peer survives.

**Receipt offload (secondary).** Same seal → `uploadUrl` → CID, but the CID rides inside
a normal transaction/attachment event on the Waku topic (tiny, well under 150 KB). Any
device folds the log, sees the CID, and lazily fetches+decrypts the image from Codex when
the user opens the receipt.

---

## 4. Durability / availability caveats (be honest)

- **The network can't back a durability promise in 2026.** No incentivized network, no
  marketplace contracts, no live storage proofs enforcing retention → a public Codex
  node holds your ciphertext only as long as it and its peers stay up. That is **not** a
  backup guarantee. [[roadmap.logos.co/…2026-04-20]], [[blog.codex.storage/…roadmap]]
- **So we must run the node.** A "Codex backup" today = **KYM (or the user) operates a
  Codex node/gateway** the module uploads to. That collapses much of the decentralization
  benefit: it's really *our server holding ciphertext*, dressed in Codex's API — honest
  framing matters (`strategy.md`: "we ran a server / covered a real cost").
- **Testnet data is disposable.** v0.1 is "early, experimental" — treat anything on the
  public testnet as ephemeral; never make it the *only* copy. The hub's local SQLite log
  and local export (§5) remain the source of truth.
- **Pre-alpha API churn.** `logos-storage-nim` v0.4.1 is **pre-alpha** and the REST base
  path already moved once (`/api/codex/v1` → `/api/storage/v1`); the rebrand will move
  more. Wrap it thinly and expect breakage.
- **No mobile path** — restore that needs the phone alone won't work; restore is a
  desktop-module operation. Acceptable given KYM's phone-stays-thin design.

---

## 5. Monetization fit — the "encrypted backup we can't read" tier

The pitch in `strategy.md` is exactly right in spirit: **sell infrastructure we run, not
access to your own data.** Backup is the cleanest such product — we genuinely run a
server and pay for storage, and because the log is sealed under the household key
**before** upload, we *cannot* read it (we hold no household key). That is the honest,
ethos-aligned paid line.

**What we'd actually run/charge for (today):** a **KYM-operated Codex node/gateway** (or
plain object storage behind the same CID-shaped API) that stores households' **ciphertext
blobs**, plus the scheduling/restore UX in the module. Charge for the running cost +
availability, not for the data.

**Honest limits in 2026:**
- It's "decentralized storage" in API only until Codex mainnet — really *our* node. Say
  so; don't over-claim erasure-coded, proof-backed durability we aren't yet getting.
- "We can't read it" is **true today** (client-side seal) and independent of Codex
  maturity — that claim holds now and is the real selling point.
- Redundancy is on **us** to provide (replicate the node's repo) until the marketplace
  makes durability the network's job. Price accordingly.

This is a strong **grant story** too (`strategy.md`): KYM as the flagship local-first
consumer app exercising **Waku + Codex** end-to-end is exactly what Logos/IFT/Status fund
and showcase.

---

## 6. Phased recommendation (2026-viable vs aspirational)

1. **Local encrypted export/import — ship now, no Codex.** The module already holds the
   full sealed log; add "Export encrypted backup" (write the sealed blob to a file / the
   user's own cloud) and "Import" (feed into `SyncNode` seed). **Zero new dependencies,
   works today, closes the "all devices die" hole immediately**, and is the honest
   baseline every household should have regardless of Codex. This is the real 2026
   deliverable.
2. **Self-hosted Codex-node backup — opt-in, best-effort.** Wire the desktop module to
   `storage_module` against a Codex node **we or the user runs** (crib/Pi5/Akash).
   Same seal → upload → CID-in-log → restore flow (§3). Framed exactly as Perun frames
   it: *optional, best-effort, off the hot path.* Good for the demo and the grant; **not**
   yet sold as a guaranteed backup.
3. **Hosted "backup we can't read" paid tier — when Codex matures.** Once Codex reaches
   incentivized testnet / mainnet with live marketplace, storage proofs and erasure-coded
   durability, promote (2) into the paid service in `strategy.md`: KYM-run infrastructure,
   client-side-sealed, priced on cost. Until then, offering it as a *durability guarantee*
   would be dishonest — the guarantee isn't there yet.

**Net:** do (1) now (it's the actual fix for the durability gap), prototype (2) for the
Waku+Codex grant demo with honest "best-effort" framing, and treat (3) as the roadmap
target gated on Codex mainnet — not a 2026 promise.

---

## 7. Alternatives (brief, for comparison)

- **IPFS** — content addressing only; **no persistence guarantee** (unpinned data is
  GC'd). Would need a pinning service = a custodial server. No durability story on its
  own. Codex is explicitly the "add durability to content-addressed storage" answer.
- **Filecoin** — real incentivized storage deals, live and mature, but heavy, deal-based,
  and Codex positions itself against it on *cheaper, proof-backed durability with lazy
  repair* for many small clients. Usable today, but off-stack (not Logos) and overkill for
  small sealed budget logs. [[blog.codex.storage/codex-storage-vs-filecoin-…]]
- **Arweave** — **pay-once permanent** storage via an endowment model; genuinely durable
  today and dead-simple ("upload, keep the tx id"). The pragmatic *works-in-2026*
  decentralized option if we wanted real durability off-stack now — at the cost of
  permanence (can't delete) and being outside Logos. Worth keeping as a fallback if the
  paid tier is needed before Codex matures.

**Recommendation:** stay on **Codex/Logos Storage** for strategic + grant alignment and
because the seal-then-store fit is clean, but **do not depend on it for durability in
2026** — the durable copy is local export (phase 1) plus, if we need off-stack durability
sooner than Codex delivers, **Arweave** as a pragmatic bridge.

---

## Sources

Codex/Logos Storage docs & blog: whitepaper [[docs.codex.storage/learn/whitepaper]] ·
P2P protocol breakdown [[blog.codex.storage/protocol-breakdown-how-the-codex-p2p-network-works]] ·
2025+ roadmap (mainnet features incl. encryption/marketplace) [[blog.codex.storage/the-codex-roadmap-for-2025-and-beyond]] ·
Codex+Waku file-sharing (CypherShare; transparent-by-default, encrypt separately) [[blog.codex.storage/building-a-censorship-resistant-file-sharing-app-with-codex-and-waku]] ·
Codex vs Filecoin durability [[blog.codex.storage/codex-storage-vs-filecoin-enhancing-durability-for-decentralised-storage]] ·
Akash node deploy [[blog.codex.storage/deploying-a-codex-node-on-akash-network]] ·
August 2025 update [[blog.codex.storage/codex-august-updates-2]].
Testnet pause [[linkedin.com/posts/codexstorage_weve-paused-the-current-codex-testnet]].
Rebrand [[github.com/logos-storage/logos-storage-nim/issues/1396]], [[x.com/Codex_storage]].
Logos unified testnet v0.1 [[logos.co/testnet-v01-faqs]]; weekly status Apr 2026 [[roadmap.logos.co/reports/weekly/2026-04-20]].
REST/API: [[api.codex.storage]], [[github.com/logos-storage/logos-storage-nim/blob/master/openapi.yaml]],
two-client test [[docs.codex.storage/learn/local-two-client-test]]; SDKs [[github.com/logos-storage/logos-storage-js]], [[github.com/logos-storage/logos-storage-py-api-client]].
Internal: `perun/docs/plan.md`, `perun/docs/research-notes.md` (storage_module v2.0.1, `/api/storage/v1/data`, testnet-paused/run-your-own-node), `perun-refs/logos-tutorial/logos-developer-guide.md` (storage_module dependency), KYM `docs/sync.md` §1/§5 (seal, hub backfill), `docs/strategy.md`, `docs/research-defi.md`.
(Verify all figures and network-status claims before acting — Codex is pre-alpha and moving fast.)
