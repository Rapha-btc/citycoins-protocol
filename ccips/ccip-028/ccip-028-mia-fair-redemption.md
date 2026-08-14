# CCIP-028: MiamiCoin Fair Redemption with sBTC Rewards

| CCIP  | Title                                          | Status | Type      | Created    |
| ----- | ---------------------------------------------- | ------ | --------- | ---------- |
| 028   | MiamiCoin Fair Redemption with sBTC Rewards     | Draft  | Standard  | 2026-08-13 |

## Summary

CCIP-027 staked the MIA treasury under PoX-5. Rewards now arrive as sBTC, while
the mechanism that retires MIA pays in STX. This proposal swaps the sBTC rewards
to STX on-chain at a quoted price, routes the STX through a fair order book that
lets holders name their own exit price, and burns every MIA the book acquires.

Nothing about how a holder exits changes. You still post an offer at or below
par, the cheapest offers still fill first, you can still cancel at any time, and
you are still paid in STX.

Two things do change. The redemption ratio is corrected to reflect the MIA that
has already been burned, and the discount sellers accept is no longer captured -
it is burned along with the rest.

## Background

### What CCIP-027 changed

CCIP-027 moved 10,241,497.066794 STX out of `ccd002-treasury-mia-mining-v3` into
`ccd014-pox5-staking-mia` and staked it from reward cycle 141 for 96 cycles,
unlocking at cycle 237. The treasury is intact and earning. Only the form of the
reward changed: PoX-5 pays sBTC.

The reward path is already permissionless and already built:

```
pox-5  ->  ccd014-pox5-staking-mia  ->  forward-rewards  ->  ccd002-treasury-mia-rewards-v3
```

`forward-rewards` takes no arguments, is callable by anyone, and sweeps the full
sBTC balance. CCIP-027 also called `set-allowed` for `sbtc-token` on the rewards
treasury, with the stated intent that a future proposal would withdraw it. This
is that proposal.

### What the fair book has done so far

`SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.mia-fair-faktory-v2` has been running
against `ccd013-burn-to-exit-mia` for several cycles. Holders post an offer at or
below par; a whitehat settles the book from the bottom, buying the cheapest
offers first and redeeming that MIA at par.

Lifetime, as of 2026-08-13:

| Metric                        | Value               |
| ----------------------------- | ------------------- |
| MIA cleared out of the queue  | 42,903,974.60 MIA   |
| STX paid to sellers           | 62,167.14 STX       |
| Offers currently resting       | 50                  |
| MIA currently on the book      | 49,769,714.87 MIA   |

The mechanism works. The last settlement, on 2026-08-11, cleared 16,239,028 MIA
in a single transaction, paid three sellers at exactly the prices they had
posted, and left the redemption treasury at zero. No gas war, no front-running,
and the settler took no profit because the contract caps them at par.

What it does not currently have is fuel. The redemption treasury is empty and the
rewards that would refill it are denominated in sBTC.

## Motivation

Three problems, in order of how much they matter.

**1. The rewards cannot reach the book.** The book redeems at a ratio denominated
in STX. The rewards arrive in sBTC. Without a conversion step, sBTC accumulates
in the rewards treasury indefinitely and no MIA is retired.

**2. The redemption ratio is stale.** `ccd013` holds a ratio of 1710, meaning
1,710 STX per 1,000,000 MIA. That number was correct when it was set. Since then
holders have burned MIA, which shrinks supply without shrinking the treasury, so
the true ratio has risen. Every holder who redeems at 1710 today is redeeming
below what their claim is actually worth, and the difference silently accrues to
everyone else.

**3. The spread is being captured rather than burned.** When a seller accepts a
price below par, the difference is currently retained as MIA inside the book
contract, earmarked for seeding liquidity. That is a defensible use, but it is a
discretionary one, and it means the DAO is accumulating a position it then has to
decide what to do with. Burning it instead is simpler and benefits every
remaining holder in proportion.

## The ratio problem, precisely

`ccd013.initialize-redemption` derives the ratio itself:

```clarity
(mia-total-supply     (+ (* mia-total-supply-v1 MICRO_CITYCOINS) mia-total-supply-v2))
(mining-treasury-total-balance (get-mining-treasury-total-balance))
(mia-redemption-ratio (calculate-redemption-ratio mining-treasury-total-balance mia-total-supply))
```

and `get-mining-treasury-total-balance` reads exactly one address:

```clarity
(stx-account 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-mining-v3)
```

**CCIP-027 emptied that address.** The STX now sits locked in
`ccd014-pox5-staking-mia`. As of 2026-08-13 the mining treasury reads 0 STX, so
calling `initialize-redemption` today would compute a ratio of zero and make
every outstanding MIA claim worthless.

This is not a hypothetical. It is a live footgun in a DAO-gated function, and any
proposal that touches the ratio has to address it before doing anything else.

### What the ratio should be

Measured on-chain on 2026-08-13:

| Input                          | Value                     |
| ------------------------------ | ------------------------- |
| MIA v1 supply                  | 260,130,901 MIA           |
| MIA v2 supply                  | 4,754,074,853.491373 MIA  |
| Combined supply                | 5,014,205,754 MIA         |
| Treasury (now in ccd014)       | 10,241,497.066794 STX     |
| **Ratio by the DAO's own formula** | **2042**              |
| Current ratio on ccd013        | 1710                      |

That is a 19.4% increase in what a MIA holder is owed. A figure of 2030 has been
discussed; the formula gives 2042 on today's supply, and 2030 corresponds to a
supply about 31M MIA higher than the current one. The gap is simply burns that
happened in between.

The ratio moves with every burn, so whatever number is ratified will be stale the
moment it is set. Two options:

- **Fix it.** Ratify a single number and freeze it, as today. Predictable, and
  everyone can price against it, but it drifts from true backing over time.
- **Recompute it.** Read supply and treasury at redemption time. Always accurate,
  but the ratio moves under resting offers, which is difficult to price against.

This proposal recommends **fixing it at the measured value on the day of
execution**, for the same reason it is fixed today: a par that moves under
offerers is a par nobody can post against with confidence. Ratifying a fresh
number periodically is a governance action, not an automated one.

## Specification

### Overview

```
  pox-5 rewards (sBTC)
          |
          v
  ccd014-pox5-staking-mia
          |  forward-rewards  (permissionless, exists)
          v
  ccd002-treasury-mia-rewards-v3
          |  withdraw-ft      (this proposal authorises)
          v
  ccd0XX-rfq-swap-mia         (NEW)
          |  open-rfq -> fix-price -> fulfill
          |  against rfq-sbtc-stx-jing-v2-3
          v
        STX
          |
          v
  redemption contract  <-------  fair order book (STX-denominated)
          |                              ^
          |  redeem at par               |  holders post offers at or below par
          v                              |
      MIA burned  ----------------------- 
```

### 1. Correct the redemption ratio

The ratio must be set from a treasury balance that reflects reality. Two viable
routes:

- **Preferred:** deploy a replacement redemption extension whose treasury reader
  includes `ccd014-pox5-staking-mia` (locked plus unlocked), so the formula works
  again without a manual figure.
- **Alternative:** add a DAO-gated setter that accepts a ratified number
  directly, and set it to the value measured at execution.

Either way, the proposal must not call the existing `initialize-redemption`
against an empty mining treasury.

### 2. Swap extension

A new DAO extension holding sBTC and converting it to STX through
`SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3`.

Properties it must have:

- **Permissionless trigger, no arguments.** Same pattern as `forward-rewards`.
  The budget is the balance. Nobody needs to be trusted to call it on time.
- **Destination hard-coded.** The STX can only go to the redemption contract.
  A caller cannot redirect it.
- **A reclaim path.** The RFQ is two-phase: `open-rfq` and `fix-price` commit a
  quote, `fulfill` settles it later. If no market maker fulfils, the extension
  must be able to recover its sBTC. The RFQ exposes `reclaim` for this.

Why a quoted desk rather than an AMM: the RFQ price is committed before it
settles, so there is no pool state for a sandwich to sit around. A recurring swap
of predictable size on a predictable schedule against a public pool is an
invitation to be front-run - the same failure the fair book was built to remove
from the redemption side. It would be inconsistent to solve it in one place and
reintroduce it in the other.

The desk maintains an on-chain allowlist (`whitelisted-clients`, with a proposal
and cooldown before confirmation). The swap extension's contract principal is the
client. Any counterparty diligence applies to the entity behind the DAO, not to
the contract.

### 3. Fair order book, all MIA burned

Clone `mia-fair-faktory-v2` as a DAO extension with one behavioural change: the
below-par spread is burned rather than retained.

Everything else is preserved as deployed and proven - the sorted offer book,
insertion sort, partial fills, cheapest-first settlement, cancel-any-time, and
the cap that prevents the settler from profiting above par.

The accounting consequence of burning the spread: a fill retires a claim worth
`ratio * amount` on the treasury while paying only the seller's discounted ask.
Because the payment comes from staking yield and never debits the STX treasury,
the treasury `T` is unchanged and only supply `S` shrinks:

```
ratio_before = T / S            ratio_after = T / (S - burned)
```

The full retired claim accrues to holders who did not sell. The discount does not
create that surplus - it sets how much MIA is retired per STX of yield, which is
why the book fills cheapest first.

### 4. Disclosure

The RFQ desk named above is built and operated by Rapha (fak.fun / Jing Swap). It
received a Stacks Endowment grant, and CityCoins volume routed through it would
help bootstrap a market maker on that desk. The author benefits if this route is
chosen.

The design does not depend on that specific desk. Any venue that commits a price
before settling would satisfy the same requirement, and the author is willing to
help implement an alternative if the community prefers one. This is stated so the
recommendation can be weighed accordingly, not to pre-empt the choice.

## Rationale

**Why not denominate the book in sBTC?** Par is not a market price. It is treasury
arithmetic: a known quantity of STX behind a known supply of MIA, checkable by
anyone. Nothing backs MIA in sBTC, so an sBTC par would have to be manufactured
from an external price rather than derived from the treasury. Holders would be
redeeming against an estimate instead of against the backing. That is a change in
what the guarantee means, not merely in what it is denominated in.

**Why not distribute sBTC directly to redeemers?** Same problem in a different
place. It requires a MIA/sBTC price at distribution time, which has to come from
an oracle, and an oracle on a known schedule carries the same manipulation
surface as a swap on a known schedule.

**Why burn the spread instead of seeding liquidity?** Seeding a MIA/sBTC pool is a
reasonable use and would create a second venue for MIA, which has value. But it
requires the DAO to hold and manage a position, decide who supplies the paired
side, and accept impermanent loss. Burning is simpler, needs no ongoing decision,
and distributes the benefit to every holder in proportion rather than to whoever
participates. If the community prefers the liquidity route, that is a separate
proposal and should be voted on its own merits.

**Why keep a human in the loop at all?** Ideally, none is needed. Every step above
is permissionless by design so that no single person has to be available for
rewards to reach holders. That was the point of the PoX-5 upgrade, and it is the
standard this proposal holds itself to.

## Open questions for the community

1. **Ratio.** Fix at the measured value on execution day, or recompute at
   redemption time? This proposal recommends fixing it.
2. **Spread.** Burn it, as proposed, or continue capturing it to seed a MIA/sBTC
   pool?
3. **Swap cadence.** Per reward cycle, or accumulate and swap on a size
   threshold? Larger, less frequent swaps get better pricing but leave sBTC idle
   longer.
4. **Venue.** Ratify the RFQ desk named here, or specify the property required
   (a price committed before settlement) and let the implementation follow?

## Backwards compatibility

`ccd013-burn-to-exit-mia` and `mia-fair-faktory-v2` remain deployed and readable.
Historical redemptions are unaffected. Offers currently resting on the existing
book are unaffected by this proposal and can be cancelled by their owners at any
time; migration of resting offers to a new book, if any, should be explicit and
opt-in rather than automatic.

## Activation

Execution through `ccd001-direct-execute`, 3 of 5 approver signals, following the
pattern established by CCIP-027: the proposal enables extensions, configures
them, and authorises the treasury withdrawal, but does not perform the swap or
the settlement itself. Those are permissionless calls made separately, so
execution timing does not depend on approver availability.
