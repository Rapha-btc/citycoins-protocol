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
