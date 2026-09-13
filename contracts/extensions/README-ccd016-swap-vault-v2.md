# CCD016 swap vault v2: sBTC rewards to STX, nobody holds a key

Decision record for `ccd016-swap-vault-mia-v2.clar` v0.3.0 (2026-09-12).
Draft, unaudited, not deployed. It binds the NEXT Jing stack, itself under
audit bounty `mtxs6nxg7a6d97081b11` (aibtc.com): `markets-sbtc-stx-jing-v6`
(pegged orders), `swap-router-sbtc-stx-jing-v5`, `jing-core-v5`, source at
github.com/Rapha-btc/jing-contracts-v3. Deploy order: that stack, then the
ccd015 STX book, then this vault at the same deployer as the book.

## What it is

A contract that holds the DAO's sBTC rewards and can do two things with
them: sell sBTC for STX and send the STX to the ccd015 redemption book, or
send the sBTC back to the rewards treasury (`dao-recall-sbtc`, by
proposal). No other destination exists. The price is never chosen by a
caller: Pyth Lazer signs it, the Jing market verifies it (80 s freshness,
confidence), and the vault refuses to act unless DIA agrees within
`dia-band-bps` (10%).

## v0.3.0: the peg, and who does what

- **Patience phase (window open, 288 burn blocks by default).** `jing-place`
  rests the sBTC on the book as a ZERO-SPREAD PEG: `deposit-token-x amount
  floor (some u0)`. The order sits at the settlement mid whatever the mid is,
  every settlement, with no one repricing it (the keeper of v1 and the
  reprice call of the first v2 cut are gone). The floor is `mid * (1 -
  leeway)` at placement: under it the order is off for that settlement, not
  filled at the floor. As a resting maker the vault pays the 10 bps book fee
  and collects the 20 bps taker rebate. Nothing can sell the vault under the
  mid while the window is open: `jing-take` is liquidation-only now.
- **Liquidation phase (window elapsed).** `jing-reclaim` brings the sBTC
  home; `router-swap` sells through the smart router (book, Bitflow DLMM,
  Bitflow XYK, Velar, split at execution) at `mid * (1 - slippage)`, 0.05
  sBTC per call, whatever no venue takes inside the floor comes home.
- **Community, three steps and nothing else:** `jing-place` while the window
  is open (in chunks until every sat rests), `jing-reclaim` then
  `router-swap` once it elapsed, `fuel-fair-book` whenever STX sits here.
- **DAO only (proposal):** `jing-refloor` (moves the guard to a fresh mid,
  live or parked, `set-token-x-limit`, no crossing allowance needed),
  `jing-take` (fill-or-kill at the floor, no chunk cap: the book settles at
  the oracle mid), `router-swap-split` (manual venue split), the settings
  (window, leeway, slippage, DIA band, chunk cap) and the recall.
- **Nobody:** the price and the destinations.

## Verification (stxer mainnet fork, real Lazer update, 2026-09-12)

`simulations/stxer-ccd016-v2-coverage.js` (`npm run sim:ccd016`,
`PYTH_API_KEY` required, `JING_SRC` points at the jing repo's contracts/).
The fork deploys core-v5, market v6 (one sim-only patch: `MAX_STALENESS`
widened so the single update survives the block advance), router v5, the
ccd015 STX book and the vault under chavita; base-dao is patched so
`is-extension` is true for the vault (treasury withdraw) and a proxy that
plays a passed proposal; DIA is impersonated from its updater key with the
Lazer prices.

| Simulation | Result | Covers |
|---|---|---|
| `8821da4c7e090564582a4fbfa62c3476` | 61/61 | fund-from-treasury opens the window; jing-place in two chunks rests `(some u0)` with floor = mid - 5% and price = mid; take / router-swap / reclaim refused while open, refloor DAO-only and working, setters gated and range-checked; a 100 STX taker fills the vault at the mid with the exact STX received (net - 10 bps + the whole rebate) and the peg rolls with its rule; fuel-fair-book moves exactly that to the book; the window elapses by proposal + block advance; reclaim by anyone; router-swap by anyone at the floor (pools), chunk cap enforced; a DAO take against a resting bid fills at the mid; recall to the treasury by proposal only; idle at the end |
| `5df232a3282ec928cfb1b6536fe7b3d0` | 58/61 | 2026-09-13 rerun against jing v6 at `b606103` (the deploy set after bounty mtxs6nxg7a6d97081b11: parked-swap refusal, sentinel skips, switched-off refusal, `distance-slots` with the N-best-prices region, demotion and one park path). No contract change here: the vault only calls deposit / cancel / withdraw / readmit and the router's swap, whose signatures are unchanged, and it already treats a parked position as resting. Every vault-on-book step is green. The three misses are S7 "router-swap 300k sats at the floor (book empty: pools)" and the two checks that follow it: the router's `u3002` min-out guard, because the AMM pools at that day's fork tip could not return the vault's floor for 300k sats. Same 58/61 with the same three misses on the pre-bounty source `f04ebb5` (`20e8e8246ee6e019e92c047ee6a57a56`), so it is the market, not the change. Rerun S7 on a day the pools sit near mid, or size it under the pools' depth at the floor |

Prior v2 cut (fixed ask at mid - leeway, `jing-reprice`) is superseded; the
fixed ask and the zero-spread peg fill in the same cycles, the peg only
differs after a drop past the floor (off instead of resting above the mid).
