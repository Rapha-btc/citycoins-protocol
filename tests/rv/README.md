# Rendezvous (RV) property fuzzing: Solution 2

`@stacks/rendezvous@1.0.0-rc.1` harness for the STX book
(`ccd015-redemption-book-mia-stx`) and the keeperless vault
(`ccd016-swap-vault-mia-v2`). Same shape as jing-contracts-v3's
`tests/rv`: production source, a few fuzz rewrites, an invariants block
appended, one RV-only manifest per target at the repo root.

## Status (2026-09-15, zero falsified invariants)

| target | runs | invariants (checks) | real movement (successful calls) |
|---|---|---|---|
| ccd015-redemption-book-mia-stx | 500 | 7 (500) | place-offer x74 + rv-place x117, change-offer x16, cancel-offer x22, cross-book x89, update-par x29, set-min-deposit x30, set-paused x22, rv-fund x245 |
| ccd016-swap-vault-mia-v2 | 500 | 6 (500) | fund-from-treasury x60, dao-recall-sbtc x13, fuel-fair-book x7, router-swap x8, jing-place x1, dao-reclaim x1, setters x1-6, rv-bid x87, rv-cancel-bid x39, DIA skew / stale x109 / x103. Thin on the vault's own book paths (jing-place, take, reclaim, refloor): the 20-block window elapses inside most runs (one block per call) and DIA / staleness switches persist across RV's shared simnet; the fork harnesses (`simulations/stxer-ccd016-v2-*.js`) cover those paths end to end |

## Build

`tests/rv/build.sh` rewrites, for both: the DAO gate (`is-dao-or-extension`)
to the deployer account, one RV sender in ten, and drops the extension
trait line (no requirements are fetched for these manifests).

For the book: MIA v2 (transfer, burn, supply) and v1 (supply) become
`mock-mia` (real ledger under the name `miamicoin`, auto-mint for RV's
random sellers, burn counted) and `mock-mia-v1`; the par formula's two STX
accounts (mining treasury, pox5 stake) become two funded simnet wallets;
the minimum deposit is 1000 micro-MIA (100k MIA is above every natural RV
draws). Wrappers: `rv-fund` (STX in, the vault's push, counted),
`rv-place` (an offer sized over the minimum), `rv-reset-min` (a random
DAO `set-min-deposit` up to 2^31 would otherwise refuse every later offer
for the rest of the sweep).

For the vault: the jing v6 fuzz stack is copied in from
`../jing-contracts-v3/tests/rv` (set `JING_RV` otherwise): the market's
fuzz build with settle live through the mock Lazer oracle, the mock
ladder, the v5 mock core, one `mock-ft` for sBTC and wstx. The rewards
treasury is `mock-treasury` (withdraw-ft, no gate), the router is
`mock-router` (one venue that buys at the mid with the STX it holds, or
reports everything unsold; u3002 on min-out), DIA is `mock-dia` (echoes
the Lazer mid times a skew, staleness switchable), the STX destination is
the book's fuzz build, the window is 20 burn blocks. Wrappers: sBTC into
the treasury and by plain transfer, STX into the router, bids resting on
the market and cancelling, settlements, the mid, the mid onto the vault's
floor, DIA skew (85..115%, the band is 10%) and staleness (one call in
eight).

## Invariants

Book, 7: sorted ascending by price (cross-multiplied), MIA conservation
(book balance = sum of the amounts on the book), STX conservation (balance
= funded minus spent), burned equals what the token burned, one offer per
owner, bounded, every entry positive and inside the per-offer caps.

Vault, 6: open and elapsed never both, no clock means neither, every dial
inside its cap and the window never zero, the cooldown stamp never in the
future, whatever rests on the book is a zero-spread peg with a guard, a
clock is never in the future. The vault keeps no ledger of its own
(balance-driven by design); the market's 25 invariants cover the funds
while they sit on the book (fuzzed in the jing repo).

## Run

```bash
npm i -D @stacks/rendezvous@1.0.0-rc.1      # once
npm run rv:build                            # both targets (needs the jing repo next door)
npm run rv:ccd015
npm run rv:ccd016
npx rv . ccd015-redemption-book-mia-stx invariant --seed=<n>   # replay
```

Runtime panics only log in RV (`(runtime)` in the call log); a false
invariant is the finding. `.build/` and `.rendezvous-regressions/` are
gitignored.
