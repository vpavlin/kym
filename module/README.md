# KYM Basecamp module (`ui_qml`)

The desktop half of KYM — where most features live. C++/Qt backend + QML views, SQLite append-only event log, syncing over Logos Delivery. Built via `logos-module-builder` (Nix flake) → `.lgx`, structure modeled on Perun's `module/`. Tracked in issue #1.

## Status

- **`src/kym_engine.hpp`** — header-only C++ port of the budget fold (`@kym/engine`), std-only, no Qt. **Done and verified.**
- **`test/parity.cpp`** — proves the C++ fold produces byte-identical numbers to the TS reference (same scenarios as `packages/engine/test`, incl. the §9 convergence example). **24/24 checks pass.** Guard against TS↔C++ drift (issue #5).
- **`metadata.json` + `flake.nix` + `CMakeLists.txt` + `src/kym.rep` + `kym_backend.{h,cpp}` + `qml/Main.qml`** — the `ui_qml` module. The backend holds the append-only event log (in memory for MVP), applies each SLOT (`loadDemo/addAccount/addCategory/assign/spend/moveMoney`) as events, re-folds via the engine, and publishes the budget as JSON; `Main.qml` renders the grid (groups → categories with Assigned/Activity/Available, accounts, credit-card payments, and the live invariant). **Builds and packages a portable `.lgx`** via `nix build ./#lgx-portable` — `variants/linux-amd64/kym_plugin.so` + `qml/Main.qml`.
- **Verified:** engine correctness (parity test) and that the module **compiles + packages** into a well-formed `.lgx`. **Not yet verified:** rendering inside a live Basecamp host (needs a `logos-qt-mcp` / Xvfb headless UI test — next).
- **Next (issue #1):** headless render check; SQLite persistence of the log (vendored like Perun); `delivery_module` subscribe→decrypt→dedup→append→fold so two instances sync; editing affordances in the QML.

## Build the module

```sh
nix build ./#lgx-portable --print-out-paths   # -> …-logos-kym-module-lgx-0.1.0/logos-kym-module.lgx
```

## Verify the engine port

```sh
cd test
g++ -std=c++17 -I../src parity.cpp -o parity && ./parity
# -> PARITY OK — 24/24 checks passed
```

## Design note

The C++ engine deliberately takes the same shape as the TS one (two-layer fold, derived projections, HLC-ordered union merge). Keeping the two in lockstep is enforced by the parity fixtures, not by hand — extend both the TS tests and `parity.cpp` together when the model grows.
