# KYM Basecamp module (`ui_qml`)

The desktop half of KYM — where most features live. C++/Qt backend + QML views, SQLite append-only event log, syncing over Logos Delivery. Built via `logos-module-builder` (Nix flake) → `.lgx`, structure modeled on Perun's `module/`. Tracked in issue #1.

## Status

- **`src/kym_engine.hpp`** — header-only C++ port of the budget fold (`@kym/engine`), std-only, no Qt. **Done and verified.**
- **`test/parity.cpp`** — proves the C++ fold produces byte-identical numbers to the TS reference (same scenarios as `packages/engine/test`, incl. the §9 convergence example). **24/24 checks pass.** This is the guard against TS↔C++ drift (issue #5).
- **Next (issue #1):** `metadata.json` + `flake.nix` + `CMakeLists.txt`; `src/kym.rep` view contract; `kym_backend.{h,cpp}` (wraps the engine, holds the event log, exposes budget-state JSON + assign/spend/move SLOTs); `kym_store.{h,cpp}` (SQLite log, vendored like Perun); `qml/Main.qml` (budget grid); `delivery_module` subscribe→decrypt→dedup→append→fold.

## Verify the engine port

```sh
cd test
g++ -std=c++17 -I../src parity.cpp -o parity && ./parity
# -> PARITY OK — 24/24 checks passed
```

## Design note

The C++ engine deliberately takes the same shape as the TS one (two-layer fold, derived projections, HLC-ordered union merge). Keeping the two in lockstep is enforced by the parity fixtures, not by hand — extend both the TS tests and `parity.cpp` together when the model grows.
