# Research — non-custodial DeFi yield monetization for KYM (2026)

From a deep, source-verified research pass (issue #10). KYM's budget already knows exactly which money is **idle** — the emergency fund and the "true-expense" sinking funds. That's the money to put to work, non-custodially, for a fee cut.

## Bottom line
KYM can monetize by **constructing transactions** that deposit a user's stablecoins into a non-custodial yield venue and **skimming an integrator fee on the flow** — never holding funds. The cleanest EUR-native stack:

- **Rail: Monerium EURe on Gnosis Chain.** A **MiCA-compliant euro e-money token** issued by an authorized EMI (Central Bank of Iceland supervised), redeemable 1:1 on demand, ~102% backed. Users get a personal **EUR IBAN**; SEPA in auto-mints EURe (currently **free**, SEPA-Instant ~5s). Deployed on Ethereum, Gnosis, Arbitrum, Base, Polygon, Linea. → solves the fiat on/off-ramp *and* the EUR-native requirement in one. [[gnosis.io/blog/eure-on-gnosis-chain]], [[monerium.com/eure]]
- **Yield: sDAI (~4–4.6%, pure base yield, no impermanent-loss risk)** on Gnosis; or **Aave Stable Vaults** (ERC-4626, fixed-rate). Low-risk stablecoin savings, not LP farming. [[defillama sDAI pool]], [[aave.com/blog]]

## How the fee cut works (non-custodial, well-precedented)
The integrator fee is skimmed **on-chain at execution** — the user signs the calldata, funds never touch KYM:
- **0x Swap API**: `swapFeeBps` → a `swapFeeRecipient` wallet (KYM's), capped at 1000 bps (10%). [[0x.org docs]]
- **LI.FI**: integrator fee as a float (e.g. 0.02 = 2% of volume), forwarded to the integrator wallet at execution (LI.FI keeps ~25 bps). [[docs.li.fi/monetization]]
- **1inch**: fee deducted from the destination amount. [[1inch business docs]]
- **Precedent — MetaMask**: a self-custody wallet skimming **0.875%** on in-wallet swaps, never holding funds (effective ~0.3–0.875% by size). Exactly the pattern. [[Delphi: MetaMask revenues]]
- **Precedent — DeFi Saver**: a non-custodial management/UX layer over DeFi (Safe-based smart wallet, audited contracts, never accesses user wallets). Matches KYM's intended architecture. [[defisaver.com]]

For a *savings* deposit (not a swap), the fee is taken by routing through a fee-configurable deposit/zap (0x/LI.FI zap into the vault) or a thin fee-taking ERC-4626 wrapper — same principle.

## Wallet & UX (for non-crypto EUR users)
- **Smart-contract / account-abstraction wallets** (ERC-4337; e.g. Coinbase Smart Wallet) → **passkey onboarding, no seed phrase**, and **sponsored gas** (paymaster). Removes the main UX barrier. [research]
- **On-ramp: SEPA ~0.5–1%** vs cards ~3–5% — SEPA/EURe preserves the fee margin and is what EU users already have. [research]
- **Framing**: "Put your Emergency Fund to work — earning ~X% while it waits," a budgeting feature, not a crypto feature. Only offered on envelopes the budget shows as idle/long-horizon (balance-target sinking funds).

## Regulatory guardrails (EU / MiCA — decisive)
- **Stay strictly non-custodial and transaction-construction-only.** Construct the tx; the user's wallet signs; KYM never holds keys or funds. This is the line that keeps KYM **out of MiCA CASP authorization** — which after **1 July 2026** is mandatory for anyone providing a regulated crypto-asset service to EU users. [research, medium confidence — get EU counsel before launch]
- **Give no investment advice** — surface protocol yields/risks as neutral facts, no recommendation to a specific user.
- **EURe itself is already the regulated, compliant e-money layer** (Monerium is the licensed EMI) — KYM rides it, doesn't reissue it.
- ⚠️ MiCA specifics move fast and are jurisdiction-sensitive (Czech/EU) — treat this as direction, not legal sign-off.

## Recommended phased integration
1. **Read-only "your idle money could earn ~X%"** — compute idle envelopes (emergency + long-horizon balance targets), show live sDAI/Aave APY. No funds move; pure information. Validates interest, zero regulatory surface.
2. **Non-custodial deposit flow** — AA wallet (passkey) + SEPA→EURe on Gnosis + a fee-configured zap into sDAI/Aave Stable Vault; integrator fee to KYM's wallet. Opt-in, one envelope at a time.
3. **Withdraw/settle back to the budget** — redeem → EURe → SEPA to IBAN; reflect the yield as income in the budget.
4. **Broaden** venues/chains once volume justifies; revisit MiCA posture with counsel.

## Fee sizing (rough)
A household emergency fund + sinking funds are commonly several months of expenses — often €5–20k idle. At a modest integrator cut on deposits + a small ongoing spread, even a few thousand active households is meaningful, non-dilutive revenue. (Size precisely once #10 UX validation runs.)

## Sources
Monerium EURe / Gnosis · 0x Swap API monetization · LI.FI monetization docs · 1inch business docs · Delphi (MetaMask revenue) · DeFi Saver · DefiLlama (sDAI) · Aave Stable Vaults. (Full URLs in the research transcript; verify all figures/regulatory points before acting.)
