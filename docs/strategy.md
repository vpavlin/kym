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

### Product: open-core "KYM Plus"
Free & **private core** forever (budget, capture, OCR, sync over community relays, local AI). Paid **Plus** (~€3–5/mo, or a one-time license) for **optional services** where we sell infra/convenience:

| Plus feature | Why it's OK to charge | Cost we cover |
|---|---|---|
| **Encrypted Codex backup** | we store only ciphertext we *can't read* — solves the durability gap | storage |
| **Premium reliable relays** | guaranteed-uptime Waku so users don't run infra | bandwidth/nodes |
| **Bank auto-import** | GoCardless aggregator pass-through (#8) | per-connection fee + margin |
| **Hosted AI option** | local stays free; a bigger hosted model for those who want it | inference |
| **Cross-household sharing** | shared budgets need group crypto (MLS) | dev + coordination |

The two strongest hooks — **"a financial advisor that never sees your data"** (#9) and **"backup we can't read"** — are things *only a local-first app can honestly say*. They're premium **and** ethos-aligned.

## Guardrails
- **Stay open-source (open-core).** Non-negotiable for a privacy product — users must be able to *verify* nothing leaks. This is the trust moat, not a giveaway.
- **No tokenization of the budget app itself.** The audience is privacy + pragmatism, not speculation; a token would repel exactly the users we want, even though we're on Logos.
- **Free tier must be genuinely useful and private on its own** — Plus is convenience, never a paywall on your own money.

## First moves
1. Grant pitch (Logos/IFT) + build-in-public thread; the demo is the proof.
2. Ship the **local AI assistant** (#9/#11) — the clearest "impossible for cloud apps" differentiator.
3. Stand up **encrypted Codex backup** as the first paid service (also closes the durability gap).
4. Then bank auto-import (#8) and premium relays once there's a user base to serve.
