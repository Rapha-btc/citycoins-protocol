;; Title: CCD016 - MiamiCoin One-Way Swap Vault v3 (sBTC -> STX), keeperless, on the seated rungs
;; Version: 0.4.0 (DRAFT - unaudited, not deployed; market v6 seated band rungs)
;; Summary: Converts the DAO's sBTC rewards to STX with no operator and no oracle call of its own; anyone can drive it. STX can only reach the ccd015 book, sBTC can only return to the treasury.
;; Description:
;;   Solution 2's execution layer, third cut. v2 rested the vault's sBTC on
;;   the Jing book itself as one zero-spread peg with a floor of mid *
;;   (1 - LEEWAY) taken from a caller-supplied Lazer update: a caller chose
;;   the amount, the vault verified a price through the market and DIA on
;;   every placement, and whoever placed last wrote the floor. The audit
;;   (bounty mu0oy1vzf432efb13c31) showed the floor was a policy guard, not
;;   a security bound: the mid the market settles on is already verified,
;;   so a lower floor only decides whether the vault sells at the real price
;;   or sits unsold. v3 drops the floor, the amount and the oracle from the
;;   patience phase:
;;
;;   1. CLOCK. When fund-from-treasury finds the vault EMPTY (or with no
;;      clock at all) a batch opens and a
;;      window of WINDOW burn blocks starts (default 288 = about two days,
;;      cap one week). While a batch is on the clock, open or elapsed,
;;      nothing moves it: sBTC arriving joins the batch's phase, and an
;;      elapsed batch's leftovers stay in liquidation until the vault is
;;      empty (v2's clock let anyone re-arm the window on leftovers,
;;      forever: bounty finding). The exit that empties the vault clears
;;      the clock; close-batch does when the book sold it out by itself.
;;   2. PATIENCE PHASE (window open): the vault is a MEMBER of the four
;;      seated band rungs on the Jing ladder, jing-buy-stx-spread-0 / -10 /
;;      -20 / -30 (they rest sBTC and buy STX at the settlement mid plus
;;      their spread, guarded by the miner band the RFQ native oracle
;;      reports, floor = native / 2). jing-place takes no argument: it
;;      splits the vault's whole sBTC balance in four and deposits a
;;      quarter into each rung, so a caller chooses nothing, not the
;;      amount, not the price, not a floor. The rung holds the sats until
;;      any keeper pushes them to the market with a fresh update, so the
;;      vault itself needs no Lazer update, no DIA read, no native price
;;      here: `deposit(amount, 0x00)` is the sponsor-friendly path the
;;      rungs were built for. The seat means the rung is never parked; the
;;      spreads ladder the batch from the mid to 30 bps over it. Fills put
;;      STX in the rung; jing-claim (anyone, any phase) collects the
;;      vault's share into the vault, fuel-fair-book sends it on. A
;;      placement needs at least four times the rung minimum (400 sats):
;;      whoever donates less cannot trigger one, and there is nothing to
;;      reprice anyway.
;;   3. LIQUIDATION PHASE (window elapsed): the book did not absorb the
;;      size. Anyone may reclaim the vault's unsold sBTC from the rungs
;;      (jing-reclaim, one rung at a time as the market allows), take
;;      against the book at the floor (jing-take, DAO), or sell through the
;;      Jing smart router (book, Bitflow DLMM, Bitflow XYK, Velar, split at
;;      execution) with a floor of mid * (1 - SLIPPAGE) derived from a
;;      Lazer update the market verifies and DIA sanity-checks (the only
;;      place the vault still reads a price); whatever no venue takes inside
;;      the floor comes home unsold. A caller sizes the chunk; the floor is
;;      not theirs to move. MEV note from v2 stands: a sandwich on the AMM
;;      legs can only push our fill down to the floor, and at SLIPPAGE <=
;;      2 * venue fee it cannot clear its own fees.
;;   4. HARD-WIRED EXITS, unchanged: STX leaves only to the ccd015 book
;;      (fuel-fair-book, permissionless); sBTC leaves only back to the
;;      rewards treasury (dao-recall-sbtc, by proposal).
;;
;;   What anyone can do: jing-place while the window is open, jing-claim
;;   any time, jing-reclaim then router-swap once it elapsed, and
;;   fuel-fair-book whenever STX sits here. What a proposal controls: the
;;   window length, the slippage floor, the DIA band, the chunk cap, the
;;   recall, dao-reclaim any time, and the precise tools jing-take and
;;   router-swap-split. What nobody controls: the price (the rungs peg to
;;   the market's verified mid; the router floor comes from the same
;;   oracle) and the destinations.
;;
;;   Every deployed external principal is a fully qualified mainnet address.
;;   The four rungs are the ladder owner's canonical deploys. One reference
;;   is relative: the STX destination binds to the ccd015 book at this
;;   vault's own deployer, so vault and book ship from the same address,
;;   book first.

;; TRAITS

(impl-trait 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.extension-trait.extension-trait)

;; CONSTANTS

;; error codes

(define-constant ERR_UNAUTHORIZED (err u16000))
(define-constant ERR_NO_FUNDS (err u16006))
(define-constant ERR_NO_BUDGET (err u16010))
(define-constant ERR_INVALID_PRICE (err u16013))
(define-constant ERR_WINDOW_CLOSED (err u16030))
(define-constant ERR_WINDOW_OPEN (err u16031))
(define-constant ERR_NO_CLOCK (err u16032))
(define-constant ERR_OUT_OF_RANGE (err u16033))
(define-constant ERR_NOTHING_RESTING (err u16034))
(define-constant ERR_ORACLE_DIA (err u16035))
(define-constant ERR_ORACLE_STALE (err u16036))
(define-constant ERR_ORACLE_DIVERGED (err u16037))
(define-constant ERR_NO_BLOCK_TIME (err u16038))
(define-constant ERR_CHUNK_TOO_BIG (err u16039))
(define-constant ERR_SPLIT_MISMATCH (err u16040))
(define-constant ERR_TOO_SMALL (err u16041))
(define-constant ERR_SOME_FUNDS (err u16043))
(define-constant ERR_COOLDOWN (err u16044))

(define-constant PRICE_PRECISION u100000000)
(define-constant DECIMAL_FACTOR u100)
(define-constant BPS_PRECISION u10000)
(define-constant MAX_UINT u340282366920938463463374607431768211455)

(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant ASSET_SBTC "sbtc-token")

;; the only account sBTC can ever be returned to - same constant as ccd014/ccd015
(define-constant REWARDS_TREASURY 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-rewards-v3)

;; The only account STX can ever be sent to: the ccd015 redemption book.
;; Relative on purpose - it binds at deploy time to the book at THIS deployer,
;; so vault and book must ship from the same address, book first.
(define-constant STX_FAIR_BOOK .ccd015-redemption-book-mia-stx) ;; in prod change this to the literal

;; The Jing market on Pyth Lazer (markets-sbtc-stx-jing-v6): the venue the
;; rungs rest on and, for the liquidation phase, the price oracle. The smart
;; router splits a taker order across the book, Bitflow DLMM, Bitflow XYK
;; and Velar at execution.
(define-constant JING_MARKET 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6)
(define-constant JING_ROUTER 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jing-v5)
(define-constant WSTX_TOKEN 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2)
(define-constant ASSET_WSTX "wstx")

;; The four seated band rungs (jing-buy-stx-core-spread, ladder owner's
;; canonical deploys): each rests sBTC as a peg at mid + spread, protected
;; seat, miner-band guard. The vault is a member of all four.
(define-constant RUNG_0 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-0)
(define-constant RUNG_10 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-10)
(define-constant RUNG_20 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-20)
(define-constant RUNG_30 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-30)
;; the rung's own minimum per deposit (MIN_DEPOSIT in the rung source)
(define-constant RUNG_MIN u100)
;; a rung deposit without an update: the rung holds the sats, any keeper
;; pushes them to the market later with a fresh one
(define-constant NO_UPDATE 0x00)

;; governance caps: a proposal can tune inside these, never outside
(define-constant MAX_WINDOW_BLOCKS u1008) ;; one week: rewards land weekly, a batch must clear before the next
(define-constant MAX_SLIPPAGE_BPS u1000) ;; -10%
(define-constant MAX_DIA_BAND_BPS u5000) ;; 50%
(define-constant MAX_CHUNK_SATS u100000000) ;; 1 BTC
(define-constant MAX_COOLDOWN_BLOCKS u144) ;; one day
;; Velar's own floor: twice its 30 bps fee, so a sandwich there breaks even too
(define-constant VELAR_SLIPPAGE_BPS u60)
;; DIA pushes every 10-50 min; 2h clears the worst normal gap (see ccd015)
(define-constant MAX_DIA_AGE u7200) ;; in seconds

;; DATA VARS

;; burn blocks the patience phase lasts, from the batch's first funding
(define-data-var window-blocks uint u288)
;; floor under the oracle mid once the window has elapsed
(define-data-var slippage-bps uint u100)
;; largest single router-swap, in sats (0.05 sBTC): keeps one liquidation
;; tx under the size where a sandwich could clear its own fees
(define-data-var max-chunk-sats uint u1000000)
;; Pyth mid must sit within this of the DIA rate; 0 = DIA check off
(define-data-var dia-band-bps uint u1000)
;; burn blocks between two router sales (router-swap and router-swap-split
;; share the clock). One chunk per Bitcoin block: a bot cannot chain chunks
;; in one block to walk DLMM and XYK down to the floor and route the rest to
;; Velar, where a sandwich clears its fees (60 bps round trip under the 1%
;; floor); between blocks the pools re-arb to the mid. 0 = off.
(define-data-var router-cooldown-blocks uint u1)
(define-data-var last-router-swap uint u0)
;; burn height the current batch opened at; none while the vault is empty.
;; Set only when funding finds the vault empty (or no clock at all);
;; cleared by the exit that empties the vault, or by close-batch. Never
;; moved while a batch is on the clock, open or elapsed: an elapsed batch's
;; leftovers stay in liquidation, and sats landing next to them join it
;; (bounty finding: a free start-clock / 1-sat funding re-armed the window
;; forever; start-clock is gone, a plain transfer waits for the next
;; funding).
(define-data-var batch-start (optional uint) none)

;; PUBLIC FUNCTIONS

(define-public (is-dao-or-extension)
  (ok (asserts! (or
    (is-eq tx-sender 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.base-dao)
    (contract-call? 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.base-dao
      is-extension contract-caller
    )) ERR_UNAUTHORIZED
  ))
)

(define-public (callback (sender principal) (memo (buff 34)))
  (ok true)
)

;; --- DAO configuration -----------------------------------------------------

(define-public (set-window-blocks (blocks uint))
  (begin
    (try! (is-dao-or-extension))
    (asserts! (and (> blocks u0) (<= blocks MAX_WINDOW_BLOCKS)) ERR_OUT_OF_RANGE)
    (ok (var-set window-blocks blocks))
  )
)

(define-public (set-slippage-bps (bps uint))
  (begin
    (try! (is-dao-or-extension))
    (asserts! (<= bps MAX_SLIPPAGE_BPS) ERR_OUT_OF_RANGE)
    (ok (var-set slippage-bps bps))
  )
)

(define-public (set-max-chunk-sats (sats uint))
  (begin
    (try! (is-dao-or-extension))
    (asserts! (and (> sats u0) (<= sats MAX_CHUNK_SATS)) ERR_OUT_OF_RANGE)
    (ok (var-set max-chunk-sats sats))
  )
)

(define-public (set-dia-band-bps (bps uint))
  (begin
    (try! (is-dao-or-extension))
    (asserts! (<= bps MAX_DIA_BAND_BPS) ERR_OUT_OF_RANGE)
    (ok (var-set dia-band-bps bps))
  )
)

(define-public (set-router-cooldown (blocks uint))
  (begin
    (try! (is-dao-or-extension))
    (asserts! (<= blocks MAX_COOLDOWN_BLOCKS) ERR_OUT_OF_RANGE)
    (ok (var-set router-cooldown-blocks blocks))
  )
)

;; Governance escape hatch: a proposal returns the vault's entire unswapped
;; sBTC balance to the rewards treasury. Sats still in the rungs are
;; reclaimed first with dao-reclaim below (any phase for the DAO), then
;; recalled here.
(define-public (dao-recall-sbtc)
  (let ((balance (unwrap-panic (contract-call? SBTC_TOKEN get-balance current-contract))))
    (try! (is-dao-or-extension))
    (asserts! (> balance u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC balance))
      (try! (contract-call? SBTC_TOKEN transfer balance current-contract REWARDS_TREASURY none))
    ))
    (close-if-empty)
    (ok (print { notification: "dao-recall-sbtc", payload: { amount: balance } }))
  )
)

(define-public (dao-reclaim)
  (begin
    (try! (is-dao-or-extension))
    (reclaim-core)
  )
)

;; --- funding (the pipe from the rewards treasury) ---------------------------

;; Pull the rewards treasury's entire sBTC balance into the vault and open a
;; batch if no window is open. Permissionless and argumentless: a caller
;; controls neither amount nor destination. Requires this contract to be an
;; enabled extension (the treasury gates withdraw-ft on is-dao-or-extension)
;; and sBTC on the treasury's allowlist - both set by the enabling proposal.
(define-public (fund-from-treasury)
  (let (
      (amount (unwrap!
        (contract-call? SBTC_TOKEN get-balance REWARDS_TREASURY)
        ERR_NO_BUDGET
      ))
      ;; read BEFORE the pull: a batch opens only when the vault was empty,
      ;; or when nothing is on the clock at all (sats that landed by plain
      ;; transfer have no window of their own; they join this batch)
      (empty (or (is-empty) (is-none (var-get batch-start))))
    )
    (asserts! (> amount u0) ERR_NO_BUDGET)
    (try! (contract-call? REWARDS_TREASURY withdraw-ft
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token amount current-contract
    ))
    (and empty (open-window))
    (ok (print { notification: "fund-from-treasury", payload: {
      amount: amount, opened: empty, batch-start: (var-get batch-start),
    } }))
  )
)

;; The batch is over (the vault is empty) but its clock still shows, which
;; happens when the book sold it out with no exit call here: anyone clears
;; it so the next sats open a fresh window.
(define-public (close-batch)
  (begin
    (asserts! (is-empty) ERR_SOME_FUNDS)
    (asserts! (is-some (var-get batch-start)) ERR_NO_CLOCK)
    (var-set batch-start none)
    (ok (print { notification: "close-batch", payload: { burn-height: burn-block-height } }))
  )
)

;; --- exits (destinations hard-wired) ---------------------------------------

;; Flush the vault's entire STX balance to the ccd015 book.
;; Permissionless: no pricing, no amount, no destination.
(define-public (fuel-fair-book)
  (let ((balance (stx-get-balance current-contract)))
    (asserts! (> balance u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-stx balance))
      (try! (stx-transfer? balance current-contract STX_FAIR_BOOK))
    ))
    ;; a batch the book sold out has no exit call here: its proceeds do
    (close-if-empty)
    (ok (print { notification: "fuel-fair-book", payload: { amount: balance, book: STX_FAIR_BOOK } }))
  )
)

;; --- patience phase: a member of the four seated rungs (window open) --------

;; Split the vault's whole sBTC balance in four and deposit a quarter into
;; each seated rung (the last quarter carries the rounding remainder, so
;; nothing stays behind). No argument, no update: the rung holds the sats
;; until a keeper pushes them with a fresh one. Needs 4 x RUNG_MIN (400
;; sats) or the smallest quarter is under the rung's minimum. All four
;; deposits or none.
(define-public (jing-place)
  (let (
      (balance (sbtc-balance))
      (quarter (/ balance u4))
      (last (- balance (* quarter u3)))
    )
    (asserts! (window-open) ERR_WINDOW_CLOSED)
    (asserts! (> balance u0) ERR_NO_FUNDS)
    (asserts! (>= quarter RUNG_MIN) ERR_TOO_SMALL)
    (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC quarter))
      (try! (contract-call? RUNG_0 deposit quarter NO_UPDATE))
    ))
    (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC quarter))
      (try! (contract-call? RUNG_10 deposit quarter NO_UPDATE))
    ))
    (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC quarter))
      (try! (contract-call? RUNG_20 deposit quarter NO_UPDATE))
    ))
    (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC last))
      (try! (contract-call? RUNG_30 deposit last NO_UPDATE))
    ))
    (ok (print { notification: "jing-place", payload: {
      amount: balance, quarter: quarter, last: last,
    } }))
  )
)

;; Collect the STX the vault's shares earned from fills, from every rung
;; that owes some, into the vault (fuel-fair-book sends it on). Anyone, any
;; phase; a rung that owes nothing is skipped. Nothing else moves.
(define-public (jing-claim)
  (let (
      (r0 (did (claim-0)))
      (r10 (did (claim-10)))
      (r20 (did (claim-20)))
      (r30 (did (claim-30)))
    )
    (close-if-empty)
    (ok (print { notification: "jing-claim", payload: {
      r0: r0, r10: r10, r20: r20, r30: r30,
    } }))
  )
)

;; DAO only (no chunk cap: the book settles at the oracle mid, so one call may
;; clear a whole batch). Take against the Jing book, fill-or-kill, at the
;; liquidation floor mid * (1 - slippage). Liquidation phase only: the
;; patience phase is passive, the rungs rest at the mid and the vault takes
;; nothing, so nobody can sell it under the mid before the window elapsed.
;; The vault holds no position of its own on the market (the rungs do), so
;; the market's u1018 (a taker with resting size) cannot hit it.
(define-public (jing-take
    (amount uint)
    (update (buff 8192))
  )
  (let ((limit (floor-of (try! (current-mid update)))))
    (try! (is-dao-or-extension))
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (try! (check-amount amount))
    (let ((result (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
        (try! (contract-call? JING_MARKET swap amount limit update
          SBTC_TOKEN ASSET_SBTC WSTX_TOKEN ASSET_WSTX true
        ))
      ))))
      (close-if-empty)
      (ok (print { notification: "jing-take", payload: {
        amount: amount, limit-price: limit, out: (get token-y-received result),
      } }))
    )
  )
)

;; --- liquidation phase: reclaim + any venue at the floor (window elapsed) ----

;; Bring the vault's unsold sBTC home from the rungs (a rung's withdraw
;; settles the STX it owes first). Anyone, once the window elapsed; the DAO
;; any time via dao-reclaim. Funds can only return here, so no other check
;; is needed. A rung whose market position is not in the deposit phase
;; refuses for now and is skipped: call again after the settlement, the
;; result says which rungs are done.
(define-public (jing-reclaim)
  (begin
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (reclaim-core)
  )
)

;; Sell `amount` sats through the smart router at the floor: the router sizes
;; each venue (book at the verified mid, DLMM bin walk, XYK, Velar) so every
;; leg clears inside `limit`, and returns what nothing could take inside it
;; as `unsold`. The allowance is `amount` plus the market's minimum deposit:
;; as-contract? counts gross transfers and the router re-sells refunded dust.
(define-public (router-swap (update (buff 8192)))
  (let (
      ;; permissionless: always the whole balance or one full chunk, never a
      ;; caller-chosen sliver that burns the shared cooldown
      (amount (chunk-amount))
      (mid (try! (current-mid update)))
      (limit (floor-of mid))
      (min-out (floor-out amount limit))
      (mins (contract-call? JING_MARKET get-min-deposits))
    )
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (try! (check-amount amount))
    (try! (cooldown-tick))
    (let ((result (try! (as-contract?
        ((with-ft SBTC_TOKEN ASSET_SBTC (+ amount (get min-token-x mins))))
        (try! (contract-call? JING_ROUTER smart-swap-sbtc-for-stx amount limit
          (some update) mid min-out
        ))
      ))))
      (close-if-empty)
      (ok (print { notification: "router-swap", payload: {
        amount: amount, limit-price: limit, mid: mid,
        out: (get out result), unsold: (get unsold result),
      } }))
    )
  )
)

;; DAO only. Same liquidation sale through the router's manual entry: the caller picks
;; the jing / dlmm / xyk / velar split. Every leg's min comes from the
;; oracle: mid minus SLIPPAGE for jing, dlmm, xyk and mid minus
;; VELAR_SLIPPAGE_BPS for velar, twice each venue's fee, so a sandwich
;; breaks even on every leg (see header). A bad split only reverts; it
;; cannot fill below its floor. Same chunk cap as router-swap. The
;; allowance adds the market minimum for the book leg's refunded dust.
(define-public (router-swap-split
    (amount uint)
    (jing uint)
    (dlmm uint)
    (xyk uint)
    (velar uint)
    (update (buff 8192))
  )
  (let (
      (mid (try! (current-mid update)))
      (limit (floor-of mid))
      (velar-limit (/ (* mid (- BPS_PRECISION VELAR_SLIPPAGE_BPS)) BPS_PRECISION))
      (mins {
        dlmm: (floor-out dlmm limit),
        xyk: (floor-out xyk limit),
        velar: (floor-out velar velar-limit),
      })
      (market-mins (contract-call? JING_MARKET get-min-deposits))
    )
    (try! (is-dao-or-extension))
    (asserts! (is-eq amount (+ jing dlmm xyk velar)) ERR_SPLIT_MISMATCH)
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (asserts! (<= amount (var-get max-chunk-sats)) ERR_CHUNK_TOO_BIG)
    (try! (check-amount amount))
    (try! (cooldown-tick))
    (let ((result (try! (as-contract?
        ((with-ft SBTC_TOKEN ASSET_SBTC (+ amount (get min-token-x market-mins))))
        (try! (contract-call? JING_ROUTER swap-sbtc-for-stx amount jing limit
          (some update) none { dlmm: dlmm, xyk: xyk, velar: velar } mins
          (+ (floor-out (+ jing dlmm xyk) limit) (floor-out velar velar-limit))
        ))
      ))))
      (close-if-empty)
      (ok (print { notification: "router-swap-split", payload: {
        amount: amount, jing: jing, dlmm: dlmm, xyk: xyk, velar: velar, limit-price: limit, velar-limit: velar-limit, mid: mid,
        out: (get out result), unsold: (get unsold result),
      } }))
    )
  )
)

;; READ ONLY FUNCTIONS

(define-read-only (get-config)
  {
    window-blocks: (var-get window-blocks),
    slippage-bps: (var-get slippage-bps),
    dia-band-bps: (var-get dia-band-bps),
    max-chunk-sats: (var-get max-chunk-sats),
    router-cooldown-blocks: (var-get router-cooldown-blocks),
    last-router-swap: (var-get last-router-swap),
    rung-min: RUNG_MIN,
    jing-market: JING_MARKET,
    jing-router: JING_ROUTER,
    rungs: (list RUNG_0 RUNG_10 RUNG_20 RUNG_30),
    stx-destination: STX_FAIR_BOOK,
  }
)

(define-read-only (get-clock)
  (let ((start (var-get batch-start)))
    {
      batch-start: start,
      window-ends: (match start
        s (some (+ s (var-get window-blocks)))
        none
      ),
      window-open: (window-open),
      window-elapsed: (window-elapsed),
      burn-height: burn-block-height,
    }
  )
)

;; Read-only paths name the rungs and the token LITERALLY: to the read-only
;; checker a contract-call? through a define-constant alias is a dynamic
;; dispatch and the function is rejected as writing.
(define-read-only (get-status)
  (let (
      (p0 (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-0 get-position current-contract))
      (p10 (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-10 get-position current-contract))
      (p20 (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-20 get-position current-contract))
      (p30 (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-30 get-position current-contract))
    )
    {
      sbtc-balance: (sbtc-balance),
      stx-balance: (stx-get-balance current-contract),
      ;; unsold sats the vault's shares still hold across the four rungs
      jing-resting: (+ (get sbtc p0) (get sbtc p10) (get sbtc p20) (get sbtc p30)),
      ;; STX from fills the vault has not claimed yet
      jing-owed-stx: (+ (get stx p0) (get stx p10) (get stx p20) (get stx p30)),
      positions: { r0: p0, r10: p10, r20: p20, r30: p30 },
      empty: (is-empty),
      ;; sBTC still sitting in the rewards treasury, claimable via fund-from-treasury
      pending-treasury-sats: (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance REWARDS_TREASURY)),
    }
  )
)

;; Nothing to sell here and nothing unsold in any rung: the next funding
;; opens a new batch. STX still owed by a rung does not count: claim it
;; any time.
(define-read-only (is-empty)
  (and
    (is-eq (sbtc-balance) u0)
    (is-eq (get sbtc (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-0 get-position current-contract)) u0)
    (is-eq (get sbtc (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-10 get-position current-contract)) u0)
    (is-eq (get sbtc (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-20 get-position current-contract)) u0)
    (is-eq (get sbtc (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-buy-stx-spread-30 get-position current-contract)) u0)
  )
)

;; One DIA key, staleness-checked (lifted from ccd015). Literal principal:
;; a contract-call? through a constant is not resolvable in a read-only.
(define-read-only (get-dia-value (key (string-ascii 32)))
  (let (
      (res (unwrap! (contract-call?
        'SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle get-value key)
        ERR_ORACLE_DIA))
      ;; "now" = the previous block's timestamp (the current block has none yet)
      (last-time (unwrap! (get-stacks-block-info? time (- stacks-block-height u1)) ERR_NO_BLOCK_TIME))
      (ts (/ (get timestamp res) u1000))
      (v (get value res))
    )
    (asserts! (> v u0) ERR_INVALID_PRICE)
    (asserts! (>= (+ ts MAX_DIA_AGE) last-time) ERR_ORACLE_STALE)
    (ok v)
  )
)

;; DIA's STX/BTC rate in the market's unit (uSTX per sat * 1e10):
;; BTC_USD * 1e8 / STX_USD, the 8-decimal scales cancel (see ccd015).
(define-read-only (get-dia-price)
  (let (
      (stx-usd (try! (get-dia-value "STX/USD")))
      (btc-usd (try! (get-dia-value "BTC/USD")))
      (price (/ (* btc-usd PRICE_PRECISION) stx-usd))
    )
    (asserts! (> price u0) ERR_INVALID_PRICE)
    (ok price)
  )
)

(define-read-only (window-open)
  (match (var-get batch-start)
    s (< burn-block-height (+ s (var-get window-blocks)))
    false
  )
)

(define-read-only (window-elapsed)
  (match (var-get batch-start)
    s (>= burn-block-height (+ s (var-get window-blocks)))
    false
  )
)

;; PRIVATE FUNCTIONS

(define-private (sbtc-balance)
  (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract))
)

;; what a permissionless router-swap sells: the whole balance, or one full
;; chunk when the balance is bigger
(define-private (chunk-amount)
  (let (
      (balance (sbtc-balance))
      (chunk (var-get max-chunk-sats))
    )
    (if (<= balance chunk)
      balance
      chunk
    )
  )
)

;; A batch opens now. Callers check the vault was empty first.
(define-private (open-window)
  (var-set batch-start (some burn-block-height))
)

;; After an exit: an empty vault has no batch on the clock.
(define-private (close-if-empty)
  (and (is-empty) (var-set batch-start none))
)

;; The mid the market would settle at right now, from a signed Lazer update
;; the market itself verifies (staleness + confidence), then sanity-checked
;; against DIA: |mid - dia| <= dia * band. Liquidation phase only. Public
;; call, not read-only, because the Lazer verification writes.
(define-private (current-mid (update (buff 8192)))
  (let (
      (mid (try! (contract-call? JING_MARKET refresh-mid update)))
      (band (var-get dia-band-bps))
    )
    (asserts! (> mid u0) ERR_INVALID_PRICE)
    (if (> band u0)
      (let ((dia (try! (get-dia-price))))
        (asserts! (>= (* mid BPS_PRECISION) (* dia (- BPS_PRECISION band))) ERR_ORACLE_DIVERGED)
        (asserts! (<= (* mid BPS_PRECISION) (* dia (+ BPS_PRECISION band))) ERR_ORACLE_DIVERGED)
        (ok mid)
      )
      (ok mid)
    )
  )
)

(define-private (floor-of (mid uint))
  (/ (* mid (- BPS_PRECISION (var-get slippage-bps))) BPS_PRECISION)
)

;; STX floor for `amount` sats at `limit`: uSTX = sats * price / (1e8 * 100)
(define-private (floor-out (amount uint) (limit uint))
  (/ (* amount limit) (* PRICE_PRECISION DECIMAL_FACTOR))
)

;; one router sale per cooldown; stamps the height on the way through
(define-private (cooldown-tick)
  (begin
    (asserts! (>= burn-block-height (+ (var-get last-router-swap) (var-get router-cooldown-blocks))) ERR_COOLDOWN)
    (ok (var-set last-router-swap burn-block-height))
  )
)

(define-private (check-amount (amount uint))
  (begin
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (asserts! (<= amount (sbtc-balance)) ERR_NO_FUNDS)
    (ok true)
  )
)

;; A rung call's answer as one bool: (ok true) moved something, (ok false)
;; had nothing to move, an err (the market refused for now) is false too.
(define-private (did (r (response bool uint)))
  (match r
    d d
    e false
  )
)

;; One rung: withdraw everything the vault's shares still hold there (the
;; rung settles the STX it owes first); nothing unsold but STX owed ->
;; claim; nothing at all -> (ok false). A refusal (market not in its deposit
;; phase) is the rung's error, the caller skips this rung for now.
(define-private (reclaim-0)
  (let ((p (contract-call? RUNG_0 get-position current-contract)))
    (if (> (get sbtc p) u0)
      (as-contract? () (try! (contract-call? RUNG_0 withdraw MAX_UINT)))
      (if (> (get stx p) u0)
        (as-contract? () (try! (contract-call? RUNG_0 claim)))
        (ok false)
      )
    )
  )
)
(define-private (reclaim-10)
  (let ((p (contract-call? RUNG_10 get-position current-contract)))
    (if (> (get sbtc p) u0)
      (as-contract? () (try! (contract-call? RUNG_10 withdraw MAX_UINT)))
      (if (> (get stx p) u0)
        (as-contract? () (try! (contract-call? RUNG_10 claim)))
        (ok false)
      )
    )
  )
)
(define-private (reclaim-20)
  (let ((p (contract-call? RUNG_20 get-position current-contract)))
    (if (> (get sbtc p) u0)
      (as-contract? () (try! (contract-call? RUNG_20 withdraw MAX_UINT)))
      (if (> (get stx p) u0)
        (as-contract? () (try! (contract-call? RUNG_20 claim)))
        (ok false)
      )
    )
  )
)
(define-private (reclaim-30)
  (let ((p (contract-call? RUNG_30 get-position current-contract)))
    (if (> (get sbtc p) u0)
      (as-contract? () (try! (contract-call? RUNG_30 withdraw MAX_UINT)))
      (if (> (get stx p) u0)
        (as-contract? () (try! (contract-call? RUNG_30 claim)))
        (ok false)
      )
    )
  )
)

;; Every rung, each on its own: one refusing does not hold the others.
(define-private (reclaim-core)
  (let (
      (r0 (did (reclaim-0)))
      (r10 (did (reclaim-10)))
      (r20 (did (reclaim-20)))
      (r30 (did (reclaim-30)))
    )
    (asserts! (or r0 r10 r20 r30) ERR_NOTHING_RESTING)
    (close-if-empty)
    (ok (print { notification: "jing-reclaim", payload: {
      r0: r0, r10: r10, r20: r20, r30: r30, sbtc-balance: (sbtc-balance),
    } }))
  )
)

;; One rung: the STX it owes the vault, if any; (ok false) when none.
(define-private (claim-0)
  (if (> (get stx (contract-call? RUNG_0 get-position current-contract)) u0)
    (as-contract? () (try! (contract-call? RUNG_0 claim)))
    (ok false)
  )
)
(define-private (claim-10)
  (if (> (get stx (contract-call? RUNG_10 get-position current-contract)) u0)
    (as-contract? () (try! (contract-call? RUNG_10 claim)))
    (ok false)
  )
)
(define-private (claim-20)
  (if (> (get stx (contract-call? RUNG_20 get-position current-contract)) u0)
    (as-contract? () (try! (contract-call? RUNG_20 claim)))
    (ok false)
  )
)
(define-private (claim-30)
  (if (> (get stx (contract-call? RUNG_30 get-position current-contract)) u0)
    (as-contract? () (try! (contract-call? RUNG_30 claim)))
    (ok false)
  )
)
