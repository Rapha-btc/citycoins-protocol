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

**Evidence.** Pending stxer sim.

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

**Evidence.** Pending sim. **Verdict.** Valid, new, Info. Payout: TBD.

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

**Evidence.** Pending sim. **Verdict.** Valid, new, Info. Payout: TBD.
