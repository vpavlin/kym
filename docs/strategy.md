# KYM — sustainability & business strategy

How KYM funds ongoing development **without breaking local-first + privacy + open-source.** Draft; see issue #10.

## The tension, and the resolution

Local-first means we **don't custody your data** — so YNAB's model (pay a subscription to reach your own data on our servers) is off the table, and that's the whole point. The resolution:

> **Sell optional convenience & infrastructure. Never sell access to your own data. Be the plumber, not the landlord.**

Every paid feature must be justifiable as *"we ran a server / covered a real cost"*, never *"we gate your data"*.

## Positioning wedge

| | Custody | Price | Private | Ownership | AI |
|---|---|---|---|---|---|
| **YNAB** | cloud | €100+/yr | no | no | cloud |
| **Actual Budget** | self-host | free | yes | yes | — |
| **KYM** | **p2p, no server** | **free core** | **yes (E2E)** | **yes** | **local** |

KYM = *YNAB's method + Actual's ownership + real p2p privacy + a private AI + zero-ops sync/backup.* Nobody occupies that square: the privacy-conscious YNAB refugee who doesn't want to self-host a server.

## Funding, in two horizons

### Near-term (non-dilutive): ecosystem grant
KYM is a **flagship local-first consumer app on the Logos stack** — Waku for sync, Codex for backup, Nym for metadata privacy. That is exactly what the **Logos / IFT / Status** ecosystem exists to fund and showcase. A grant is the realistic first money, it's build-in-public friendly, and it doesn't compromise the model. *Action: a one-page pitch — "the private YNAB, built on Waku+Codex" — with the working demo (module + mobile + sync) as proof.*

### Product revenue: non-custodial DeFi yield (primary) — NOT open-core

**Decision (2026-07): no open-core.** The whole app stays free and fully open-source — no feature is paywalled. Two revenue lines instead, both ethos-aligned:

**1. DeFi savings integration with a fee cut (the real business).** A zero-based budget *knows exactly which money is idle* — the emergency fund, the "true expense" sinking funds (Rule 2), any envelope with a balance target you're not spending soon. That money is perfect to put to work. KYM offers to route it, **non-custodially** (the user's own wallet signs; we never hold funds), into a savings protocol — **Aave** or an **ERC-4626 vault** — and takes a small cut of the yield/flow.
- "Your Emergency Fund earns ~X% while it waits." Framed as a budgeting feature, not a crypto feature.
- Non-custodial keeps us out of the "we hold your money" line and matches self-custody / local-first.
- EUR-native fits the CZK/EUR audience.
- **Concrete stack (researched — see `research-defi.md`):** Monerium **EURe on Gnosis Chain** (MiCA-compliant e-money token, free 1:1 SEPA on/off-ramp to a personal IBAN) → **sDAI ~4–4.6%** or an **Aave Stable Vault** (ERC-4626, low-risk, no impermanent loss). Fee cut via a **0x/LI.FI integrator fee** skimmed on-chain to KYM's wallet (MetaMask does exactly this at 0.875%). **Account-abstraction wallet** (passkey, no seed phrase, sponsored gas) for onboarding. **Guardrail: strictly non-custodial + transaction-construction-only + no advice**, to stay clear of MiCA CASP authorization (mandatory for EU crypto services after 1 Jul 2026) — get EU counsel before launch.

**2. Voluntary one-time licence fee.** A "pay once if you value it" supporter licence — no gating, no nag-ware, purely voluntary (Obsidian-catalyst / itch.io style). Keeps goodwill and funds baseline dev.

### Grant (unchanged, near-term)
Logos / IFT / Status ecosystem grant — flagship local-first consumer app on Waku (+ Codex, + Nym). Non-dilutive first money.

## Guardrails
- **Fully open-source, nothing gated.** Users must be able to verify nothing leaks; the trust moat is total transparency, not a free/paid split.
- **Non-custodial always.** We construct transactions; the user's wallet signs. We never take custody of funds — legally and ethically the safest line, and consistent with local-first.
- **DeFi is opt-in and honest about risk** (smart-contract risk, stablecoin depeg, yields vary). Never the default; never hidden.
- **No token for the budget app itself** — the audience is privacy + pragmatism, not speculation.

## First moves
1. Grant pitch (Logos/IFT) + build-in-public; the demo is the proof.
2. Ship the **local AI assistant** (#9) — the clearest "impossible for cloud apps" differentiator.
3. **Research + design the DeFi savings integration** (issue #10 research) → prototype a non-custodial "put my emergency fund to work" flow.
4. Add the voluntary licence + a donate/support path.
