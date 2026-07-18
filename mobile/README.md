# KYM Mobile — capture app (Phase 2 MVP)

A thin, Android-first Expo (React Native + TypeScript) companion to the KYM
Basecamp desktop module. Its one job: **capture an expense in under 10 seconds**,
fully offline, and show budget balances computed by the **same shared engine**
the desktop runs. No Delivery/Waku networking yet (that is Phase 3 — issues #3/#4).

This is the mobile half described in `docs/plan.md` §6 and `docs/architecture.md`.
The wire contract and fold engine live in `packages/contract` and `packages/engine`
and are the single source of truth; this app **reuses them directly**, it does not
re-implement money/HLC/fold logic.

---

## What's implemented

| Area | Status | Notes |
|---|---|---|
| **Amount-first quick-add** | ✅ | Launch → `Add` tab, big custom keypad, amount is the only required field. Account/date/cleared/category all defaulted. One tap on **Save** appends a `txn.create` and re-folds instantly. |
| **Local append-only event log** | ✅ | AsyncStorage (`kym.eventLog.v1`), a JSON array of the **exact `@kym/contract` event shape**. Idempotent append (dedup by `id`). This log *is* the future wire format. |
| **Offline balances via the shared engine** | ✅ | `Budget` tab folds the log with `@kym/engine.computeState` → Ready to Assign, per-category Available, account balances, and the `checkInvariant` oracle. Nothing is stored; every number is a projection. |
| **Review / inbox + set category later** | ✅ | `Review` tab lists transactions (uncategorized first); tapping one emits a `txn.edit` (superseding event) to assign a category or toggle cleared. |
| **Setup / seed** | ✅ | `Setup` tab: one-tap demo budget (2 accounts, 2 groups, 6 categories, this-month assignments), plus add-account / add-category and a log reset. |
| **Pairing** | 🟡 stub | `Pair` tab generates a **real** 32-byte household secret (SecureStore-persisted), derives the real topic + 3-word pgp-words fingerprint (ported from Perun `docs/pairing-crypto.md`, re-namespaced `kym`), and renders the pairing QR. **No networking** — clearly banner-marked. |
| **Delivery / Waku sync** | ❌ | Out of scope for Phase 2. See issues #3 (bridge) / #4 (liblogosdelivery). |

Money is **always integer milliunits** — `toMilli`/`fromMilli` from `@kym/contract`
are the only float boundary, used at the UI edge only.

### Device / HLC
Every event carries an HLC (`{wall, ctr, dev}`) from `@kym/contract`'s `Clock`.
The device id is a stable per-install value in SecureStore (`src/lib/device.ts`),
so this phone's events order deterministically against a partner's once sync exists.

---

## The Metro ↔ shared-engine resolution (the integration challenge)

The shared packages are plain **ESM `.mjs`** in the npm workspace at `../packages`,
they are **not** listed in this app's `dependencies`, and `contract/events.mjs`
imports `randomUUID` from **`node:crypto`** (which React Native does not have).
Getting Metro to actually bundle them took solving four distinct problems, all in
`metro.config.js` (+ one flag in `app.json`). This is documented here because it is
non-obvious and each layer is load-bearing.

1. **The sources live outside the app** (`../packages`). Metro only watches the
   project root by default → `config.watchFolders = [../packages]`.

2. **`node:crypto` doesn't exist in RN.** A custom `resolver.resolveRequest`
   rewrites `node:crypto` / `crypto` to `shims/crypto.js`, a 6-line shim that
   re-exports `randomUUID` from `expo-crypto` (Android SecureRandom).

3. **Package `exports` subpaths + `.mjs`.** The same `resolveRequest` maps every
   bare specifier explicitly to its file — `@kym/engine` → `engine/src/index.mjs`,
   `@kym/contract` and `@kym/contract/{money,hlc,events}` → their `.mjs` — so we
   don't depend on Metro's package-`exports` support. (`mjs` is already in Expo's
   default `sourceExts`.)

4. **Expo's on-demand filesystem drops external `watchFolders` on export.** This
   was the subtle one. Expo's CLI enables an "on-demand filesystem" by default;
   when *exporting*, `withMetroMultiPlatform` then **resets `watchFolders` to just
   the project root** (`@expo/cli/.../withMetroMultiPlatform.js`, "aggressively cut
   down watchFolders"), and its scoped file-map fork refuses to hash files outside
   the server root — surfacing as `Failed to get the SHA-1 for .../engine/src/index.mjs`
   even though the file resolved fine. Fix: **`app.json` → `expo.experiments.onDemandFilesystem: false`**,
   which preserves `watchFolders` and restores the classic full crawl. The config
   also sets `resolver.useWatchman = false` and `watcher.unstable_lazySha1 = false`
   as belt-and-suspenders for environments without Watchman.

**Why not vendor a copy?** Vendoring was an option, but the whole point of Phase 0
is that the phone and desktop run the *identical* fold. Resolving the real
`@kym/engine` source keeps that guarantee with zero drift.

**TypeScript** sees the `.mjs` (untyped JS) packages through ambient declarations
in `types/kym-shared.d.ts` — hand-kept in sync with `packages/*/src/*.mjs`. That
keeps `tsc --noEmit` green without pointing the compiler at the `.mjs` sources.
`src/lib/engine.ts` is the single typed re-export the screens import from.

---

## Run it

```bash
cd mobile
npm install --legacy-peer-deps      # RN 0.86 / React 19 peer ranges
npm run android                     # build + install on a connected Android device/emulator
# or:
npx expo start                      # dev server; press 'a' for Android
```

Android-first, and per the project's Perun lesson the native Delivery path (Phase 3)
must be tested on **real arm64 hardware** — but Phase 2 has no native modules beyond
Expo's, so an emulator or Expo Go is fine for the capture/balances flow.

### First launch
No data yet → the `Add` screen points you to **Setup → Seed demo budget**. After
seeding, capture expenses on `Add` and watch `Budget` update offline.

---

## Verified

- `npx tsc --noEmit` → **passes** (0 errors).
- `npx expo export --platform android` → **succeeds**: `index.ts (934 modules)`,
  `dist/_expo/static/js/android/index-*.hbc` (~2.3 MB). The bundle contains the
  shared engine/contract/pairing code (verified: `rta-inflow`, `readyToAssign`,
  `cashOverspending`, `kym/topic/v1`, milliunit assertion strings all present).
- Engine parity: folding the canonical `data-model.md` §9 example through the
  workspace-resolved `@kym/engine` reproduces RTA 0, Groceries 25000, Dining 20000,
  Checking 45000, invariant OK — identical to the spec.

Not verified: running the installed APK on a device (no device/emulator in the
build environment). The code is scaffolded and bundles; on-device runtime was not
observed.

---

## Layout

```
mobile/
  App.tsx                     tab shell (Add / Budget / Review / Setup / Pair), default = Add
  index.ts                    Expo root registration
  metro.config.js             the resolution seam (see above)
  shims/crypto.js             node:crypto → expo-crypto randomUUID shim
  types/kym-shared.d.ts       ambient types for @kym/contract + @kym/engine
  src/
    lib/
      engine.ts               single typed re-export of the shared packages
      device.ts               stable per-install device id (HLC dev / SecureStore)
      eventLog.ts             AsyncStorage append-only log (idempotent)
      budget.ts               demo seed + transaction reconstruction for the inbox
      identity.ts             pairing crypto (ported from Perun, kym namespace)
      pgpWords.ts             PGP biometric word list (copied verbatim from Perun)
    state/BudgetContext.tsx    owns the log, re-folds via the engine, exposes mutations
    ui/theme.ts                dark theme tokens
    screens/
      CaptureScreen.tsx        amount-first quick-add (the must-have)
      BudgetScreen.tsx         offline balances + invariant
      ReviewScreen.tsx         review inbox, categorize-later (txn.edit)
      SetupScreen.tsx          seed / add account / add category / reset
      PairingScreen.tsx        household secret + QR + fingerprint (STUB, no networking)
```

## Stubbed / next (issues #3, #4)
- **Pairing screen** derives real key material and shows the QR + fingerprint but
  does not pair or transmit anything.
- **Delivery/Waku transport** (`seal`/`open`/`topicFor` in `identity.ts` are ready
  for it), `liblogosdelivery` JNI, encrypt+chunk+send, receive+merge — all Phase 3.
