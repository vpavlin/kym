# Changelog

Notable changes to KYM. Components version independently; this log groups them by milestone.
See [`docs/decisions.md`](docs/decisions.md) for the *why*.

## v0.8.0 — Mobile sync + brand (2026-08-04)

**Mobile ↔ household sync over SDS Reliable Channels now works end-to-end on real hardware** —
this is the headline. Both directions verified on a Pixel: the phone decodes the household's
edits *and* a phone-created category lands on the desktop hub.

Components: `kym_core` 0.7.4 · `kym` module 0.6.8 · mobile 0.14.14 (vc40).

### Added
- **Mobile Reliable Channels transport** (`mobile/src/lib/delivery.ts`): channels-only join
  (`subscribeContentTopic` + `channelCreate`) and channel send/receive over a channels-enabled
  arm64 `liblogosdelivery` built from source.
- **Kotlin channel bridge** (`channelCreate`/`channelSend`/`channelClose` `@ReactMethod`s) in the
  source template so `expo prebuild` no longer drops it.
- **KYM brand**: the "KYM coin" logo (white KYM on an anthracite metallic coin) baked into the
  mobile app (icon / adaptive icon / splash) and the Basecamp module tile. Masters in `brand/`.
- Configurable device name and a live sync indicator (checking / syncing-N / up-to-date).
- `joinBudget` on desktop: join a shared household as a *new* budget without re-keying the current.

### Fixed
- **Double-base64 payload mismatch** — the desktop channel path double-encodes; the phone
  decoded one layer short, so nothing decrypted (`chan:6, ours:0`) and phone sends were
  unreadable. Receive now tries the double-decoded candidate; send double-encodes to match.
  (decision #23)
- **Android OnlineMonitor DNS deadlock** — the node stayed offline forever because nim's
  DnsResolver fails in the Android sandbox; patched `online_monitor.nim` to assume-online.
- **`channelCreate` didn't subscribe** the content topic → `recv_service` dropped every inbound
  message before the channel saw it.
- **F-Droid publish targeted the wrong repo** (`~/kym-fdroid`, no metadata → empty index);
  `scripts/fdroid-publish.sh` now targets `~/fdroid`, the repo the phone actually reads.

### Changed
- Sync transport is **SDS Reliable Channels**, not raw relay subscribe/send (desktop + hub +
  mobile). KYM keeps its own ChaCha20-Poly1305 sealing; the channel runs the no-op encryption
  provider. (decision #22)
- Docs refreshed: `docs/sync.md` (real transport + status), `docs/architecture.md`,
  `docs/decisions.md` (ADRs #22, #23).

### Known follow-ups
- Mobile re-offers only *new* edits, not old unsent ones (RBSR summary / SYNC_REQ re-serve on
  mobile is TODO) — an edit made on a pre-fix build stays local until re-created.
- A diagnostic harness (`chan/msg/err` breakdown in the mobile Sync card) is left in
  `delivery.ts`; trim once the transport is battle-tested.

## Earlier

- **SDS Reliable Channels on desktop + hub** (`KYM_USE_CHANNELS`), dual MIT/Apache-2.0 license,
  headless hub runner, transaction edit/delete + author attribution, multi-budget, RBSR
  set-reconciliation, the C++↔TS parity-tested engine/crypto/wire core. See git history and
  `docs/decisions.md` #1–#21.
