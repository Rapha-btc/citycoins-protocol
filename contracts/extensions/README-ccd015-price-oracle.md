# CCD015 redemption book: where the STX/BTC price comes from

Decision record for `ccd015-redemption-book-mia.clar` v0.4.0 (2026-08-25).

## The problem

Offers on the book ask in sats. Par is denominated in STX (`par-scaled`,
uSTX per micro-MIA). To decide if an ask is below par, `cross-book` needs an
STX/BTC rate. Par itself never changes: it is treasury arithmetic. Only the
rate that converts sats to uSTX is at stake.

## Decision

- **DIA sets the price.** `SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle`
  is a push oracle: DIA's updater key calls `set-multiple-values` on-chain
  every 10-50 minutes (measured 2026-08-25) for `STX/USD` and `BTC/USD`, both
  8 decimals, timestamp in milliseconds. No API key, no VAA, no relayer.
- **The native miner-commit price is the band, not the price.** The rate
  miners reveal by bidding BTC for the STX coinbase (`get-native-price`,
  inlined from the Jing RFQ market) is kept as a plausibility check only:
  DIA must land within `[native/2, native*2]`.
- **The DAO can turn the band off** (`set-band-enabled`). Then DIA is
  trusted alone and the native oracle is not read, so a broken native
  oracle can never brick crossing.

## Unit math

DIA values are USD with 8 decimals. In the contract's native scaling
(uSTX per sat, times 1e10):

```
price = BTC_USD * 1e8 / STX_USD
```

1 sat = BTC_USD / 1e16 USD and 1 uSTX = STX_USD / 1e14 USD; the 8-decimal
scales cancel. Live example (2026-08-25): BTC 78,414.36, STX 0.2582 gives
`price = 30,368,909,667,225`, i.e. 3.0369 uSTX per sat. `below-par?` is
unchanged: `ask * price < amount * par-scaled * PAR_PRICE_RATIO`.

## Two guards, both must pass

`get-price` runs both once, before any fill. If either guard fails there is
no trustworthy rate, so `cross-book` reverts before touching the book and
nothing is bought.

This is about the rate, not about offers. Offers are checked one by one in
`settle-step`: an offer at or above par is skipped and stays on the book,
and the cross continues through every cheaper offer. One offer above par
never blocks the others.

1. **Fresh** (`ERR_ORACLE_STALE`, u14014): each DIA value's timestamp must
   be at most `MAX_DIA_AGE` (2h) before the previous block's time. A dead
   feed has no error state on-chain; it only shows as an old timestamp. 2h
   clears the worst normal push gap (~50 min) with margin. The check is
   written `ts + MAX_DIA_AGE >= now` so a timestamp in the future cannot
   underflow.
2. **Plausible** (`ERR_OUT_OF_BAND`, u14015): `native/2 <= price <= native*2`.
   Catches a feed that is alive but wrong: fat finger, decimal slip,
   compromised updater. The band is wide on purpose; the RFQ backtest
   (3.5 months of mainnet commits) put the native oracle within
   -23%/+30% of the CEX mid, so a 2x band never trips on honest data.

"Now" is the previous block's timestamp (`get-stacks-block-info? time
(- stacks-block-height u1)`): the current block has no timestamp while it is
being built. Its `unwrap!` uses `ERR_NO_BLOCK_TIME` (u14016), reachable only
at height 0.

## Why not native alone

The native price is manipulation-resistant but noisy (tenure commits
autocorrelate over hours) and depends on `coinbase-ustx` being kept in step
with consensus by proposal. As the price it moves the par ceiling with every
tenure; as a band it only has to be right within 2x.

## Why not Pyth

Pyth's public relayer on Stacks went key-gated in August 2026. DIA is the
free on-chain alternative already used by Zest and ALEX.

## What a DAO proposal controls

- `set-band-enabled(bool)`: keep the native band or trust DIA alone.
- `set-coinbase-ustx(uint)`: consensus coinbase used by the native oracle
  (1000 STX since SIP-045). Only affects the band width now, not the price.
- `update-par`: unchanged.

## Errors added

| code | name | when |
|---|---|---|
| u14013 | ERR_ORACLE_DIA | DIA `get-value` failed for a key |
| u14014 | ERR_ORACLE_STALE | DIA timestamp older than 2h |
| u14015 | ERR_OUT_OF_BAND | DIA rate outside [native/2, native*2] |
| u14016 | ERR_NO_BLOCK_TIME | no previous block (height 0) |

## Verification: stxer mainnet-fork harness

`npm run sim:ccd015` runs `simulations/stxer-ccd015-oracle-coverage.js`, a
self-verifying harness against live mainnet state (75 assertions, exit 1 on
any failure). Last green run 2026-08-25, tip 8841110:

- Phase 1: https://stxer.xyz/simulations/mainnet/9170d37c585c24e3d0af83d5f55e2ceb
- Phase 2: https://stxer.xyz/simulations/mainnet/baa072bd3ba06ef2e13f231ce4b55eb5

What it covers:

- DIA-implied price equals `BTC_USD * 1e8 / STX_USD` bit for bit; native
  band probed at coinbase 1000 and 500 STX (DIA sat at 0.80x native at
  1000, 1.60x at 500: inside the band either way).
- Oracle guards with DIA impersonated from its real updater key: a 3h-old
  push -> `u14014`; STX/USD x10 -> `u14015`; STX/USD /10 -> `u14015`; each
  reverts `cross-book` with the book's sats untouched; band off accepts
  the same price with `native u0`; band on + live values restores.
- DAO gate: `update-par`, `set-band-enabled`, `set-paused` reject
  strangers (`u14000`) and accept an extension (base-dao patched on the fork
  so a proxy contract plays a passed proposal; ccd015 itself unmodified).
- `ERR_PAR_NOT_SET` on a funded book before `update-par`; pause blocks
  cross and place; min-deposit, zero ask, duplicate offer rejected.
- Both funding paths: `fund-from-treasury` (sBTC already allow-listed on
  the rewards treasury on mainnet) and a plain transfer.
- Crossing: book sorted cheapest-first; cross #1 fills A in full, B
  pro-rata, skips C (above par); sellers receive exactly their sats; MIA
  supply shrinks by exactly the amount acquired (burn); remainder stays on
  the book at the right amount/ask; `u14010` on empty budget; cross #2 fills
  the B remainder pro-rata from a plain transfer; `u14006` when only
  above-par offers remain; cancels refund every escrowed MIA.

Bug found by the harness and fixed in v0.4.0: `cross-book` declared its
sBTC allowance as `(with-ft SBTC_TOKEN "sbtc" ...)`. The asset is named
`sbtc-token`, so every payout under that allowance aborted (`u128`). The
book could not have paid a single seller.

## Not yet done

- Unaudited, not deployed.
