# Audit bounty mw4761qx68024266725f: CCIP-028 + ccd015 + ccd016

Bounty: https://aibtc.com/bounties/mw4761qx68024266725f (8,000 sats, closes 2026-11-19 23:59 UTC).
Scope: `contracts/proposals/ccip028-activate-mia-fair-redemption.clar`,
`contracts/extensions/ccd015-redemption-book-mia-stx.clar`,
`contracts/extensions/ccd016-swap-vault-mia-v2.clar`, pinned at `4688508`
(branch `review/ccip028-direct-activation`, PR citycoins/protocol#92).
Already-known findings: `contracts/extensions/README-ccd016-swap-vault-v2.md`.

73 submissions. 5 findings hold (4 Low, 1 Info), none High/Medium, none loses funds.
They are walked one at a time below, most critical first.

| # | Severity | Finding | Where | First submitter |
|---|---|---|---|---|
| 1 | Low | DAO recall is undone by a permissionless re-fund | ccd016 L350 / L381, ccip028 L22-25 | apeir `mw47kvxjb293c87a08e8` |
| 2 | Low | dust pre-arms the window: next batch skips the 288-block patience | ccd016 L393-404, L864 | Serene Loom `mw4zahm0bbf74d69325e` (best: Titanium Coda `mwaemnic62441ab15d27`) |
| 3 | Low | router-swap caller picks oracle staleness, so the rebate the vault pays rises 20 to 69 bps | ccd016 L613-647 | apeir (added to gist 5 days after submission) |
| 4 | Low | partially filled offer below min-deposit cannot reprice | ccd015 L219 | Cold Mast `mw4eymg09c517e848405` |
| 5 | Info | book has no STX recall | ccd015 L256 | apeir |

## 1. DAO recall is undone by a permissionless re-fund

**Finding.** CCIP-028 makes the vault a base-dao extension and allows sBTC on
`ccd002-treasury-mia-rewards-v3` (L22-25). `dao-recall-sbtc` (ccd016 L350)
sends the vault's sBTC back to the treasury and clears the clock
(`close-if-empty`), but leaves both switches on. `fund-from-treasury`
(ccd016 L381) is permissionless and argumentless, so anyone can pull the whole
treasury balance straight back into the vault, open a new window, and
`jing-place` puts it on the market again. The DAO's stop does not stick.

**Impact.** No loss: the sBTC can only be sold for STX into the book, as
designed. Governance just cannot pause the programme with a recall alone.

**Submitter's fixes.** (a) the recall proposal also calls
`base-dao set-extension ccd016 false`; (b) a DAO-only `funding-enabled` flag in
the vault, cleared by the recall (contract change).

**Decision: no contract change. Fix (a) is the recall procedure.** Any recall
proposal must, in this order:

```clarity
(try! (contract-call? 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.base-dao
  set-extension .ccd016-swap-vault-mia-v2 false))
(try! (contract-call? .ccd016-swap-vault-mia-v2 dao-recall-sbtc))
```

`dao-recall-sbtc` still passes after the switch-off: `is-dao-or-extension`
accepts `tx-sender = base-dao`. With the vault no longer an extension,
`withdraw-ft` on the treasury refuses it with `(err u2000)` (ERR_UNAUTHORIZED,
`ccd002-treasury-mia-rewards-v3` L23, check at L121). If sats rest on Jing,
`dao-reclaim` goes before the recall. Re-enabling later is a new proposal
(`set-extension ... true`).

**Evidence.** `simulations/stxer-ccip028-recall-fix.mjs`, mainnet fork, real
base-dao / ccd001 / 3 real approvers, 33/33:
https://stxer.xyz/simulations/mainnet/539ad8dec22f78f220d0ceb19b4aa7c9

- control, recall only: stranger `fund-from-treasury` -> `(ok ... amount u100000 ... opened true)`, vault holds 100,000 again, window open (bug reproduced)
- fix (a), set-extension false then recall: stranger `fund-from-treasury` -> `(err u2000)`, treasury keeps 100,000, vault 0

**Verdict.** Valid, new, Low. Payout: TBD.

## 2. Dust opens the window first, so a real batch loses its rest

**Finding.** An attacker sends dust (e.g. 500 sats, under the Jing minimum) to
the treasury and calls `fund-from-treasury`: the vault was empty, so the
288-block window opens. The real reward batch arrives later and joins that
open window (`opened false`), so it gets little or no 2-day rest at the mid.
Once the window passes, anyone `jing-reclaim`s and `router-swap`s it at the
floor (mid -1%), about 1% of every batch to arbs. Same with no attacker: a
batch that sells out leaving 3-8 sats keeps its window open for the next one.

**Submitters.** First: Serene Loom `mw4zahm0bbf74d69325e` (sell-out dust).
Best: Titanium Coda `mwaemnic62441ab15d27` (attacker seed, test, fix).

**Their fix.** Restart an open window when the new amount is at least what the
vault holds. Alone, that lets anyone wait until the batch is almost sold and
restart the clock with dust, forever.

**Second case.** The dust seed (more than 8 sats) stays until the window
passes. The old rule keeps a passed window when more than 8 sats are left, so
a real batch arriving later joins the passed window and can be dumped at once,
with no rest at all.

**Decision: code fix.** In `fund-from-treasury`, the window, open OR already
passed, restarts when the new amount is at least what the vault holds (wallet
+ market) AND at least `MIN_RESTART_SATS` (500k sats). `ea7621c` covered the
open window; dropping `(window-open)` covers the passed one:

```clarity
(and (>= amount MIN_RESTART_SATS)
  (>= amount (+ (sbtc-balance) (market-total)))
)
```

Why it holds:
- A normal batch (a few million sats) is over 500k and bigger than any dust
  in the vault, so it always restarts the clock and gets its full 2 days.
- Dust under 500k cannot move the clock.
- With 1M sats in the vault, a restart needs at least 1M: the amount must be
  at least what is held.
- Restarting means donating that amount to the DAO, which then rests and
  sells it too. Nobody gains: the only effect is the DAO's sBTC resting at
  the mid longer.
- The old 1-sat re-arm attack (mu0oy1) stays blocked: re-arming a real
  leftover costs at least that leftover, and at least 500k.

**Evidence.** `simulations/stxer-ccd016-window-restart.mjs` (mainnet fork):
original vault 18/18 reproduces the bug
(https://stxer.xyz/simulations/mainnet/0654eb5b4b73d4a30676a76dd0eba540),
fixed vault 21/21 (https://stxer.xyz/simulations/mainnet/3f9c7dc53f744f804bbbfa3d4a58a07a):
50k and 200k do not move the clock, the 10M batch restarts it.

**Rename, `e008779`.** The flag in `fund-from-treasury` that decides whether
a new window opens was called `empty`; it now also covers restarts, so it is
`can-open-window` (`(and can-open-window (open-window))`). The printed field
stays `opened`.

**Open.** The sim above covers the open-window case only; the passed-window
case and the full vault suites run at the end, with all fixes.

**Verdict.** Valid, new, Low. Payout: TBD.

## 3. `router-swap` caller picks how old the price is

**Finding.** `router-swap` (ccd016) is permissionless and takes the caller's
Lazer update. The Jing market's taker rebate grows with the update's age: 20
bps up to 30 s, then 1 bp/s up to 70 bps (`rebate-bps-for-age`, markets v6-5
L10-15). A bidder rests an STX bid at the mid and calls `router-swap` every
block with the stalest accepted update: the vault pays about 0.5% more rebate
on each sale, to that bidder (apeir: -48.7 bps on 100k sats).

**Submitter.** apeir `mw47kvxjb293c87a08e8` (added to the gist 2026-11-11,
after the 11-06 submission).

**Their fix = decision.** `router-swap` rejects an update whose rebate is
above the base rate (older than 30 s):

```clarity
(asserts! (<= (contract-call? JING_MARKET get-taker-rebate-bps-for update)
  JING_BASE_REBATE_BPS
) ERR_STALE_UPDATE)
```

`JING_BASE_REBATE_BPS u20` is a vault constant (the market's
`TAKER_REBATE_BPS`), `ERR_STALE_UPDATE u16048`. `router-swap-split` and
`jing-take` are DAO-only and unchanged. The check decodes the payload (no
signature verify); doing it inside the vault would cost the same decoder call.

**Evidence.** `simulations/stxer-ccd016-router-stale.mjs` 26/26
(https://stxer.xyz/simulations/mainnet/9fdd2827975975197ee3ab89dc54db42): an
update 50 s old (market rebate u40) -> `(err u16048)`, vault balance and
cooldown unchanged; a fresh update (rebate u20) -> ok. router-swap, 100k sats:
runtime 5,724,737, read_count 451.

**Verdict.** Valid, new, Low. Payout: TBD.

## 4. A partly filled offer under min-deposit cannot reprice

**Finding.** A partial fill (`settle-step`) can leave an offer under
`min-deposit` (100k MIA). `change-offer` (ccd015) checked the minimum on the
offer's total even when the seller added nothing, so that leftover could not
change its price (u15005); the only way out was `cancel-offer`.

**Impact.** No loss: cancel refunds everything. Par only goes up, so a
leftover is never pushed out of range; the seller just cannot lower the ask to
fill faster. Info.

**Submitter.** Cold Mast `mw4eymg09c517e848405` (right claim, wrong lines).

**Fix = decision.** Check the minimum only when MIA is added:

```clarity
(asserts! (or (is-eq adding u0) (>= namount (var-get min-deposit)))
  ERR_BELOW_MIN_DEPOSIT
)
```

`cur` is the seller's offer in the book, `(get amount cur)` the MIA still in
it, `namount` that plus what is added now. Repricing creates no new slot.

**Evidence.** `simulations/stxer-ccd015-change-offer-partial.mjs` 28/28
(https://stxer.xyz/simulations/mainnet/b32a585626805236092e3f2cd54cec30): a
partial cross leaves 60k MIA; reprice without adding -> ok; adding 10k (total
70k) -> `(err u15005)`; cancel refunds exactly 60k. **Verdict.** Valid, new, Info.

## 5. The book has no STX recall

**Finding.** Once the vault sends STX to the book (`fuel-fair-book`),
`cross-book` buying MIA at or below par is the only way it leaves. If no
seller ever offers, the STX sits in the book and the DAO cannot take it back.

**Submitter.** apeir `mw47kvxjb293c87a08e8`.

**Fix = decision.** New DAO-only `dao-recall-stx` in ccd015: sends the whole
STX balance to `ccd002-treasury-mia-mining-v3`. Mining treasury, not rewards:
par already counts it as MIA backing, and on rewards-v3 the still-enabled
ccd013 could pay it out. Sellers are paid at fill time, so the book's STX is
all unspent budget.

**Evidence.** `simulations/stxer-ccd015-dao-recall-stx.mjs` 32/32
(https://stxer.xyz/simulations/mainnet/3e1d8f1a7691434bd6c12267a80d23e7):
stranger, deployer, seller and approver -> `(err u15000)`; 3-approver proposal
empties 250 STX to mining-v3 (+250 exactly); empty book -> `(err u15010)`.
**Verdict.** Valid, new, Info.

## Winner and payouts

**Winner: Titanium Coda (`mwaemnic62441ab15d27`, SP2J2CG070HCGYZ665T8KSXTS5XFTZB02QF3057FT).**
#2 is the most critical finding: the attack removes the resting period
entirely, so the DAO's whole reward batch can be dumped at the floor (mid -1%)
with no time at the mid, every batch, for a few sats. It needed a real code
fix. Titanium Coda's report is the strongest version: an attacker seed that
works from the very first batch, a Clarinet test with a control, and a tested
fix (we added the 500k minimum and the passed-window case on top).
#1 (apeir) loses nothing: the DAO's stop just does not stick, and it is fixed
by procedure, no code. #3 and #5 (apeir) are Low/Info. #4 (Cold Mast) is a
detail: the seller can always cancel.

The aibtc board shows apeir (`mw47kvxjb293c87a08e8`) as accepted: it was
picked first, and the board does not allow changing the winner after that.

Payouts from the poster wallet SP3EKD9VTV30VBC7SVMC34K2MN7PE14KQDBPHF8VH (sBTC):

| To | Sats | Tx |
|---|---:|---|
| Titanium Coda | 2,000 | 483d04fe19fc0d1be164fcea5f43ea7f3312e7d12804c5f3124721556739ea21 |
| Cold Mast | 2,000 | 59825ab55aeb748d93c075c7b3b8d30a8aa41f85e6784d324944d9ec1c74b4be |
| apeir | 2,000 | 3d068e089c81aef91ded4f2cafc6ed228e7ea0bf72a750967216c1b8992d8973 |
| Titanium Coda (winner, 2nd tx) | 5,000 | ec27efd2f854c2dded9175458df0dc28b1c2e8805979a4da31831e009ea4612f |
| Titanium Coda (winner, 3rd tx) | 1,000 | 13d7569e25524b1d55536d361ea437258a759d1f69c2977c9a6ea1775f8e2fc6 |

Total: Titanium Coda 8,000, apeir 2,000, Cold Mast 2,000.

## Final verification (all fixes, branch feat/ccd015-redemption-book)

New sha256: ccd015 `8982d30e17db7f92cd8cdb902464d508aaa65ca389dac6bd0920a3e694c3f34a`,
ccd016 `9516a3afb21785fc4a8f9fb2a234284003b63c438d699d95a6d72750bcc49e05`,
ccip028 unchanged `8826bc5d...`.

| Sim (mainnet fork) | Checks |
|---|---|
| #1 `stxer-ccip028-recall-fix.mjs` (https://stxer.xyz/simulations/mainnet/f74d8e34954730a89df1a0e1759e9d61) | 38/38 |
| #2 `stxer-ccd016-window-restart.mjs`: open window, passed window, re-arm guard, 1M vault (4 forks) | 96/96 |
| #3 `stxer-ccd016-router-stale.mjs` | 26/26 |
| #4 `stxer-ccd015-change-offer-partial.mjs` | 28/28 |
| #5 `stxer-ccd015-dao-recall-stx.mjs` | 32/32 |
| Full activation cycle `stxer-ccip028-activation.mjs` (https://stxer.xyz/simulations/mainnet/c4da0424abed2f6f4a25d9472f1b53a8) | 47/47 |
| ccd016 v2 sims ported to live v6-5 / router v5-6: coverage 112, happy-path 55, parked 173, clock-keyless 95, fixes 93, pyth-fee 65, emergency DIA 38, native 41, maker-spread 55 | all green |
| `stxer-ccd016-v2-negatives.mjs` 123/123, `stxer-ccd015-ccip028-negatives.mjs` 52/52 | green |

#2 forks: open window (500-sat seed; 50k and 200k do not move the clock; 10M
restarts it), passed window (seed still there; 10M restarts with a fresh
batch-start), re-arm guard (100k left after the window passed: 400k and 1 sat
do not restart, 600k does), 1M vault (600k does not restart).

Not covered: `stxer-ccd016-v2-emergency.cjs --recovery` (needs the core-v6 /
ladder multisig owner); the v3 rung vault and old oracle-book sims are
obsolete on this branch. Clarinet suites are updated in a separate change.

## Router v6 rebind (Zest leg), 2026-11-19

The vault now binds `swap-router-sbtc-stx-jing-v6`. `router-swap-split` and
`router-swap-split-dia` take `zest` and `zest-ticks` after jing / amount.
New ccd016 sha256 `67cc859e005b8920c65183c5a346624fa3f2b159c2f5e8bb8b1d7d7793595935`;
ccd015 and ccip028 are unchanged. Router v6 is not on mainnet, so every fork sim
first deploys it from jing-contracts-v3 bytes (sha256 `8325e0c5...`, Clarity 5)
as SPV9K21... (`simulations/_router-v6.mjs`). Zest pool u3 does not exist on
mainnet, so splits pass zest u0 and an empty list. One zest > 0 case per split
checks that the leg is skipped and the router's min-out refuses (`u3002`).

| Suite / sim | Checks |
|---|---|
| `npm run test:vault` (runtime.mjs 327 checks + mw4761 vitest 26, 5 new zest cases) / `test:book` 2 / `test:ccip028` 11 | green |
| `stxer-ccip028-activation.mjs` with `OFFER_ASK_USTX=5000000` (https://stxer.xyz/simulations/mainnet/1a2b710441fb70a0ae4b9771ad5875d3) | 49/49 |
| recall-fix 40, window-restart 104, router-stale 28, change-offer-partial 30, dao-recall-stx 34 | green |
| v2-negatives 124, emergency DIA 42 / native 42, coverage 113, clock-keyless 96, fixes 92, pyth-fee 65, parked 174 | green |
| v2-happy-path 39/54, v2-maker-spread 51/56 | live-book state; HEAD on router v5-6 fails the same checks |

The activation sim's default 100 STX ask fails at the same check on HEAD:
the live AMMs sit more than 1% below the Lazer mid, so 100k sats raise about
8.8 STX. At the same fork height, `smart-swap-sbtc-for-stx` returns identical
fills on router v5-6 and v6.
