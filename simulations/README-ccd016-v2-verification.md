# CityCoins MIA vault v2: current-source verification

> Current 2026-09-23 v6-3 recovery and regression results: [cancel-only recovery verification](README-v6-3-recovery.md). The notes below describe the earlier verification; linked JSON artifacts now contain the current reruns.

Verified on **2026-09-18**, after the zero-block window and emergency AMM-only
changes: **423/423 Stxer checks passed** across six forks. The local runtime
suite passed **259 assertions** and reached **97/97 instrumented branch outcomes**
and **293/295 line counters** in `ccd016-swap-vault-mia-v2.clar`. Two Rendezvous
seeds passed **2,000/2,000 invariant checks**, with **zero runtime exceptions**,
**zero falsified invariants**, and **72 completed emergency batch round trips**.
No contract bug was found in these runs. Finite fuzzing and branch coverage do
not prove correctness for every input or every dependency state.

The verified vault SHA-256 is
`e2c05bf3238290a0644685654cda3d040382afe7d7e858530ddd04bcfd8b3573`.
The companion fair-book source hash is
`b3526d4ce89e615108c1b6781bf67b6f8354e3880adb404883a30fbdd36ec65f`.
The contract amendments were already committed by the owner in `392f1d4`; this
verification adds tests/docs without modifying or deploying production contracts.

## Saved mainnet-fork runs

| Scenario | Passed checks | Mainnet fork | Saved report |
| --- | --- | --- | --- |
| coverage | 96/96 | [Stxer](https://stxer.xyz/simulations/mainnet/bb914c4dcfbe02143f82254f6ba073f6) | [coverage.json](results/ccd016-v2/coverage.json) |
| happy-path | 52/52 | [Stxer](https://stxer.xyz/simulations/mainnet/05618f27dc5ceda022694c0232b65e6f) | [happy-path.json](results/ccd016-v2/happy-path.json) |
| parked | 129/129 | [Stxer](https://stxer.xyz/simulations/mainnet/36b39179ed6cee3f3caaefa8de515e45) | [parked.json](results/ccd016-v2/parked.json) |
| clock-keyless | 67/67 | [Stxer](https://stxer.xyz/simulations/mainnet/663a7679b8fb090745363ee2c843de2e) | [clock-keyless.json](results/ccd016-v2/clock-keyless.json) |
| emergency-dia | 38/38 | [Stxer](https://stxer.xyz/simulations/mainnet/4767ae9cd65169e1a3f71aac94954fc0) | [emergency-dia.json](results/ccd016-v2/emergency-dia.json) |
| emergency-native | 41/41 | [Stxer](https://stxer.xyz/simulations/mainnet/f542f550de16afa96c94bcba2239d368) | [emergency-native.json](results/ccd016-v2/emergency-native.json) |


All simulations deploy the vault at the beginning. They submit no production
transaction and move no real funds. The four legacy scenarios also deploy a
fresh Jing core/ladder/market/router using `sim-city-*` aliases: their source and
the vault dependency references are renamed only in the simulation. This avoids
duplicate-contract failures now that the original Jing names exist on mainnet.
Comment-only lines are stripped to meet deployment limits. In the three priced
legacy scenarios, the market's `MAX_STALENESS` is widened so one authentic signed
Pyth update remains usable after synthetic block advances. Those scenarios are
not evidence for the market's normal freshness deadline. DAO extension predicates
are patched only to recognize the simulated vault and passed-proposal proxy;
the vault's real DAO gate stays intact. DIA updates are seeded from the same
signed feed values to isolate vault behavior.

The two emergency scenarios deploy **exact unchanged vault and fair-book source**
and use the **real deployed Jing router, RFQ native-price getter, and AMMs**.
A real whale balance funds the real rewards treasury on the fork; the vault pulls
through `fund-from-treasury`. The DAO proxy changes window/config settings. No
Pyth update is fetched or supplied. Committed router events verify Jing allocation
and output are zero, `jing-ok` has decoded boolean type `"false"`, and unsold is zero.
The native scenario deliberately makes DIA stale/zero and the RFQ coinbase zero
using fork-only state overrides. These faults isolate fallback and fail-closed paths.

Both emergency scenarios cover unauthorized direct calls, window 0/288 transitions,
window cap, patience rejection, allocation mismatch, zero amount, over-balance,
chunk cap and tolerance cap. The DIA scenario also checks shared-burn cooldown,
full balance drain, automatic clock closure, and public forwarding of all STX to
the fair book. The keyless-clock scenario executes the real `base-dao` proposal
path and replay protection. The parked scenario checks parked/resting recovery;
the other scenarios cover maker fills, taking, reflooring, oracle gates and treasury recall.

## Numerical emergency examples

The DIA fork reads STX/USD `u28417010` (**$0.28417010**) and BTC/USD
`u8111338286200` (**$81,113.38286200**). Both feeds use eight decimals.

```clarity
price = btc-usd * 100000000 / stx-usd
```

The ratio is `u28543954083135`, or **285,439.54083135 STX/BTC**.
At the default 10% emergency tolerance, the limit is `u25689558674821`.
For 10,000 sats (0.0001 BTC), minimum output is **25.689558 STX**;
the real DLMM paid **28.664438 STX**. The next 90,000-sat sale drained the vault;
**286.644387 STX** total was forwarded to the fair book and its clock cleared.

The stale-DIA native fork returns `u30179204114029`, or
**301,792.04114029 STX/BTC**. Its lower band edge is integer floor(native / 2),
`u15089602057014`. For 10,000 sats, minimum output is **15.089602 STX**.
The real DLMM/XYK/Velar split (4,000/3,000/3,000 sats) paid **28.579370 STX**.
DIA stale by one second over the two-hour limit gives `u16036`; zero DIA gives
`u16013`; either selects native. With native coinbase also zero, the quote and
swap reject with `u16013`, keeping the unsold vault balance.

`get-dia-value` returns the positive raw feed integer after checking the timestamp.
Timestamp milliseconds are divided by 1,000; age is compared with the previous
Stacks block timestamp, not wall-clock time. Exactly 7,200 seconds old is accepted,
7,201 seconds old is stale. The local suite tests both endpoints. `get-no-pyth-price`
uses native fallback on DIA response errors; VM runtime panics are not catchable
response errors. If native returns an error or its half-price rounds to zero, it fails closed.

## Replay and local/RV coverage

Run from the repo root:

```bash
npm ci
npm run test:vault
npm run rv:vault:build
npm run rv:vault -- --seed=20260918 --bail
npm run rv:vault -- --seed=20260919 --bail

# Set JING_SRC to a checkout containing the four Jing sources.
JING_SRC=/path/to/jing/contracts node simulations/stxer-ccd016-v2-coverage.js
JING_SRC=/path/to/jing/contracts node simulations/stxer-ccd016-v2-happy-path.js
JING_SRC=/path/to/jing/contracts node simulations/stxer-ccd016-v2-parked.js
JING_SRC=/path/to/jing/contracts node simulations/stxer-ccd016-v2-clock-keyless.js
node simulations/stxer-ccd016-v2-emergency.cjs
node simulations/stxer-ccd016-v2-emergency.cjs --native
```

Priced fork scenarios accept `PYTH_API_KEY`, or obtain the same authentic signed
payload from the public Jing backend. Endpoint overrides are `STACKS_API_URL`,
`STXER_API_URL` (emergency harness), `FAKTORY_API_URL`, and `FAKTORY_API_KEY`.

See the [local suite README](../tests/vault/README.md) for every dependency rewrite,
coverage artifacts, RV seeds, invariants and limitations. The old
[2026-09-15 trace report](TRACE-COVERAGE-ccd016-swap-vault-mia-v2.md) describes the
pre-emergency source; its 35 branch nodes are a different metric from today's
97 SDK-instrumented outcomes. Do not apply that old report to the current source.

## Rerun on the current sources, and the vault fixes (L-1, #7)

ccd016 v2 vault `858b098a` (`6c6075f`), Jing market `d1e3bbad`, router
`dfc8165b`, core `67242f19`.

| sim | stxer | checks |
|---|---|---|
| coverage | [fb0fb8c0](https://stxer.xyz/simulations/mainnet/fb0fb8c0b019750dbb5a8a2e9cb458eb) | 104/104 |
| happy-path | [2c94c13c](https://stxer.xyz/simulations/mainnet/2c94c13c6ec0ef1201a3cd6de166d11d) | 58/58 |
| parked | [b35bb5b4](https://stxer.xyz/simulations/mainnet/b35bb5b487e0fef026a1568d87abe7e4) | 136/136 |
| clock-keyless | [57b32d84](https://stxer.xyz/simulations/mainnet/57b32d84db6754299df121619ce05f96) | 68/68 |
| emergency-dia | [9e3835e3](https://stxer.xyz/simulations/mainnet/9e3835e33e2c7e959b14ffc2406a36d1) | 45/45 |
| emergency-native | [f33ef902](https://stxer.xyz/simulations/mainnet/f33ef902798adec97fcc101440062594) | 48/48 |
| recovery matrix (10 forks) | see `results/v6-3-recovery/citycoins.json` | 1128/1128 |
| **vault fixes** (`stxer-ccd016-v2-fixes.js`) | [48558d46](https://stxer.xyz/simulations/mainnet/48558d46415c733aafe5e4d944495600) | 92/92 |

Expectations changed, all from the L-1 fix (a partial `router-swap` used to
revert u3002, it now sells what fits inside the floor):
- `stxer-ccd016-v2-coverage.js` S7: the 300k-cap sale asserts `sold > 8` and
  `out >= floor-out(sold - 8)` instead of the whole 300,000; the balance checks
  use `sold`; the 1,000-sat chunk is checked against a direct router probe
  from the same pool state (u16047 exactly when 8 sats or less fit); S7b
  asserts the floor on what sold and the vault's STX gain = `out`. S8b raises
  `set-slippage-bps` to 500 for the DAO split and restores 100 (S7's partial
  sale leaves the DLMM at the floor).
- `stxer-ccd016-v2-happy-path.js` B2: a partial sale is allowed; a 300 STX bid
  then rests and the next call sells the rest through the book; residual
  wallet sBTC at most 2 dust sats; the bidder cancels what is left.

The vault-fixes sim: #7 (a 1-sat pending escrow after an exact sell-out:
`close-batch` moves 1 sat home and closes with the window still open; 3 sats
still refused u16043); L-1 (3- and 8-sat sales revert u16047 without burning
the cooldown; with the pools pushed to mid - 0.5%, 2,367,338 sold and
7,632,665 kept, the next call reverts u16047, and after a bid rests 114,866
more sell). L-2 and #6 do not apply to ccd016 (its window cap stays 1008; 1009
refused u16033). #8 cannot be built since the market's M-1 fix.

The regenerated `results/ccd016-v2/coverage.json` and `happy-path.json` for
these runs are not committed here (those two files hold other uncommitted
work in this checkout).

