# UI/UX best practices + KYM audit (2026)

From a source-verified research pass (86 confirmed claims; YNAB, Copilot, Actual Budget, WCAG, NN/g, Baymard, Android a11y). Doubles as a **scorable rubric** and KYM's **audit** (✅ have · 🟡 partial · ❌ missing), then a **prioritized polish plan**.

> The research workflow's auto-synthesis returned a stub; findings were recovered from its verification journal. Sources at the bottom.

## Key patterns (distilled)

**Mobile capture.** Amount-first, minimal taps; `type=text` + `inputmode="decimal"` (never `type=number`) for locale decimals; **format on blur, not per keystroke**; right-align amounts; defer validation to blur/Enter. Home-screen **widgets** (YNAB both platforms; Copilot has a "Transactions to Review" widget) + **Siri/App-Shortcut** quick entry. **Offline capture + deferred sync.** Receipt scan → merchant/date/total **+ line items → split subtransactions**; OCR is ~25% wrong in practice so **manual review is mandatory**, on-device = privacy selling point.

**Desktop grid.** Three columns per category (Assigned/Activity/Available); **click the budgeted cell and type** (inline editing); **bulk fill** (copy last month, 3/6/12-mo average, "assign what's left", save-by-date); **collapsible category groups**; **keyboard shortcuts**; **density controls + search/filter**; a **goals/pacing** indicator column; **move money by clicking a balance** → transfer to another category or back to To-Budget; an **inspector/detail pane** (progressive disclosure) so details show without leaving the grid.

**Zero-based UX.** Make "give every dollar a job" (drive Ready-to-Assign to 0) the hero. Overspend = move money to cover / deduct from next month; specific **red** for overspent + credit-card-overpaid (a *specific* warning state, not generic error). **Onboarding must teach the METHOD, not the UI** — empathy-driven, meet users where they are, microcopy matters (YNAB improved onboarding success by changing one label), progress bar, warm welcome. Design real **empty states**.

**Visual & a11y.** **WCAG 1.4.1: never color alone** for meaning — overspent/negative needs an icon or sign too; color pairs need ≥3:1 contrast. Currency for screen readers: **bare symbol, `aria-hidden` the symbol, `aria-label` the amount** (JAWS won't parse formatted currency). **48×48 dp** touch targets + 8 dp spacing. **Visibility of system status** — every action gets immediate feedback (toast/confirm); error messages **explain + say how to fix**, never swallowed. Error-tolerant inline editing + undo. Recognition over recall (icon **+ label**).

## Rubric + KYM audit

### Mobile
- ✅ Amount-first entry, custom numeric keypad focused on launch
- ✅ Offline capture, never blocks on network; review inbox
- ✅ On-device receipt OCR → **editable** prefill (review mandatory ✓)
- ✅ Learned auto-categorization (history-first)
- 🟡 Receipt extraction: amount/merchant/date only — **no line-items → split** yet
- ❌ Home-screen **widget** / App-Shortcut / quick-tile entry
- ❌ **Onboarding** that teaches zero-based budgeting; empty states
- ❌ Accessibility: currency `aria-label`/`aria-hidden`, screen-reader pass, 48 dp audit
- 🟡 Number formatting on blur / right-align (custom keypad — verify)

### Desktop (Basecamp)
- ✅ Three-column envelope grid (Assigned/Activity/Available) + groups + targets + CCP + invariant
- ✅ Editor: command bar (expense/income/assign/move/target/reconcile/add) wired to SLOTs
- ✅ Click a category → Assign (a step toward inline)
- 🟡 **Inline cell editing** — should be "click the Assigned cell and type", not a separate form
- 🟡 Move money — should be "click the balance → transfer", not typing names
- 🟡 Forms use **typed names**, not dropdowns/autocomplete
- ❌ **Bulk fill** (copy last month / averages / assign-what's-left / save-by-date UI)
- ❌ **Collapsible groups**, **search/filter**, **keyboard shortcuts**, density controls
- ❌ **Transaction register** (a table of transactions) on desktop
- ❌ Inspector/detail pane (progressive disclosure)
- ❌ Reconcile: no cleared-marking / statement flow (just an adjustment)

### Cross-cutting
- ✅ Dark mode (both surfaces), consistent palette + engine
- ✅ Per-currency formatting (CZK 0 / EUR 2), Ready-to-Assign hero with 0=green
- ❌ **Color-alone for money states** (negative/over-assigned/overspent are color-only → WCAG 1.4.1 fail; add sign/icon)
- ❌ **System-status feedback**: desktop `run()` **swallows SLOT errors** (console.log only) — user sees nothing on failure; no success toast
- ❌ Onboarding / method education (biggest adoption gap)
- ❌ Undo affordance (the log is reversible; no UI)
- 🟡 Consistency mobile↔desktop (shared engine/colors; different layouts)

## Prioritized polish plan

**P0 — cheap + high impact (do first)**
1. **Surface action feedback + errors** — desktop `run()` currently drops backend error strings; show a toast/status line on success *and* failure (Nielsen "visibility of system status"). Mirror on mobile. *Small.*
2. **Non-color indicators** for money states — add a `−`/⚠ sign or "overspent"/"over-assigned" label next to the color, everywhere (WCAG 1.4.1). *Small.*

**P1 — core interaction wins**
3. **Inline cell editing** on desktop — click the Assigned cell, type, Enter (uses `assignedRaw` for the delta). The single biggest desktop UX win. *Medium.*
4. **Dropdowns/autocomplete** for category/account in the command-bar forms; **move money by clicking a balance**. *Medium.*
5. **Collapsible category groups + search/filter + keyboard nav** on desktop. *Medium.*

**P2 — adoption + depth**
6. **Onboarding** (both surfaces): teach zero-based budgeting empathy-first, warm microcopy, progress, real **empty states**. *Medium-high, high impact.*
7. **Bulk budget fill** (copy last month, N-month average, assign-what's-left) + save-by-date target UI. *Medium.*
8. **Transaction register** view on desktop. *Medium.*
9. **Mobile widget + quick-entry shortcut**; **receipt line-item splits** (desktop VLM, ties to `research-ocr-models.md`). *Platform work.*
10. **Accessibility pass** — currency `aria`, screen-reader labels, 48 dp targets, contrast check. *Medium.*

## Sources
YNAB (widgets, Siri, keyboard shortcuts, overspending, CC-red, onboarding UX) · Copilot (widgets) · Actual Budget (grid, targets, automations, envelope onboarding) · number/currency input UX (luhr.co, uxpatterns.dev) · WCAG 1.4.1 + 3.3.4 · currency-for-screen-readers (Vispero) · Android touch targets · NN/g complex-app design + heuristics · Baymard.
