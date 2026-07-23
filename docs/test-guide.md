# KYM — Manual Test Guide & Verification Checklist

A feature-by-feature guide for verifying KYM works, for the maintainer and any tester. Every item has **prerequisites → steps → expected result → a checkbox**. The goal: turn "built but unverified" into "verified on real hardware."

> **Honesty note.** Much of KYM is proven only at the engine/CLI level today. The desktop module has never run on the real Basecamp host; the mobile app has run on a real phone in *earlier* builds only. This guide is how we close that gap — record real results. See `docs/parity.md` for the current honest status.

## Legend & environments

Mark each item: **[x]** pass · **[!]** fail (note it) · **[ ]** not run · **[~]** N/A for this environment.

| Env | What you need |
|---|---|
| **A — Dev machine** | Node ≥ 20, this repo, `npm i`. Runs automated tests + the full CLI. |
| **B — Phone** | A real **Android arm64** device (NOT an x86_64 emulator — the `liblogosdelivery` `.so` is arm64-only). Install the APK from the F-Droid repo. |
| **C — Desktop** | A real **Basecamp** host that loads `ui_qml` modules; install the KYM `.lgx`. |
| **D — Two devices** | Phone (B) + Desktop (C), or two desktops, sharing one household key, on a network that can reach the `logos.dev` Waku fleet. |

A test that needs an environment you don't have → mark **[~]** and move on. **CLI + automated (Env A) is fully runnable today by anyone.**

---

## 0. Automated baseline — run this first (Env A)

These gate everything else. If any fail, stop and fix before manual testing.

- [ ] **Unit + property + parity suite** — `npm test` → expect `# pass 39 # fail 0`.
- [ ] **Engine group/roles tests** — `node --test packages/engine/test/group.test.mjs` → all pass.
- [ ] **C++ ↔ TS engine parity** — `cd module/test && g++ -std=c++17 -I../src parity.cpp -o /tmp/parity && /tmp/parity` → `PARITY OK — 29/29`.
- [ ] **QML static lint** — `scripts/qml-harness/` note: run `qmllint` on `module/qml/Main.qml`; expect only "unqualified access" style warnings, no errors.
- [ ] **QML renders (mock)** — `bash scripts/qml-harness/render.sh /tmp/kym.png` → writes a PNG; open it, the editor grid should look correct.
- [ ] **Module builds** — `cd module && nix build --no-link` → exit 0 (produces the `.lgx`).
- [ ] **Mobile typecheck** — `cd mobile && npx tsc --noEmit` → exit 0.

---

## 1. CLI — the reference surface (Env A)

The CLI is the most complete surface and the fastest way to validate budgeting logic. Use a throwaway file so you don't touch a real budget:

```bash
export KYM_FILE=/tmp/kym-test.json
alias K='node cli/kym.mjs'
```

### 1.1 Core budgeting
- [ ] **init** — `K init --device me --currency CZK` → "Initialized KYM budget… (device: me, currency: CZK)".
- [ ] **add account** — `K account add Checking --type checking --balance 30000` → confirms; `K accounts` lists it at `30 000 Kč`. (An on-budget starting balance is money to budget, so **RTA is now 30 000 Kč**.)
- [ ] **add category** — `K category add Groceries --group Everyday` → confirms.
- [ ] **income** — `K income 45000 --account Checking` → Ready to Assign rises **by 45 000 to `75 000 Kč`** (30 000 starting + 45 000 income), via `K budget`.
- [ ] **assign** — `K assign Groceries 8000` → `K budget` shows Groceries Assigned `8 000 Kč`, RTA drops by 8000 to `67 000 Kč`.
- [ ] **spend** — `K spend 2450 --account Checking --category Groceries` → Groceries Activity `-2 450 Kč`, Available `5 550 Kč`; Checking balance drops.
- [ ] **move** — `K move Groceries Dining 1000` (after adding Dining) → net-zero: Groceries −1000, Dining +1000, RTA unchanged.
- [ ] **budget view** — `K budget` → grid with groups, RTA hero, and a footer line `invariant OK ✓`.
- [ ] **zero-based invariant** — the footer must read **`invariant OK ✓`** after *every* operation above. This is the core correctness guarantee. If it ever reads `BROKEN ✗`, that's a **[!]** fail — record the command that caused it.

### 1.2 Targets, reconcile, currency
- [ ] **target (monthly)** — `K target Groceries monthly 8000` → `K budget` shows `🎯 funded` (or `🎯 need …`).
- [ ] **reconcile** — `K reconcile Checking 27000 --adjust` → books an adjustment so the balance matches; invariant still OK.
- [ ] **foreign tracking account** — `K account add Revolut --type tracking --balance 420 --currency EUR` → shows `420,00 €` (EUR formatting: comma decimals, `€`), off-budget, not in RTA.
- [ ] **on-budget FX is rejected** — `K account add Euros --type checking --currency EUR` → **error** ("on-budget accounts must be in the budget currency"). Correct behavior.

### 1.3 Import, categorize, reports
- [ ] **CSV import** — `K import <some.csv> --account Checking --format airbank --dry-run` → lists parsed rows; without `--dry-run` it imports and dedupes on re-run (second run adds 0).
- [ ] **categorize (learned)** — after categorizing a payee once, `K categorize "<payee>" <Category>` and future imports of that payee suggest it.
- [ ] **report** — `K report` → per-category spend for the month.
- [ ] **net worth** — `K networth` → assets − liabilities across accounts.

### 1.4 Group budgets & roles (CLI, file-sync)
Set up two "devices" as two files:
```bash
export KYM_FILE=/tmp/alice.json; K init --device alice --currency CZK
K group init "Novak Family"; K member add bob --role editor; K member add carol --role viewer
K account add Checking --type checking --balance 5000; K category add Groceries --group Everyday
K members    # → alice admin (you), bob editor, carol viewer
```
- [ ] **members list** — shows all three with correct roles and `← you` on alice.
- [ ] **editor edit merges** — in `/tmp/bob.json`: `K init --device bob`, `K sync /tmp/alice.json`, `K assign Groceries 1500`. Back in alice: `K sync /tmp/bob.json` → Groceries shows `1 500 Kč`.
- [ ] **viewer edit is ignored** — in `/tmp/carol.json`: `K init --device carol`, `K sync /tmp/alice.json`, `K assign Groceries 9999`. In alice: `K sync /tmp/carol.json` → Groceries **still 1 500 Kč** (carol's 9999 dropped). This is role enforcement on merge.
- [ ] **role change takes effect** — `K member role carol editor`; re-sync carol's later edits now count.
- [ ] **convergence** — after all syncs, both files show identical budgets and `invariant OK ✓`.

---

## 2. Mobile app (Env B — real arm64 phone)

Install the signed APK from the F-Droid repo. **Emulator will not sync** (arm64 `.so`); capture/OCR/UI still work on emulator for a partial check.

### 2.1 First run & setup
- [ ] **install & launch** — app opens to the capture tab, no crash.
- [ ] **device id shown** — Setup tab shows "This device's id: …" (needed for group pairing).
- [ ] **seed demo** — Setup → "Seed demo budget" → Budget tab shows meaningful envelopes + a EUR tracking account.
- [ ] **budget currency** — Setup shows CZK selected; locked once accounts exist.

### 2.2 Capture (the core mobile loop)
- [ ] **amount-first entry** — capture tab: type an amount, pick account + category, Save → returns instantly (no network wait).
- [ ] **appears in budget** — Budget tab reflects the new spend (activity + available update).
- [ ] **offline** — enable airplane mode, capture an expense → still saves (the log is local); sync status shows "offline".

### 2.3 Receipt OCR (on-device)
- [ ] **scan a receipt** — capture → scan a real receipt photo → the **amount prefills** from OCR.
- [ ] **OCR accuracy** — try 5 real Czech receipts; record how many amounts were correct (this number is the honest OCR accuracy — currently unmeasured).
- [ ] **category suggestion** — after OCR/merchant, a category is suggested from your history (once you've categorized that merchant before).
- [ ] **fallback** — a blurry/failed scan falls back to manual entry, no crash.

### 2.4 Review & glance
- [ ] **review/categorize** — Review tab: uncategorized txns can be assigned a category; a toast confirms.
- [ ] **WCAG indicators** — negative/overspent categories show a **sign or ⚠ word**, not color alone (tilt-test: still understandable in grayscale).

### 2.5 Group budgets on mobile (NEW — verify carefully)
- [ ] **make a group** — Setup → "Group budget" card → "Make this a group" → you become **admin**; the card now shows the members list.
- [ ] **your role shown** — the card states "You are **admin**".
- [ ] **add member** — enter another device's id + name, pick a role, "Add member" → appears in the list.
- [ ] **change/remove** — admin can tap role chips to promote/demote and "remove" a member.
- [ ] **non-admin is read-only** — on a device that's a *viewer*, the card shows the roster read-only ("only an admin can manage members").

---

## 3. Desktop Basecamp module (Env C — real host)

Install the `.lgx` into a real Basecamp host. **This has never been run on the real host — this section is the highest-value verification.**

### 3.1 Load & render
- [ ] **module loads** — KYM appears and renders the budget grid (not a blank/erroring pane).
- [ ] **load demo** — the demo budget populates; RTA hero + invariant footer show.
- [ ] **fingerprint** — a 3-word pairing fingerprint is shown in the header/status.

### 3.2 Command bar actions (each opens an inline form → backend SLOT)
- [ ] **+ Expense / + Income** — record each; a **green toast** confirms; grid updates.
- [ ] **Assign / Move / Target / Reconcile** — each works; a wrong value (e.g. unknown category) shows a **red error toast** (system-status feedback).
- [ ] **+ Account / + Category** — create both.

### 3.3 Editor UX (the P1 polish — verify these specifically)
- [ ] **inline cell edit** — click a category's **Assigned** cell, type a number, Enter → it assigns the delta.
- [ ] **click a balance to move** — click a category's **Available** balance → the Move form opens **pre-filled** with that category as "from" (pointer cursor + tooltip on hover).
- [ ] **dropdowns/autocomplete** — the account/category fields in forms are **dropdowns** (type to filter or pick), not raw text.
- [ ] **filter** — type in "filter categories…" → the grid filters live.
- [ ] **collapsible groups** — click a group header (▾/▸) → it collapses/expands.
- [ ] **keyboard shortcuts** — `Ctrl+E/I/G/M/T` open Expense/Income/Assign/Move/Target; `Ctrl+F` focuses the filter; `Esc` closes the form.

### 3.4 Group budgets on desktop
- [ ] **make a group** — command bar "Group" → "Make this a group" → button relabels to "Members"; a **members strip** appears.
- [ ] **members strip** — shows each member · role, with ★ on you; role shown as a **word** (not color alone).
- [ ] **add member** — the "Members" form adds a member by device id with a role.
- [ ] **non-admin** — a viewer-role instance can't manage members (SLOT returns an error toast).

### 3.5 Invariant & correctness
- [ ] **invariant footer** — reads `invariant OK ✓ · assets = categories + RTA` and the numbers add up, after every action.

---

## 4. Cross-device sync (Env D — two devices, one household key)

This is the promise that was **never verified on hardware**. Pair a phone and a desktop (or two desktops) with the same key.

### 4.1 Pairing
- [ ] **QR pairing** — desktop shows/accepts a pairing QR + fingerprint; phone scans it; **fingerprints match** on both.
- [ ] **same fingerprint = same household** — confirm the 3-word fingerprint is identical on both devices.

### 4.2 Live sync
- [ ] **phone → desktop** — capture an expense on the phone → within seconds it appears in the desktop grid.
- [ ] **desktop → phone** — assign on the desktop → the phone's budget reflects it.
- [ ] **latency** — note the round-trip time; it should be seconds, not minutes.

### 4.3 Convergence & backfill
- [ ] **concurrent offline edits** — both devices offline: phone spends in Groceries, desktop assigns to Groceries; reconnect → **both converge to the same numbers**, nothing lost.
- [ ] **backfill a reinstalled phone** — wipe the phone's log (Setup → reset), re-pair → the desktop **re-serves** the full history so the phone catches up.
- [ ] **invariant holds post-merge** — both devices show `invariant OK ✓` after converging.

### 4.4 Group roles across devices
- [ ] **viewer enforced remotely** — a device paired as a **viewer** makes an edit; on the admin's device after sync, that edit is **ignored** (role enforcement survives the real transport, not just file-sync).
- [ ] **removed member** — remove a member on the admin device; their later edits (over the wire) are ignored. *(Note: this is "soft" removal — they can still decrypt with the shared key until MLS re-keying lands. Verify the ignore-on-merge, not secrecy.)*

---

## 5. Multi-budget: household + a Circle (Env B/C/D) — **PENDING BUILD**

> Approved and being built ("Full multi-budget now"). Until it lands, a device holds **one** budget and re-pairing clobbers it — **do not** try to pair into a second budget yet. This section will be filled in when the feature ships:
- [ ] create a second budget (a Circle) alongside the household without losing the first
- [ ] a budget switcher lists both; switching shows the right log/balances
- [ ] each budget syncs on its own topic — a Circle event never appears in the household budget
- [ ] pairing **adds** a budget rather than replacing the current one
- [ ] per-budget roles are independent (admin of the household, viewer of the Circle)

---

## 6. Data integrity (all envs)

- [ ] **money is never float** — amounts are integer milliunits internally; no rounding drift (e.g. CZK 6759 vs 6760 — the golden vectors cover this).
- [ ] **invariant is a hard check** — anywhere it reads BROKEN is a bug; capture the event log (`K log`) and file it.
- [ ] **idempotent merge** — syncing the same peer twice adds 0 new events the second time.

---

## Recording results

For a real verification pass, copy this file, fill the boxes, and note environment + build version (mobile `versionCode`, module `.lgx` tag) at the top. File any **[!]** as a GitHub issue with the reproducing steps. When a whole surface passes on real hardware, update `docs/parity.md` to flip its 🟡 → ✓ (with the build it was verified on).
