# Demo script: KYM in 5 minutes

For showing KYM to a household, a couple, or anyone who has tried YNAB and disliked handing their
bank history to a cloud. One laptop with Basecamp, one Android phone. The budget is the built-in
starter budget (CZK, made-up numbers), shared between the two devices.

## Before (10 minutes, once)

**Phone:** add the F-Droid repo from [apps.vpavlin.xyz](https://apps.vpavlin.xyz) and install
**KYM**. Installing **Loam** too is recommended: KYM uses Loam's shared node by default (approve
KYM in Loam when asked). Without Loam, KYM runs its own node (Setup → *Delivery node* → *Own node*).

**Laptop:** Basecamp 0.3. Add the package repository `https://apps.vpavlin.xyz/logos-repo.json`
and install **kym** (the view) and **kym_core** (the engine).

**Seed the budget on the laptop.** Open KYM. The empty screen says *Your budget is empty*; click
**Seed a starter budget** (also in ⚙ Settings → *Starter budget*). You get Checking, Visa and a
EUR Revolut account; Bills / Everyday / Goals; and 6 000 Kč still *Ready to Assign*.
Only the desktop seeds this exact budget; the phone's Setup → *Seed demo budget* makes a different
one, so don't use it here.

**Pair the phone.** Laptop: ⚙ Settings → *Share this budget* shows a QR code. Phone: **Share** tab →
*Join another household* → **Scan QR** → point at the QR → **Add as new budget**. (Or tap the
budget pill at the top → *Join a budget* → **Scan QR**.) Give it a minute to fill in, and check
that both screens show the same accounts and categories.

**Names.** Laptop: ⚙ Settings → *Your name* → **Save**. Phone: **Setup** tab → *Your name* →
**Save name**. Use two different names, so the audience can see who added what.

## The demo

**1. The budget (laptop, 1 min).** The main screen.
- "Every koruna that comes in gets a job." Point at **Ready to Assign** at the top, then the
  columns ASSIGNED / ACTIVITY / AVAILABLE under Bills, Everyday, Goals.
- The footer says 6 000 Kč is still ready to assign. Click the ASSIGNED cell of **Emergency Fund**, type
  `11000`, press Enter. The footer turns to *✓ Every koruna has a job*.
- *Say:* this is the whole method: you budget the money you have, not the money you hope for.

**2. The household (both, 45 s).** Laptop: ⚙ Settings → *Share this budget*. Phone: **Share** tab.
- Point at the **fingerprint** words: the same on both screens.
- *Say:* this code is the household. No account, no sign-up, no company in the middle. Whoever
  has the code is in; everyone else, us included, sees only scrambled data.

**3. Spend on the phone (1 min).** Phone: **Add** tab.
- Type `350` on the keypad, tap the **Groceries** chip and the **Checking**
  account chip, tap **Save expense**. Under 10 seconds.
- Laptop (← Back to budget): Groceries' ACTIVITY and AVAILABLE change within seconds. Click 📋
  (Transactions): the new line shows the phone owner's name.
- *Say:* the phone talked to the laptop directly. There's no server holding your budget.

**4. Both offline, nothing lost (1.5 min).** The "aha".
- Phone: turn on **airplane mode**. Add tab → `220`, **Dining**, **Checking**, **Save expense**. It saves
  right away; the budget on the phone is already updated.
- Laptop: **＋ Expense** → amount `500`, account *Checking*, category *Fun Money* → **Add expense**.
- Phone: airplane mode off. Within a minute both devices show **both** purchases, and the same
  Ready to Assign.
- *Say:* two people spent at the same time without signal, and both purchases count. Nothing
  overwrote anything. That's the hard part of a shared budget, and it's built in.

**5. Fix a mistake (phone, 30 s).** **Review** tab → tap the Dining expense → change the amount →
**Save amount** (or **Delete transaction**). The laptop follows.
- *Say:* edits and deletes sync the same way, and the history keeps who did it.

## If something goes wrong

- **Phone shows nothing after pairing:** check the sync label next to KYM at the top of the phone
  (it should say *syncing*). If you use Loam, check Loam is running and KYM is approved there.
  Then **Setup** → *Sync & device* → **Sync now**.
- **Laptop doesn't pick up the phone's changes:** ⚙ Settings → *Sync* → **Sync now**. The line below
  counts what was received; "failed" above 0 means the two devices hold different codes: pair again.
- **Wrong budget on screen:** both apps can hold several budgets. Laptop: the name at the top
  (▾). Phone: the coloured pill. The colour is the same for the same household on every device.
- **Nothing syncs at all:** the network may be slow; give it two minutes. Offline edits are never
  lost; they go out when the device is back online.

## What to leave them with

- A real zero-based budget, on phone and desktop, shared by the household, with no server and
  no account.
- Your data is encrypted end to end between your own devices; privacy is simply who you share
  the code with.
- Offline edits from several people merge without losing a koruna.
- [apps.vpavlin.xyz](https://apps.vpavlin.xyz) to install.
