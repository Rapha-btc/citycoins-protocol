;; Title: CCD016 - MiamiCoin One-Way Swap Vault v2 (sBTC -> STX), keeperless
;; Version: 0.2.0 (DRAFT - unaudited, not deployed)
;; Summary: Converts the DAO's sBTC rewards to STX at an oracle-bound price with no operator; anyone can drive it. STX can only reach the ccd015 book, sBTC can only return to the treasury.
;; Description:
;;   Solution 2's execution layer, second cut. v1 needed a DAO-appointed keeper
;;   and a signing key: two humans in the loop for every trade. v2 removes
;;   both. The price never comes from a caller; it comes from the Pyth Lazer
;;   update the deployed Jing market verifies (the same feed the market
;;   settles on, fetched from jingswap's backend by whoever calls). With the
;;   price pinned by the oracle and the direction pinned by the code, there
;;   is nothing left for a caller to choose except WHEN, and a clock bounds
;;   that too:
;;
;;   1. CLOCK. When sBTC arrives (fund-from-treasury, or a plain transfer
;;      followed by start-clock) and the vault was idle, a batch opens and a
;;      window of WINDOW burn blocks starts (default 288 = about two days,
;;      cap one week). sBTC arriving while the window is open joins the
;;      batch without resetting it; sBTC arriving after it elapsed opens a
;;      fresh window, and any leftover from the old batch rides along into
;;      the new patience phase. That is the whole clock: one height, moved
;;      only by funding, only when no window is open.
;;   2. PATIENCE PHASE (window open): maker-first on the Jing market. Anyone
;;      may rest the vault's sBTC on the book at mid * (1 - LEEWAY), reprice
;;      the resting position to a fresh mid * (1 - LEEWAY), or take against
;;      the book at that limit when bids already sit there. The limit is a
;;      floor, not the price: the book settles an in-range ask at the mid, so
;;      the vault receives the mid whenever the mid is at or above its limit.
;;      LEEWAY = 5% keeps the ask in range through a 5% drop between the
;;      update and settlement instead of falling out of the batch. It does
;;      NOT sell 5% cheap: as long as the settlement mid is at or above the
;;      limit set at placement, the fill is at that settlement mid, not at
;;      mid minus leeway. The leeway is only paid in the case it exists for,
;;      a mid that fell by up to 5%, and then only the actual drop.
;;      Why maker-first: the vault fills at the oracle mid, i.e. the CEX
;;      price with no AMM curve or slippage, and as a resting maker it pays
;;      the 10 bps book fee while collecting the 20 bps taker rebate when a
;;      taker crosses it: net +10 bps on top of CEX execution.
;;   3. LIQUIDATION PHASE (window elapsed): the market did not absorb the
;;      size. Anyone may reclaim the resting deposit and sell through the
;;      Jing smart router (book, Bitflow DLMM, Bitflow XYK, Velar, split at
;;      execution) with a floor of mid * (1 - SLIPPAGE) derived from the same
;;      oracle update; whatever no venue takes inside the floor comes home
;;      unsold. A caller sizes the chunk; the floor is not theirs to move.
;;      MEV, open question (code unchanged for now): a sandwich on the AMM
;;      legs can only push our fill down to the floor, because the limit is
;;      the oracle's, not the pool's. So the most a bot extracts is
;;      SLIPPAGE * chunk, and it pays the venue fee twice to do it (Bitflow
;;      XYK and DLMM 50 bps a side, Velar 30). The invariant that makes a
;;      sandwich unprofitable at ANY size is SLIPPAGE <= 2 * venue fee:
;;      at the 1% floor XYK and DLMM sit exactly at break-even, Velar needs
;;      0.6% (60 bps round trip). The manual entry prices each leg's min
;;      itself, so its Velar leg gets the 0.6% floor (VELAR_SLIPPAGE_BPS).
;;      The smart router takes one limit for every venue, so a slice it
;;      routes to Velar carries the 1% floor; that exposure is bounded by
;;      the chunk cap to at most 0.4% of 0.05 sBTC per call, a few dollars.
;;      Last measured, a bot needed ~15k USD of sBTC per chunk to clear its
;;      costs. A cooldown of N burn blocks between router swaps is the next
;;      lever if ever needed. The Jing leg is not sandwichable: it
;;      settles at the oracle mid.
;;   4. HARD-WIRED EXITS, unchanged from v1: STX leaves only to the ccd015
;;      book (fuel-fair-book, permissionless); sBTC leaves only back to the
;;      rewards treasury (dao-recall-sbtc, by proposal).
;;
;;   What a proposal controls: the window length, the leeway, the slippage
;;   floor, the DIA band, and the recall. What nobody controls: the price
;;   (Pyth sets it, DIA sanity-checks it) and the destinations. What anyone
;;   can do: push the pipeline one step forward.
;;
;;   Oracle: the Jing market's `refresh-mid (update)` verifies a signed Lazer
;;   update (max age 80 s, confidence required) and returns the mid in the
;;   market's price unit (micro-STX per sat, times 1e10). A stale or
;;   unsigned update reverts inside the market, so no call here can run on a
;;   price the oracle did not sign for. Sanity check, kept simple: the mid
;;   must sit within DIA_BAND (10%) of the DIA push oracle's own STX/BTC rate
;;   (BTC/USD over STX/USD, both fresh within 2h), the same free on-chain
;;   feed ccd015 prices on. Two independent oracles agreeing within 10% is
;;   the whole guard; no native miner-commit band here. A proposal can widen
;;   the band or set it to 0 to trust Pyth alone if DIA dies.
;;
;;   Every deployed external principal is a fully qualified mainnet address.
;;   One reference is relative: the STX destination binds to the ccd015 book
;;   at this vault's own deployer, so vault and book ship from the same
;;   address, book first.

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

(define-constant PRICE_PRECISION u100000000)
(define-constant DECIMAL_FACTOR u100)
(define-constant BPS_PRECISION u10000)

(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant ASSET_SBTC "sbtc-token")

;; the only account sBTC can ever be returned to - same constant as ccd014/ccd015
(define-constant REWARDS_TREASURY 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-rewards-v3)

;; The only account STX can ever be sent to: the ccd015 redemption book.
;; Relative on purpose - it binds at deploy time to the book at THIS deployer,
;; so vault and book must ship from the same address, book first.
(define-constant STX_FAIR_BOOK .ccd015-redemption-book-mia-stx) ;; in prod change this to the literal

;; The deployed Jing market on Pyth Lazer (markets-sbtc-stx-jing-v4 lineage):
;; the maker venue and the price oracle. The smart router splits a taker
;; order across the book, Bitflow DLMM, Bitflow XYK and Velar at execution.
(define-constant JING_MARKET 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jingswap)
(define-constant JING_ROUTER 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jingswap-v1)
(define-constant WSTX_TOKEN 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2)
(define-constant ASSET_WSTX "wstx")

;; governance caps: a proposal can tune inside these, never outside
(define-constant MAX_WINDOW_BLOCKS u1008) ;; one week: rewards land weekly, a batch must clear before the next
(define-constant MAX_LEEWAY_BPS u1000) ;; 10% under the mid
(define-constant MAX_SLIPPAGE_BPS u1000) ;; -10%
(define-constant MAX_DIA_BAND_BPS u5000) ;; 50%
(define-constant MAX_CHUNK_SATS u100000000) ;; 1 BTC
;; Velar's own floor: twice its 30 bps fee, so a sandwich there breaks even too
(define-constant VELAR_SLIPPAGE_BPS u60)
;; DIA pushes every 10-50 min; 2h clears the worst normal gap (see ccd015)
(define-constant MAX_DIA_AGE u7200) ;; in seconds

;; DATA VARS

;; burn blocks the patience phase lasts, from the batch's first funding
(define-data-var window-blocks uint u288)
;; resting ask under the oracle mid while the window is open (5%)
(define-data-var leeway-bps uint u500)
;; floor under the oracle mid once the window has elapsed
(define-data-var slippage-bps uint u100)
;; largest single router-swap, in sats (0.05 sBTC): keeps one liquidation
;; tx under the size where a sandwich could clear its own fees
(define-data-var max-chunk-sats uint u5000000)
;; Pyth mid must sit within this of the DIA rate; 0 = DIA check off
(define-data-var dia-band-bps uint u1000)
;; burn height the current batch opened at; none until the first funding.
;; Set on funding when no window is open (none, or elapsed); never moved
;; while a window is open.
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

(define-public (set-leeway-bps (bps uint))
  (begin
    (try! (is-dao-or-extension))
    (asserts! (<= bps MAX_LEEWAY_BPS) ERR_OUT_OF_RANGE)
    (ok (var-set leeway-bps bps))
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

;; Governance escape hatch: a proposal returns the vault's entire unswapped
;; sBTC balance to the rewards treasury. A resting Jing deposit is reclaimed
;; first with dao-reclaim below (any phase for the DAO, deposit phase for the
;; market), then recalled here.
(define-public (dao-recall-sbtc)
  (let ((balance (unwrap-panic (contract-call? SBTC_TOKEN get-balance current-contract))))
    (try! (is-dao-or-extension))
    (asserts! (> balance u0) ERR_NO_FUNDS)
    (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC balance))
      (try! (contract-call? SBTC_TOKEN transfer balance current-contract REWARDS_TREASURY none))
    ))
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
;; batch if the vault was idle. Permissionless and argumentless: a caller
;; controls neither amount nor destination. Requires this contract to be an
;; enabled extension (the treasury gates withdraw-ft on is-dao-or-extension)
;; and sBTC on the treasury's allowlist - both set by the enabling proposal.
(define-public (fund-from-treasury)
  (let ((amount (unwrap!
      (contract-call? SBTC_TOKEN get-balance REWARDS_TREASURY)
      ERR_NO_BUDGET
    )))
    (asserts! (> amount u0) ERR_NO_BUDGET)
    (try! (contract-call? REWARDS_TREASURY withdraw-ft
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token amount current-contract
    ))
    (open-window)
    (ok (print { notification: "fund-from-treasury", payload: {
      amount: amount, batch-start: (var-get batch-start),
    } }))
  )
)

;; sBTC that arrived by plain transfer has no window; anyone opens one.
;; Refused while a window is open, so this cannot be used to reset a clock.
(define-public (start-clock)
  (begin
    (asserts! (not (is-idle)) ERR_NO_FUNDS)
    (asserts! (not (window-open)) ERR_WINDOW_OPEN)
    (open-window)
    (ok (unwrap-panic (var-get batch-start)))
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
    (ok (print { notification: "fuel-fair-book", payload: { amount: balance, book: STX_FAIR_BOOK } }))
  )
)

;; --- patience phase: Jing maker-first (window open) -------------------------

;; Rest `amount` sats on the Jing book at mid * (1 - leeway). The market
;; refuses a resting limit that live bids already cross (ERR_MUST_USE_SWAP
;; u1022); use jing-take then. Merges into an existing resting position and
;; refreshes its limit.
(define-public (jing-place
    (amount uint)
    (update (buff 8192))
  )
  (let ((limit (ask-of (try! (current-mid update)))))
    (asserts! (window-open) ERR_WINDOW_CLOSED)
    (try! (check-amount amount))
    (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
      (try! (contract-call? JING_MARKET deposit-token-x amount limit update
        SBTC_TOKEN ASSET_SBTC
      ))
    ))
    (ok (print { notification: "jing-place", payload: { amount: amount, limit-price: limit } }))
  )
)

;; Reprice the resting position to a fresh oracle limit: mid * (1 - leeway)
;; while the window is open, mid * (1 - slippage) once it elapsed. If the new
;; limit crosses resting STX size the market takes on the spot
;; (fill-or-kill). The allowance is the taker rebate on the resting size,
;; the only thing the crossing path can pull from the vault.
(define-public (jing-reprice (update (buff 8192)))
  (let (
      (limit (phase-limit (try! (current-mid update))))
      (cycle (contract-call? JING_MARKET get-current-cycle))
      (resting (contract-call? JING_MARKET get-token-x-deposit cycle current-contract))
      (rebate (/ (* resting (contract-call? JING_MARKET get-taker-rebate-bps))
        BPS_PRECISION
      ))
    )
    (asserts! (> resting u0) ERR_NOTHING_RESTING)
    (let ((result (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC rebate))
        (try! (contract-call? JING_MARKET reprice-or-swap-token-x limit update
          SBTC_TOKEN ASSET_SBTC WSTX_TOKEN ASSET_WSTX
        ))
      ))))
      (ok (print { notification: "jing-reprice", payload: {
        resting: resting, limit-price: limit, out: (get token-y-received result),
      } }))
    )
  )
)

;; Take against the Jing book, fill-or-kill, at the phase limit: mid minus
;; leeway while the window is open, mid minus slippage once it elapsed. The market's `swap` refuses a caller with a resting
;; position (u1024): reclaim first in the liquidation phase.
(define-public (jing-take
    (amount uint)
    (update (buff 8192))
  )
  (let ((limit (phase-limit (try! (current-mid update)))))
    (try! (check-amount amount))
    (let ((result (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
        (try! (contract-call? JING_MARKET swap amount limit update
          SBTC_TOKEN ASSET_SBTC WSTX_TOKEN ASSET_WSTX true
        ))
      ))))
      (ok (print { notification: "jing-take", payload: {
        amount: amount, limit-price: limit, out: (get token-y-received result),
      } }))
    )
  )
)

;; --- liquidation phase: reclaim + any venue at the floor (window elapsed) ----

;; Reclaim the resting sBTC from the Jing market back into the vault. Anyone,
;; once the window elapsed; the DAO any time via dao-reclaim. Funds can only
;; return here, so no other check is needed. The market only releases an
;; active deposit in its deposit phase; retry after settlement otherwise.
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
(define-public (router-swap
    (amount uint)
    (update (buff 8192))
  )
  (let (
      (mid (try! (current-mid update)))
      (limit (floor-of mid))
      (min-out (floor-out amount limit))
      (mins (contract-call? JING_MARKET get-min-deposits))
    )
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (asserts! (<= amount (var-get max-chunk-sats)) ERR_CHUNK_TOO_BIG)
    (try! (check-amount amount))
    (let ((result (try! (as-contract?
        ((with-ft SBTC_TOKEN ASSET_SBTC (+ amount (get min-token-x mins))))
        (try! (contract-call? JING_ROUTER smart-swap-sbtc-for-stx amount limit
          (some update) mid min-out
        ))
      ))))
      (ok (print { notification: "router-swap", payload: {
        amount: amount, limit-price: limit, mid: mid,
        out: (get out result), unsold: (get unsold result),
      } }))
    )
  )
)

;; Same liquidation sale through the router's manual entry: the caller picks
;; the jing / dlmm / xyk / velar split (jing u0 while a position is still
;; resting on the book, the market refuses a taker with resting size). Every
;; leg's min comes from the oracle: mid minus SLIPPAGE for jing, dlmm, xyk
;; and mid minus VELAR_SLIPPAGE_BPS for velar, twice each venue's fee, so a
;; sandwich breaks even on every leg (see header). A bad split only reverts;
;; it cannot fill below its floor. Same chunk cap as router-swap. The
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
    (asserts! (is-eq amount (+ jing dlmm xyk velar)) ERR_SPLIT_MISMATCH)
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (asserts! (<= amount (var-get max-chunk-sats)) ERR_CHUNK_TOO_BIG)
    (try! (check-amount amount))
    (let ((result (try! (as-contract?
        ((with-ft SBTC_TOKEN ASSET_SBTC (+ amount (get min-token-x market-mins))))
        (try! (contract-call? JING_ROUTER swap-sbtc-for-stx amount jing limit
          (some update) none { dlmm: dlmm, xyk: xyk, velar: velar } mins
          (+ (floor-out (+ jing dlmm xyk) limit) (floor-out velar velar-limit))
        ))
      ))))
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
    leeway-bps: (var-get leeway-bps),
    slippage-bps: (var-get slippage-bps),
    dia-band-bps: (var-get dia-band-bps),
    max-chunk-sats: (var-get max-chunk-sats),
    jing-market: JING_MARKET,
    jing-router: JING_ROUTER,
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

;; Read-only paths name the market and the token LITERALLY: to the read-only
;; checker a contract-call? through a define-constant alias is a dynamic
;; dispatch and the function is rejected as writing.
(define-read-only (get-status)
  (let ((cycle (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jingswap get-current-cycle)))
    {
      sbtc-balance: (sbtc-balance),
      stx-balance: (stx-get-balance current-contract),
      jing-resting: (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jingswap get-token-x-deposit cycle current-contract),
      jing-parked: (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jingswap get-token-x-parked current-contract),
      idle: (is-idle),
      ;; sBTC still sitting in the rewards treasury, claimable via fund-from-treasury
      pending-treasury-sats: (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance REWARDS_TREASURY)),
    }
  )
)

;; Nothing to sell and nothing resting: the next funding opens a new batch.
(define-read-only (is-idle)
  (let ((cycle (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jingswap get-current-cycle)))
    (and
      (is-eq (sbtc-balance) u0)
      (is-eq (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jingswap get-token-x-deposit cycle current-contract) u0)
      (is-eq (contract-call? 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jingswap get-token-x-parked current-contract) u0)
    )
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

;; On funding: open a window when none is open (no clock, or elapsed). A
;; window that is still open is never moved, so a mid-batch top-up cannot
;; stretch the patience phase.
(define-private (open-window)
  (if (window-open)
    true
    (var-set batch-start (some burn-block-height))
  )
)

;; The mid the market would settle at right now, from a signed Lazer update
;; the market itself verifies (staleness + confidence), then sanity-checked
;; against DIA: |mid - dia| <= dia * band. Public call, not read-only,
;; because the Lazer verification writes.
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

(define-private (ask-of (mid uint))
  (/ (* mid (- BPS_PRECISION (var-get leeway-bps))) BPS_PRECISION)
)

(define-private (floor-of (mid uint))
  (/ (* mid (- BPS_PRECISION (var-get slippage-bps))) BPS_PRECISION)
)

(define-private (phase-limit (mid uint))
  (if (window-open)
    (ask-of mid)
    (floor-of mid)
  )
)

;; STX floor for `amount` sats at `limit`: uSTX = sats * price / (1e8 * 100)
(define-private (floor-out (amount uint) (limit uint))
  (/ (* amount limit) (* PRICE_PRECISION DECIMAL_FACTOR))
)

(define-private (check-amount (amount uint))
  (begin
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (asserts! (<= amount (sbtc-balance)) ERR_NO_FUNDS)
    (ok true)
  )
)

(define-private (reclaim-core)
  (let ((refunded (try! (as-contract? ()
      (try! (contract-call? JING_MARKET cancel-token-x-deposit SBTC_TOKEN ASSET_SBTC))
    ))))
    (ok (print { notification: "jing-reclaim", payload: { amount: refunded } }))
  )
)
