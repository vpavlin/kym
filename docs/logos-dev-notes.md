# Logos module dev + test — hard-won notes

Reusable knowledge for building/testing Logos Basecamp modules (Perun, KYM, and the next ones). Everything here was learned by doing; keep it updated.

## ⚠️ FIRST: which Basecamp is the TARGET? Behaviour differs a lot by version
Establish the version the *user* runs before designing or debugging anything, and test the artifact you actually ship **on that version**. Getting this wrong cost an entire debugging saga (I tuned against 1.0.0-dev while the target was 0.2.0-release, and every "fix" solved a problem that didn't exist there while breaking things that did).

| | **0.2.0 release** (tutorial-v4 target; KYM's target) | 1.0.0 dev |
|---|---|---|
| ui_qml entry point | **`view` field** (stock builder output) | `manifest.main.<variant>` — needs a post-build patch |
| module→QML events (`logos.onModuleEvent`) | **work** — use them | do not deliver; needs polling |
| dependency module instances | **one** | 2+, routed per call → state divergence |
| `.lgx` variant | portable `linux-amd64` (release build) | `linux-amd64-dev` (dev build) |
| store dir | `~/.local/share/Logos/LogosBasecamp` | `…/LogosBasecampDev` |

Build the target locally to test against: `nix build 'github:logos-co/logos-basecamp/0.2.0'` (dev) or `…#bin-bundle-dir` (portable), then run it with its own data dir: `LogosBasecamp --user-dir <dir>`, installing packages with `lgpm --modules-dir <dir>/modules` / `--ui-plugins-dir <dir>/plugins`. Note `lgpm`'s own build decides which variant it accepts — a portable `.lgx` is rejected by a dev `lgpm` and vice-versa.

**Everything below marked "1.0.0" is version-specific — do not assume it applies to 0.2.0.**

## Module types (metadata.json `type`)
- **`core`** — headless service module (delivery_module, kym_core). Universal authoring: you write only `src/<name>_impl.{h,cpp}` where the class is **`<NameCamelCase>Impl`** deriving `LogosModuleContext`. Public methods = the API; `logos_events:` section = emittable events; `onContextReady()` = setup hook; `modules().<dep>` = typed callers for `dependencies`. **Qt-free** (std::string); the plugin glue is generated. Built with `mkLogosModule`. Runs standalone under `logoscore` OR as a dependency of a ui module.
- **`ui_qml`** — a QML view + optional C++ backend. `main: <name>_plugin.so`, `view: qml/Main.qml`, optional `codegen.rep` (a QtRO replica: PROPs auto-sync to QML, SLOTs callable). Backend derives `KymSimpleSource` (from the .rep) + `LogosUiPluginContext`. Built with `mkLogosQmlModule`. This is Perun's + KYM's shape.
- **`ui`** — standalone UI app plugin; `main: <name>.so` with **QML embedded in the .so** (no `view`, no `qml/` dir). e.g. `package_manager_ui`, `main_ui`.

## logos-module-builder (`lib.mk*`)
- `mkLogosModule` (core/plugin), `mkLogosQmlModule` (ui_qml), `mkStandaloneApp`, `coreBackend`/`uiBackend`, `parseMetadata`.
- Flake outputs per module: `default`, `lib`, `install` (store layout under `plugins/<name>/` or `modules/<name>/`), `install-portable`, `lgx`, `lgx-portable`, `generate` (dumps `generated_code/` incl. the dependency caller `<dep>_api.h`), `<name>-headers-{std,qt,lp}`, `lidl`.
- The builder **stamps `logos_protocol_version` into metadata.json** during build (it parses it) — so metadata must be valid JSON *after* stamping.
- Local dep between modules: add a flake input `path:../<dir>` with `.inputs.logos-module-builder.follows` + `.inputs.delivery_module.follows`. It's **locked** — after editing the dep, `nix flake update <input>` (or the ui build uses a stale copy). A dirty git tree IS used (nix warns "Git tree is dirty") for tracked files; `git add` new files so nix sees them.

## Codegen quirks (bit me repeatedly)
- **Non-ASCII breaks the parsers.** An em-dash/ellipsis in a metadata `description` breaks the JSON stamper; a non-ASCII char in an impl **header** comment stops the interface generator (methods after it silently vanish). Keep headers + metadata **ASCII-only**.
- **The generated dependency-caller exposes only a SUBSET of a core module's public methods** — empirically the "action-style" mutating methods came through (addAccount, assign, loadDemo, resync, groupInit, pairWithCode…) while getters (`budgetJson`/`status`/`fingerprint`/`setSecret`/`ingestSealed`/`logFingerprint`) were dropped, regardless of position. **Root cause not fully pinned.** Workaround that works: **deliver read-state via `logos_events:`** (e.g. `budgetChanged(std::string json)`) with fields folded into the JSON, and seed initial state by calling an exposed action (`resync()`) that re-emits. Don't rely on getter methods being callable across modules.
- Universal-API method **returns must be JSON-serializable** — the generated dispatcher `.dump()`s the result. Return `std::string`, not `int` (`int.dump()` fails to compile).

## Delivery module API (differs by caller type!)
- A **core** module gets the **std** delivery caller: `createNode(std::string cfg)`, `subscribe(std::string)`, `send(std::string topic, LogosMap payload)`, `onMessageReceived(cb(hash, topic, LogosMap payload, ts))`. `LogosMap = nlohmann::json` (`logos_json.h`). Include `"logos_sdk.h"` (the generated umbrella that completes `LogosModules`).
- A **ui_qml** backend gets the **Qt** delivery caller: `createNode(QString)`, `send(QString, QString/QByteArray)`, `on("messageReceived", cb(QVariantList))`.
- **Payload = base64 inside JSON** (`liblogosdelivery.h`: `{"contentTopic","payload":"<base64>","ephemeral"}`). Both surfaces must base64 the sealed bytes to interoperate — raw binary can't ride a JSON string, and a std module + Qt module otherwise disagree. See `kym_wire_std.hpp::b64encode`.
- `createNode` takes a **named preset only** (`logos.dev`/`logos.test`/`twn`) — no custom bootstrap/ENR — so you can't point clients at a self-hosted nwaku. No Store query is exposed either. ⇒ backfill is republish-on-demand, and the "hub" is an always-on peer on the public fleet, not private infra.

## Running headless: logoscore
- One-shot: `logoscore -m <modulesDir> -l capability_module,delivery_module,<mod> -c "<mod>.method(args)"`. This **loads modules headless with dependency injection** (verified). But `-c` returns marshal to `false` without capability-token coordination.
- Canonical (release docs): a **daemon** + client calls — `logoscore -m ./modules -D &` then `logoscore load-module X` / `logoscore call X method json`. The daemon keeps `capability_module` alive so returns come back.
- Modules are **process-isolated** — each runs in a `logos_host` child; only core modules show in the app's "Module stats". A ui plugin runs in the UI process (not in that list).

## Running the GUI headless: Basecamp under Xvfb
- `logos-basecamp` **runs under Xvfb** (`Xvfb :99 -screen 0 1400x1000x24 & DISPLAY=:99 QT_QPA_PLATFORM=xcb logos-basecamp`). Screenshot with `scrot`; automate clicks with `xdotool`.
- Module store: **`~/.local/share/Logos/LogosBasecampDev/`** with **`modules/`** (core modules: `<name>/{manifest.json,variant,<name>_plugin.so}`) and **`plugins/`** (ui apps: same layout + `qml/` for ui_qml). Config: `~/.config/Logos/LogosStandalone.conf`.
- ui apps surface as **left-sidebar icons**; clicking one loads the module (and its deps) and opens its view in the MDI area.
- **Manual store-copy == installed (disproven earlier hypothesis).** The store is *just files* (`manifest.json`, `variant`, the `.so`s, `qml/`) — there is no separate registry/DB. A package-manager install extracts the same files a manual copy writes; it does NO extra registration. So "manual copy vs install" cannot explain a view-load difference.
- **`Install LGX Package` is a silent no-op headless.** In `package_manager_ui -> Modules -> Install LGX Package`, the native `*.lgx` file picker accepts a file, closes, and writes *nothing* — no files under the store, no log line, no error dialog. So you cannot drive a package-manager install under Xvfb; install from a repo/file is untestable here. Load an already-present module with the per-row **Load** button instead.
- **`View Methods` is unpopulated for ALL core modules** (even the working `package_manager`) — it always says "No methods available". Not a diagnostic; ignore it. The `logos` QML bridge can still call a core module's methods (see below).

## THE ui_qml-view-won't-open root cause (KYM, solved by elimination)
A ui plugin's view opens as a **new MDI tab** when you click its **sidebar icon** (verified: `counter_qml` opens + renders). KYM's sidebar click / `Load` does nothing: its **deps spawn** (`kym_core` + `delivery_module` `logos_host` children appear in Core Modules stats) but the kym plugin's own load never completes — its `Load` button stays green "Load" (a successful load flips to red "Unload", as `counter_qml` does), no tab opens, no error is logged anywhere, and each attempt **leaks** the spawned dep hosts (they accumulate; no `logos_host --name kym` is ever spawned — a ui_qml backend loads in the UI process, not a host). The fault line across the installed plugins:
  | plugin | type | backend .so | deps | view opens? |
  |---|---|---|---|---|
  | counter_qml | ui_qml | no (pure QML) | none | YES |
  | package_manager_ui / main_ui | **ui** | yes | package_manager (core) | YES |
  | perun_analytics | ui_qml | yes | delivery_module (builtin core) | YES (elsewhere) |
  | **kym** | **ui_qml** | **yes** | **kym_core (custom core)** | **NO** |
The one failing cell = **ui_qml + a C++ backend + a dependency on a CUSTOM core module**. Every working combo avoids at least one of those. Conclusion: Basecamp 1.0.0 does not bring up a ui_qml plugin whose C++ backend is injected with a custom core-module caller.
**Fix direction (option C):** drop kym's C++ backend + `.rep` entirely and make the view **pure QML** (like `counter_qml`), calling `kym_core`'s methods through the global **`logos` bridge** — `counter_qml` proves a pure-QML view calls a core module (`package_manager.testPluginCall`) with no backend and no declared dep. This removes the failing combination and is *truer* to "thin ui, core owns the logic" (no C++ duplicated between hub + view). VALIDATED: a pure-QML plugin declaring `kym_core` as a dep opens its view AND auto-loads kym_core; `logos.callModule("kym_core", action, [args])` reaches it synchronously.

## The ACTUAL blocker was the manifest `main` field (basecamp version skew)
After porting to pure QML, the view *still* wouldn't open — but the real cause turned out to be a **builder/runtime version mismatch**, not the backend:
- **The deployed basecamp is 1.0.0; the pinned `logos-module-builder` (021013458d87) + the tutorial target 0.2.0.** They disagree on how a ui_qml plugin declares its QML entry point.
- **basecamp 1.0.0 loads the QML from `manifest.main.<variant>`** (e.g. `{"linux-amd64-dev": "Main.qml"}`), exactly like the shipped `counter_qml` sample (`metadata: pluginType:"qml", main:"Main.qml"`). The **`view`** field (what tutorial-v4 / basecamp-0.2.0 use) is **ignored** by 1.0.0. Empty `main: {}` ⇒ no entry point ⇒ the plugin's deps load but no view/tab ever opens (looks identical to the backend failure).
- **But the pinned builder rejects metadata `main` for a QML module** — it decides "has `main` ⇒ compiled ⇒ needs CMakeLists.txt" and fails. So you cannot set `main` in metadata with this builder.
- **Workaround that works:** build pure-QML with `view: "Main.qml"` (file at the module ROOT, not a `qml/` subdir — 1.0.0 resolves `main` relative to the plugin root), then **post-process the built manifest** to set `main: {"<variant>": "Main.qml"}`. With that, the view opens reliably on first click. The right long-term fix is to align the builder pin with the basecamp actually deployed (or use `lgpm` + a matching basecamp per the tutorial's §8).
- **The shipped sample for your basecamp is ground truth.** When the tutorial (a different basecamp version) and the installed basecamp disagree, mirror the plugin that ships *inside* the installed basecamp (here: `counter_qml`).

## Events are NOT delivered to QML in basecamp 1.0.0 — poll instead
Tutorial-v4 shows `logos.onModuleEvent("mod","evt")` + `Connections{ onModuleEventReceived }` for a module's `logos_events:`. **This does not deliver in basecamp 1.0.0** (no event-using sample ships with it, and kym_core's `budgetChanged` never arrived). Read state by **polling a dispatchable read action** on a Timer instead: add a no-arg action (e.g. `snapshot()`) that returns the folded JSON string; call it on load + after each mutation + every ~2.5s. (Getters like `budgetJson()`/`status()` are NOT dispatchable — see the codegen-subset note — but an action-style no-arg method IS.)

## Basecamp may run a dependency module as MULTIPLE instances
Observed: a mutation (`addAccount`) sent via `logos.callModule("kym_core", …)` persists to kym_core's shared log, but a subsequent `snapshot()` read returns state *without* it — writes and reads land on **different in-memory kym_core instances** that share only the on-disk log (`~/.kym-core/log.json`). Mitigation attempted: re-read the persisted log inside `snapshot()` (loadPersistedLog dedups by event id) so any instance reflects edits made through another. This needs confirmation on a clean single-instance host — under a heavily-relaunched headless session the instancing was hard to pin down. Likely related to `LogosModuleContext`'s per-instance persistence (`instancePersistencePath`) — worth reading the "composing modules" tutorial for the intended one-instance-per-dep model.

## Orphaned `logos_host` processes leak and collide
Every failed/again-launched basecamp leaves `logos_host` children reparented to `systemd` (or the launching shell). They accumulate (saw 80+), and stale same-name modules can confuse routing. Kill them between runs: `pkill -9 -x logos_host` (NOT `-f`, which matches your own command line). Beware: `pgrep -f 'name kym_core'` **matches your own shell command** containing that string — count real hosts with `pgrep -x logos_host`, and gate on `ps -o comm=`, not a cmdline substring.

## Gotchas that cost me hours
- **`pkill -f logos-basecamp` self-kills the bash command** — the command line contains the binary path (which contains `logos-basecamp`), so `-f` matches its own parent shell → SIGTERM (exit 144), no output. Use **`pkill -x <procname>`** (exact process-name match) instead.
- **Qt version shadowing** — prepend the **nix Qt 6.9 lib dirs** to `LD_LIBRARY_PATH` or the system `libQt6*` shadows them (`Qt_6.9 not found`). `LD_LIBRARY_PATH="$(ls -d /nix/store/*qt*-6.9.2*/lib | tr '\n' :)$DM/lib:$CORE/lib"`.
- **`.lgx` variant: REPO distribution uses PORTABLE (`linux-amd64`), NOT `-dev`.** This one cost multiple wrong flip-flops. There are two separate contexts with *different* variant expectations:
  - **Repo / catalog install (what Basecamp's package manager browses)** — uses the **portable** variant `linux-amd64` (`nix build .#lgx-portable`). EVERY official catalog package (chat_ui, blockchain_module, …) ships `linux-amd64` (+ `linux-arm64`, `darwin-arm64`). A `-dev` variant in a repo shows as **"NOT AVAILABLE"** in the GUI — the availability check wants the portable platform. Signatures are NOT the gate (official packages are `[unsigned]` too).
  - **Local dev install (`lgpm install --file`)** — wants the **`-dev`** variant (`nix build .#lgx`, platform `linux-x86_64-dev`, store `LogosBasecampDev`). This is why `lgpm` REJECTS a portable `.lgx` (`does not contain variant for platform: linux-x86_64-dev`) even though the same file installs fine from a repo. Don't use `lgpm`'s platform demand to decide what to *publish* — they are different code paths.
  - **Ground-truth the repo answer with `lgpd`, not `lgpm`.** `lgpd` (logos-package-downloader, `nix build 'github:logos-co/logos-package-downloader#cli'`) is the catalog tool Basecamp's repo view uses. `lgpd --config <cfg> repo add <logos-repo.json>; repo refresh; --json info <pkg>` — compare your package's `variants` against an official one that IS available (e.g. `chat_ui`). Match theirs (`linux-amd64`).
  - When republishing to fix it, **bump the version** — the GUI caches the index and won't re-notice a same-version change.
- **SDK-rev discipline** — build every module against the SAME `logos-module-builder` rev the deployed Basecamp uses (pin it), or cross-module IPC skews silently.
- **The `logoscore -c 'mod.method(a,b)'` CLI mangles args — cost ~an hour chasing a phantom `editTxn` bug.** Three distinct manglings, all silent: (1) **numeric args are typed as `int`** (`editTxn(id,900)` → arg1 type `int`), so a `QString` slot **silently no-ops and returns the current state** as if it succeeded — no error, no effect; (2) **double-quotes are stripped** (`{"amount":"900"}` arrives as `{amount:900}` → invalid JSON); (3) **args split on every comma**, so a JSON object with internal commas is shredded into extra args. Net: you cannot pass a numeric value or a JSON string through `-c`. **Symptoms of the trap:** the dispatch log says `Method call successful. Result: QVariantMap` but the event never lands in `log.json`. **How to actually test** a method that takes numbers/JSON: build the payload **in C++** (a temporary `snapshotSelfTest…()` method that constructs the real JSON via nlohmann and calls the method directly — the exact shape QML's `JSON.stringify` produces), verify, then delete it. A method whose 2nd arg is non-numeric text (e.g. `notjson`) *does* marshal as `QString`, which is how you confirm the body runs at all. Also relevant: **the module glue silently drops a method that has too many arguments** — a 5-string-param `editTxn` never fired; collapsing to `editTxn(txnId, patchJson)` (2 params, change-set as one JSON string) fixed it. Keep public methods to ≤4 args and pass structured data as a single JSON string.

## QML render harness (`scripts/qml-harness`)
- The view file is **`module/Main.qml`** (metadata `view: "Main.qml"`). `render.sh` had a **stale `module/qml/Main.qml`** path that silently rendered nothing / an old copy — fixed to `module/Main.qml`. The harness is `harness.cpp` → offscreen QQuickView loading Main.qml with a **mock backend** (`setProperty("budgetJson", …)`), optional 4th argv selects a view mode (`tx` / `editsheet` / `settings` / an `action`).
- **`budget` is a binding derived from `budgetJson`; it lags `onBudgetJsonChanged`.** A handler that reads `budget.transactions` right when `budgetJson` changes sees the *stale* value — wrap the logic in **`Qt.callLater(…)`** so bindings settle first. (Bit me making the harness auto-open the edit sheet.)
- A **modal `Popup` with `anchors.centerIn: Overlay.overlay`** needs a window/overlay; in the bare harness `open()` warns "cannot find any window to open popup in" if the overlay is null — it still renders in practice here, but keep popups tolerant.

## LAN repo / cert (for Basecamp package repos)
- Basecamp fetches repos over **HTTPS** and reads the OpenSSL **`SSL_CERT_FILE`** env var, which **replaces** the default CA bundle — so it must be a **bundle of system CAs + your LAN cert(s)**, or *all* HTTPS (repos + GitHub + fleet) breaks. A missing/empty `SSL_CERT_FILE` fails every repo.
- The LAN cert must be a **leaf/server cert** (`basicConstraints=critical,CA:FALSE` + `extendedKeyUsage=serverAuth`), **not a CA cert**. `openssl req -x509` defaults to `CA:TRUE` on OpenSSL 3 — Basecamp/Qt rejects a CA cert used to terminate TLS ("fetch failed"). Do NOT add the LAN cert to the system CA store while a Qt app is running — it can break that app's TLS globally.

## The `qr` core module is unreachable from a pure-QML view

`logos.callModule("qr", "generate", [text])` returns **`null`** — qr-basecamp v0.2.0's
core is *Qt-free*, and the legacy synchronous `callModule` bridge can't reach a
Qt-free module. Its README documents the `callModule` form anyway; the truth is in
the shipped `qr_ui` QML (extract it from the `.lgx`), which routes through its own
C++ QtRO backend: `logos.watch(logos.module("qr_ui").generate(text), cb)`.
Declaring `"dependencies": ["qr"]` *does* load it (`Module loaded: qr`), which makes
the wiring look correct while every call still yields null.

KYM therefore encodes the pairing QR in **kym_core** (`pairingQr()`), using the same
vendored MIT `qrcodegen` that qr-basecamp uses. Benefits: no async, no second module
for the user to install, and it rides the `callCore` path that already works.

Two traps hit on the way:
- **nix flakes only see git-tracked files** — an untracked vendored source fails the
  build with CMake "Cannot find source file: src/qrcodegen.hpp". `git add` it.
- **module `std::string` returns are double-encoded** — one `JSON.parse` yields a
  *string*, not the object. Unwrap up to twice (same as `asBudget`/`callModuleParse`).

Rendering: the QML sandbox blocks image `data:` URIs, so the core returns a MATRIX
(`{ok, n, cells[]}`, row-major, `true` = dark) and the view paints it on a `Canvas`.
Verified end-to-end on basecamp 0.2.0: the rendered QR decodes (zbarimg) to exactly
`kym://pair?s=<code>`.
