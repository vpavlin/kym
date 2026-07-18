# KYM data model & merge semantics (v1)

The single source of truth both halves depend on. This document is **authoritative**: the TS engine (`packages/engine/`) is the reference implementation, and the C++ module must reproduce these folds byte-for-byte (validated by golden vectors + the invariant oracle).

Transport is **Logos Delivery (Waku)**. Money is **integer milliunits** (currency × 1000; `$10.50 = 10500`), outflow negative, inflow positive. **No floating point touches money, anywhere.**

---

## 1. Two layers

**Layer 1 — recorded money (the ledger).** Every transaction is an immutable fact. You never mutate a posting; an edit is a *superseding* event and a delete is a *tombstone*. Merging two devices' ledgers is a **union** — nothing is overwritten, so no concurrent amount can ever be lost. This mirrors double-entry accounting and Actual Budget's message-log→SQLite pattern.

**Layer 2 — the plan (the budget grid).** How much you *assigned* to each category each month, and *moves* between categories. Assignments are modeled so concurrent edits **combine** rather than clobber (see §4).

**Everything else is derived.** Ready to Assign, each category's Available/Activity, every account balance — none are stored. They are a pure deterministic **fold** over the merged, ordered event log. Two devices with the same set of events compute the same numbers, with zero repair logic.

---

## 2. Events

Every change is an event:

```
Event = { v:1, id:UUID, type:EventType, hlc:HLC, dev:DeviceId, payload:{…} }
```

- `id` — client-generated UUIDv4. The idempotency key: re-delivering an event is a no-op (dedup on `id` behind a durable unique index).
- `hlc` — Hybrid Logical Clock `{ wall, ctr, dev }`: wall-clock ms, a same-millisecond counter, and the device id. Gives every event a total order that respects causality and breaks ties deterministically across replicas. Wall clock is for ordering only, **never** for money.
- `dev` — the authoring device id (also the HLC tiebreak).
- `sig?` — optional per-device signature (authorship; the household PSK already authenticates the channel, so v1 may omit).

### Event types

| type | payload | meaning |
|---|---|---|
| `account.create` | `{accountId, name, accountType, onBudget, startingBalance, startDate}` | open an account; `startingBalance` becomes a starting posting |
| `account.edit`   | `{accountId, name?, closed?}` | rename / close (metadata; LWW per field by HLC) |
| `category.create`| `{categoryId, groupId, name}` | new envelope |
| `category.edit`  | `{categoryId, groupId?, name?, hidden?}` | metadata (LWW per field) |
| `group.create`   | `{groupId, name}` | category group |
| `txn.create`     | `{txnId, accountId, amount, date, payeeId?, categoryId? \| splits[], cleared, approved, memo?, transferId?}` | a posting |
| `txn.edit`       | `{txnId, ...fields}` | **superseding** event: replaces fields of a txn (see §3) |
| `txn.delete`     | `{txnId}` | tombstone: the txn no longer contributes |
| `assign`         | `{categoryId, month, mode:'set'\|'delta', amount}` | set/adjust the budgeted number for a category-month (§4) |
| `move`           | `{fromCategoryId, toCategoryId, month, amount}` | net-zero transfer between two category-months (§4) |

System categories are created implicitly, not by `category.create`:
- **`rta-inflow`** — the "Inflow: Ready to Assign" pseudo-category. A txn categorized here is income into the global pool.
- **`ccp:<accountId>`** — one Credit Card Payment category per on-budget credit card, auto-materialized when the account is created. Non-deletable, not directly editable.

---

## 3. Ledger fold (Layer 1 → balances & activity)

Process events in HLC order. Maintain, per `txnId`, the **current** view assembled from its `create` + any `edit`s (each `edit` field wins by HLC; a `delete` tombstones the whole txn). Then, for each live txn:

- **account balance:** `balance[accountId] += amount`. (A starting balance is just the account's first posting.)
- **category activity:** if categorized, `activity[(categoryId, monthOf(date))] += amount`. Splits fan out: each subtransaction hits its own category; **subtransaction amounts must sum to the parent `amount`** (validated).
- **transfers:** a transfer is two mirrored txns linked by `transferId`, one per account, amounts negated. Between two on-budget accounts it is **non-categorized and budget-neutral**. A transfer whose other side is a credit-card account is how a card gets paid (it reduces `ccp:<card>` availability — see §5).

`monthOf(date)` = the `YYYY-MM` the transaction's date falls in. Activity lands in the month of the transaction, independent of when the event was authored.

### Why edits are superseding events, not mutations
Two devices can edit the same txn offline. If we mutated a stored row, one edit would clobber the other (Perun's exact bug). Instead both edits are events; the fold applies both, resolving each field by HLC. Numeric truth (`amount`) is still never "picked" destructively at the value level — but note: a *correction to an amount* is a semantic replace, so `amount` is resolved by HLC like other fields. The safety property we guarantee is that **no event is ever dropped on merge** and **all replicas resolve identically**; genuine "we both changed the same number to different values" is a real human conflict that we surface (both events are retained; the HLC winner shows, and the register can flag that a superseded amount exists). This is strictly better than silent loss.

---

## 4. Plan fold (Layer 2 → assigned) and Ready to Assign

For each category-month, the **assigned** number is built from `assign` and `move` events:

- `assign` with `mode:'delta'` → `assigned[(cat,month)] += amount`. **Deltas are commutative**: two partners each adding $50 offline yields +$100, and neither is lost.
- `assign` with `mode:'set'` → sets an absolute value; resolved by HLC if two `set`s race (last set wins, deterministically). UIs prefer `delta` for "+$50 to groceries" and `set` only for "make it exactly $200". *Recommendation: the grid emits `delta` for increments and `set` only on explicit absolute entry.*
- `move` → `assigned[(from,month)] -= amount; assigned[(to,month)] += amount`. Two legs, sum zero. Concurrent moves combine additively. This is Rule 3 ("Roll With the Punches") as a first-class, conflict-free op.

### Available (the envelope balance) — with rollover

Process months in chronological order. For each `(category, month)`:

```
available(cat, month) = carryover(cat, month) + assigned(cat, month) + activity(cat, month)
carryover(cat, month) = max(0, available(cat, prevMonth))     // positive rolls forward; negative does NOT
```

A **positive** balance accumulates across months (sinking funds — Rule 2). A **negative** balance (overspending) does **not** roll into the same category next month; instead it is resolved at the global level (§5).

### Ready to Assign (single global derived value)

```
readyToAssign =
    Σ (txn.amount categorized to rta-inflow)         // all income ever
  − Σ (assigned across ALL categories and months)    // every dollar given a job
  − Σ (cash overspending)                            // §5
```

RTA is **one number for the whole budget** (not per-month). It is recomputed, never stored, and **may legitimately be negative** (you over-assigned, or you cash-overspent). Zero-based budgeting = the user drives it to 0; KYM never forces it.

---

## 5. Overspending & credit cards

Overspending resolution **branches on the funding account type**:

- **Cash/asset overspend** (spent from checking/savings/cash, category went negative): the negative does not roll forward; the overspent amount is **subtracted from Ready to Assign** (you must cover it with real dollars). Captured by the `Σ cash overspending` term in RTA above.
- **Credit overspend** (spent from a credit card): becomes **debt**, surfaced as underfunding in that card's `ccp:<account>` category. It does **not** reduce Ready to Assign.

### Credit-card payment mechanics

When a **funded** categorized outflow is charged to an on-budget credit card, budgeted money is *relocated, not consumed*:

```
spending category:   available −= X   (activity −X)
ccp:<card> category:  available += min(X, funded portion)
card account balance: −= X            (new debt)
```

Net category-Available change for the funded portion is **zero** — the money moves from "groceries" to "money set aside to pay this card." Paying the card (a transfer from checking → card account) reduces `ccp:<card>` availability and the card's debt together. A fully-funded card ⇒ `ccp` available == balance owed.

The fold computes `ccp` availability as a derived category like any other; the module/UI just renders it in the system "Credit Card Payments" group.

---

## 6. The invariant oracle

After every fold (and after every merge in the apps), this identity **must** hold:

```
Σ over on-budget ASSET accounts (balance)          // checking, savings, cash
   ==
Σ over ALL categories (available, incl. CCP)  +  readyToAssign
```

Assignable money is backed by **asset** accounts; every asset dollar is in exactly one place — a category envelope (including a Credit Card Payment category) or the Ready-to-Assign pool. **Credit-card / line-of-credit (liability) balances are NOT on the left side** — they are tracked separately and offset by their `ccp:<account>` category (a fully-funded card ⇒ `ccp` available == debt owed). This is why a funded card purchase (which moves money into `ccp` and debt onto the card, leaving assets untouched) keeps the identity intact. Off-budget (tracking/loan) accounts are excluded entirely — they only feed Net Worth. The engine exposes `checkInvariant(state)` returning the two sides and their difference; tests assert difference == 0 across every scenario and every random convergence run. A non-zero difference is a bug in the fold, by construction.

> Note the invariant is a **test oracle and a display check**, not a merge constraint. We never block, clamp, or drop an event to satisfy it — a negative RTA or a red category is a valid, displayed state a human resolves (exactly as YNAB does).

---

## 7. Merge & sync

- **Merge = union of events by `id`**, then HLC-order, then fold. Idempotent (re-delivery skipped via durable unique index on `id`). Commutative and associative ⇒ order of arrival is irrelevant; all devices converge.
- **Convergence guarantee:** two devices holding the same *set* of events compute identical `BudgetState`. Tests generate random interleaved concurrent edit streams, merge them in both directions, and assert (a) identical state and (b) invariant holds.
- **Transport:** each event is encrypted (ChaCha20-Poly1305, household key) and `send()` on `/kym/1/<householdId>/proto`. Events are tiny; only **bulk backfill** approaches the 150 KB cap and reuses Perun's chunk envelope `{type:'CHUNK', id, seq, total, gz}`.
- **Backfill:** the Basecamp module holds the full log in SQLite; on request (or on seeing a peer with a gap) it **re-sends** missing events. `liblogosdelivery` has no Store query, so this republish-on-demand is how a reinstalled phone or a new device catches up. v1: naive "resend all since epoch"; later: Merkle-tree diff to exchange only what's missing.

---

## 8. Topics & envelope (LIP-23, ports Perun)

- `/kym/1/<householdId>/proto` — the household's event feed. `householdId` derived from the shared secret via `HMAC-SHA256(K, "kym/topic/v1|"+epoch)` (not a fixed string), so the topic itself leaks nothing.
- `/kym/1/pairing/proto` — device pairing handshake (QR 32-byte secret + pgp_words fingerprint; ports Perun's `request_pairing`→`confirm_sync`).

Envelope (JSON to `delivery.send(topic, payload)`; the module base64-wraps across the FFI):

```
{ v:1, type:"EVENT"|"CHUNK", ... }
EVENT → { ...the Event object above, encrypted }
CHUNK → { id, seq, total, gz:<base64> }   // only for bulk backfill of many events
```

Encryption: `Ke = HKDF-SHA256(K, info="kym/payload/v1")`, ChaCha20-Poly1305, `nonce(12) ‖ ciphertext`, `aad = topic`. The household PSK authenticates both ends (no per-message signature required in v1).

---

## 9. Worked example (the convergence proof the CLI runs)

Start: one checking account, `startingBalance = 100000` ($100). Categories: Groceries, Dining. Income $100 already assigned nowhere (RTA = 100000).

Two devices, **both offline**:
- **Device A:** `assign delta +60000` to Groceries; `txn.create −25000` (spent $25 groceries).
- **Device B:** `assign delta +40000` to Dining; `txn.create −30000` (spent $30 dining); `move 10000` Groceries→Dining.

Neither has seen the other. Then they sync (union of all 6 events) and both fold:

- Groceries assigned = 60000 − 10000 = 50000; activity = −25000; available = 25000.
- Dining assigned = 40000 + 10000 = 50000; activity = −30000; available = 20000.
- readyToAssign = 100000 − (50000 + 50000) = 0.
- checking balance = 100000 − 25000 − 30000 = 45000.
- Invariant: accounts 45000 == available (25000 + 20000 = 45000) + RTA (0) = 45000. ✓

Both devices reach exactly this. **No edit was lost; the two concurrent assigns and the move all survived and combined** — the property Perun's LWW cannot provide.
