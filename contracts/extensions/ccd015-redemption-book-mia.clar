;; Title: CCD015 - MiamiCoin Redemption Book (MIA)
;; Version: 0.3.0 (DRAFT - unaudited, not deployed)
;; Summary: Treasury sBTC rewards cross a book of MIA sell offers below par; the MIA bought is burned.
;; Description:
;;   A fork of SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.mia-orderbook-faktory,
;;   reusing its sorted offer book, insertion sort, and partial-fill settlement.
;;   Three changes turn a public marketplace into a DAO retirement mechanism:
;;
;;   1. NO FEE. The upstream book charges FEE_BPS u10 (0.10%) to a fee-recipient.
;;      Removed - the DAO is the only buyer, so a fee would just be the DAO paying
;;      itself out of its own retirement budget.
;;   2. THE CONTRACT IS THE ONLY BUYER. There is no public `market-order` where a
;;      taker spends their own sats. `cross-book` spends only the sBTC this
;;      contract already holds - the stacking yield sent here. Anyone may trigger
;;      it, and it takes no arguments: following CCD012, funding is a plain
;;      transfer in and needs no accounting call. The budget IS the balance.
;;      `fund-from-treasury` completes the pipe with the same philosophy: anyone
;;      may pull the rewards treasury's full sBTC balance into the book, and the
;;      funds can land nowhere else.
;;   3. MIA IS BURNED, not delivered. Upstream ships acquired MIA to the taker.
;;      Here it leaves supply permanently.
;;
;;   Offers ask in sats; par is denominated in STX. `get-native-price` bridges the
;;   two, inlined from the Jing RFQ market so the same chain state yields the same
;;   rate - PROVIDED coinbase-ustx matches in both. Every fill is checked against
;;   par at cross time.
;;
;;   Accounting: a fill BURNS MIA AT PAR - extinguishing a claim worth
;;   (par * amount) on the STX treasury - while PAYING ONLY the sats ask. Because
;;   the payment is yield and never debits the STX treasury, T is unchanged and
;;   only supply shrinks:
;;
;;       par_before = T / S        par_after = T / (S - burned)
;;
;;   So the full (par * amount) of retired claim accrues to holders who did not
;;   sell. The ask discount does not create that surplus; it sets how much MIA is
;;   retired per sat of yield - which is why the book fills cheapest first.

;; TRAITS

;; Every principal in this file is a fully qualified mainnet address - trait,
;; base-dao, treasuries, tokens - exactly like deployed ccd013, which lives at
;; a different address than the DAO it serves. The file as written IS the
;; mainnet artifact: no qualification pass at deployment, deployable from any
;; address.

(impl-trait 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.extension-trait.extension-trait)

;; CONSTANTS

;; error codes
(define-constant ERR_UNAUTHORIZED (err u14000))
(define-constant ERR_INVALID_OFFER (err u14001))
(define-constant ERR_OFFER_NOT_FOUND (err u14002))
(define-constant ERR_BOOK_FULL (err u14003))
(define-constant ERR_HAS_OFFER (err u14004))
(define-constant ERR_BELOW_MIN_DEPOSIT (err u14005))
(define-constant ERR_NO_FILL (err u14006))
(define-constant ERR_PAUSED (err u14007))
(define-constant ERR_ZERO_PRICE (err u14008))
(define-constant ERR_NO_BUDGET (err u14010))
(define-constant ERR_PAR_NOT_SET (err u14011))
(define-constant ERR_PAR_CALCULATION (err u14012))

(define-constant MICRO_CITYCOINS (pow u10 u6)) ;; MIA v2 carries 6 decimals
(define-constant ONE_MILLION_MIA (* u1000000 MICRO_CITYCOINS))
(define-constant MAX_OFFERS u50)
(define-constant MAX_ASK u1000000000000000)

;; Offers, burns, and transfers are v2 only (v1 was migrated out by CCIP-013).
;; v1 appears in exactly one place: the par formula's supply denominator, which
;; the DAO ratified as combined v1 + v2 supply (see ccd013 initialize-redemption).
(define-constant MIA_TOKEN_V2 'SP1H1733V5MZ3SZ9XRW9FKYGEZT0JDGEB8Y634C7R.miamicoin-token-v2)
(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

;; The same treasury principals ccd014-pox5-staking-mia hard-codes, kept under
;; the same names so the two contracts read as one system.
;; STX backing the par formula counts, alongside the pox5 stake
(define-constant MINING_TREASURY 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-mining-v3)
;; where ccd014 forwards the sBTC rewards - this book's funding source
(define-constant REWARDS_TREASURY 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-rewards-v3)
;; the pox5 staking contract CCIP-027 moved the mining treasury into
(define-constant POX5_STAKING 'SPN4Y5QPGQA8882ZXW90ADC2DHYXMSTN8VAR8C3X.ccd014-pox5-staking-mia)

;; --- par -------------------------------------------------------------------
;; SNAPSHOTTED, not hardcoded. `update-par` (DAO-gated) commits the output of
;; the ratified formula - total STX backing over combined v1+v2 supply - as a
;; fixed-point value scaled by PAR_SCALE:
;;   par-scaled = treasury-ustx * PAR_SCALE / supply-micro-mia
;;   e.g. ~2,042 STX per 1M MIA  ->  0.002042 uSTX per micro-MIA * 1e8 = u204200
;; The value is frozen between DAO actions - a par that moves under offerers is
;; a par nobody can price against - but it is not frozen forever: as burns
;; accrue, live backing rises, and the DAO re-snapshots between rounds by
;; proposal. `update-par` can only commit the formula's output, never an
;; arbitrary number. `calculate-par` stays advisory so anyone can watch live
;; backing pull away from the committed value; that gap IS the accretion this
;; contract produces. Starts at u0: the book accepts offers but cannot cross
;; until the DAO commits an initial par.
(define-constant PAR_SCALE (pow u10 u8))

;; --- native price ----------------------------------------------------------
;; Scaling identical to .rfq-sbtc-stx-jing-v2-3:
;;   uSTX = sats * price / (PRICE_PRECISION * DECIMAL_FACTOR)
(define-constant PRICE_PRECISION u100000000)
(define-constant DECIMAL_FACTOR u100)
(define-constant NATIVE_PRICE_DIVISOR (* PRICE_PRECISION DECIMAL_FACTOR))
;; Lets the par check cross-multiply instead of dividing twice. See below-par?.
(define-constant PAR_PRICE_RATIO (/ NATIVE_PRICE_DIVISOR PAR_SCALE))

;; Offsets in STACKS blocks - 48 samples spaced 366 apart, deepest at 17,203.
;; At the current ~53 stacks blocks per tenure that reaches ~2 days (~320 bitcoin
;; blocks) back, sampling ~48 tenures roughly every 7th one, about 1.1h apart.
;; Sparse and wide is what makes the price expensive to move: per-tenure commit
;; noise is autocorrelated over hours, so an attacker has to hold miner spend
;; distorted across days of tenures, not a handful of blocks. Calibration from the
;; source market (.rfq-sbtc-stx-jing-v2, 3.5 months of mainnet commits): worst
;; deviation vs CEX mid tightens from -40%/+54% with 6 consecutive tenures to
;; -23%/+30% with this spread.
(define-constant TENURE_SAMPLE_OFFSETS (list
  u1 u367 u733 u1099 u1465 u1831 u2197 u2563
  u2929 u3295 u3661 u4027 u4393 u4759 u5125 u5491
  u5857 u6223 u6589 u6955 u7321 u7687 u8053 u8419
  u8785 u9151 u9517 u9883 u10249 u10615 u10981 u11347
  u11713 u12079 u12445 u12811 u13177 u13543 u13909 u14275
  u14641 u15007 u15373 u15739 u16105 u16471 u16837 u17203
))

;; DATA VARS

(define-data-var paused bool false)
(define-data-var min-deposit uint (* u100000 MICRO_CITYCOINS))

;; See the par section above. u0 until the DAO commits the first snapshot.
(define-data-var par-scaled uint u0)

(define-data-var offer-book
  (list 50 { owner: principal, amount: uint, btc: uint })
  (list)
)
(define-data-var target-owner principal 'SP000000000000000000002Q6VF78)

;; STX coinbase per tenure, in uSTX - numerator of the native price. 1000 STX.
;; NOTE: .rfq-sbtc-stx-jing-v2-3 currently runs 500 STX, so this contract prices
;; STX at half that market's rate for identical chain state. If 1000 is the
;; correct emission, that contract is the one that needs set-coinbase-ustx.
;; Must be kept current by proposal across emission changes: this value scales
;; every par comparison linearly, and a stale value silently moves the ceiling.
(define-data-var coinbase-ustx uint u1000000000)

(define-data-var total-burned-mia uint u0)
(define-data-var total-spent-sats uint u0)

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

(define-public (set-paused (pause bool))
  (begin
    (try! (is-dao-or-extension))
    (var-set paused pause)
    (ok (print { notification: "set-paused", payload: { paused: pause } }))
  )
)

(define-public (set-min-deposit (amount uint))
  (begin
    (try! (is-dao-or-extension))
    (asserts! (> amount u0) ERR_INVALID_OFFER)
    (var-set min-deposit amount)
    (ok (print { notification: "set-min-deposit", payload: { min-deposit: amount } }))
  )
)

(define-public (set-coinbase-ustx (ustx uint))
  (begin
    (try! (is-dao-or-extension))
    (asserts! (> ustx u0) ERR_ZERO_PRICE)
    (var-set coinbase-ustx ustx)
    (ok (print { notification: "set-coinbase-ustx", payload: { coinbase-ustx: ustx } }))
  )
)

;; Commit the ratified formula's current output as the fixed par. Serves both
;; initialization and the between-rounds refresh; being formula-locked, a
;; proposal can decide WHEN par moves but never WHAT it moves to.
(define-public (update-par)
  (let ((snapshot (unwrap! (calculate-par) ERR_PAR_CALCULATION)))
    (try! (is-dao-or-extension))
    (asserts! (> snapshot u0) ERR_PAR_CALCULATION)
    (var-set par-scaled snapshot)
    (ok (print { notification: "update-par", payload: {
      par-scaled: snapshot,
      treasury-ustx: (get-treasury-balance),
      supply: (get-mia-total-supply),
    } }))
  )
)

;; --- funding (the pipe from the rewards treasury) ---------------------------

;; Pull the rewards treasury's entire sBTC balance into the book. Permissionless
;; and argumentless for the same reason cross-book is: nobody has to show up for
;; rewards to reach holders, and a caller controls neither amount nor
;; destination. Requires this contract to be an enabled extension (the treasury
;; gates withdraw-ft on is-dao-or-extension) and sBTC on the treasury's
;; allowlist - both set by the enabling proposal.
(define-public (fund-from-treasury)
  (let ((amount (unwrap!
      (contract-call? SBTC_TOKEN get-balance REWARDS_TREASURY)
      ERR_NO_BUDGET
    )))
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (> amount u0) ERR_NO_BUDGET)
    (try! (contract-call? REWARDS_TREASURY withdraw-ft
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token amount current-contract
    ))
    (ok (print { notification: "fund-from-treasury", payload: { amount: amount } }))
  )
)

;; --- offer book (sellers) --------------------------------------------------

(define-public (place-offer (amount uint) (ask-btc uint))
  (let (
      (owner tx-sender)
      (nrec { owner: owner, amount: amount, btc: ask-btc })
      (book (var-get offer-book))
    )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (>= amount (var-get min-deposit)) ERR_BELOW_MIN_DEPOSIT)
    (asserts! (and (> ask-btc u0) (<= ask-btc MAX_ASK)) ERR_INVALID_OFFER)
    (var-set target-owner owner)
    (asserts! (is-eq (len (filter is-target-owner book)) u0) ERR_HAS_OFFER)
    (try! (contract-call? MIA_TOKEN_V2 transfer amount owner current-contract none))
    (let (
        (base (if (is-eq (len book) MAX_OFFERS)
          (let ((worst (unwrap-panic (element-at? book (- (len book) u1)))))
            ;; a full book only accepts a strictly better price, evicting the worst
            (asserts!
              (< (* ask-btc (get amount worst)) (* (get btc worst) amount))
              ERR_BOOK_FULL)
            (try! (refund-rec worst))
            (var-set target-owner (get owner worst))
            (filter not-target-owner book)
          )
          book
        ))
        (res (fold insert-step base { nrec: nrec, out: (list), placed: false }))
      )
      (var-set offer-book
        (if (get placed res) (get out res) (push-rec (get out res) nrec)))
    )
    (print { notification: "place-offer", payload: nrec })
    (ok true)
  )
)

(define-public (change-offer (add-amount (optional uint)) (new-ask-btc uint))
  (let (
      (owner tx-sender)
      (adding (default-to u0 add-amount))
      (book (var-get offer-book))
    )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (and (> new-ask-btc u0) (<= new-ask-btc MAX_ASK)) ERR_INVALID_OFFER)
    (var-set target-owner owner)
    (let (
        (mine (filter is-target-owner book))
        (cur (unwrap! (element-at? mine u0) ERR_OFFER_NOT_FOUND))
        (namount (+ (get amount cur) adding))
        (nrec { owner: owner, amount: namount, btc: new-ask-btc })
        (rest (filter not-target-owner book))
      )
      (asserts! (>= namount (var-get min-deposit)) ERR_BELOW_MIN_DEPOSIT)
      (and (> adding u0)
        (try! (contract-call? MIA_TOKEN_V2 transfer adding owner current-contract none)))
      (let ((res (fold insert-step rest { nrec: nrec, out: (list), placed: false })))
        (var-set offer-book
          (if (get placed res) (get out res) (push-rec (get out res) nrec)))
      )
      (print { notification: "change-offer", payload: nrec })
      (ok true)
    )
  )
)

(define-public (cancel-offer)
  (let ((book (var-get offer-book)))
    (var-set target-owner tx-sender)
    (let ((mine (filter is-target-owner book)))
      (asserts! (> (len mine) u0) ERR_OFFER_NOT_FOUND)
      (try! (refund-rec (unwrap-panic (element-at? mine u0))))
      (var-set offer-book (filter not-target-owner book))
    )
    (print { notification: "cancel-offer", payload: { owner: tx-sender } })
    (ok true)
  )
)

;; --- crossing (the DAO side) ----------------------------------------------

;; Spend the credited reward budget against the book, cheapest first, skipping
;; anything at or above par, then burn everything acquired.
;; Permissionless to CALL but not to fund: the sBTC allowance is bounded by
;; the contract's own sBTC balance, so a caller can only ever trigger retirement
;; using funds already committed here.
;; There is nothing to extract - the MIA does not go to the caller, it is burned.
(define-public (cross-book)
  (let (
      (budget (unwrap! (contract-call? SBTC_TOKEN get-balance current-contract) ERR_NO_BUDGET))
    )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (> budget u0) ERR_NO_BUDGET)
    (asserts! (> (var-get par-scaled) u0) ERR_PAR_NOT_SET)
    (let (
        (price (try! (get-native-price)))
        ;; as-contract? switches tx-sender to this contract so settle-step can pay
        ;; from current-contract, and caps total sBTC out at `budget` - a runtime
        ;; backstop that holds even if the fill arithmetic below is wrong.
        (res (try! (as-contract? ((with-ft SBTC_TOKEN "sbtc" budget))
              (fold settle-step (var-get offer-book) {
                remaining: budget,
                price: price,
                spent: u0,
                acquired: u0,
                kept: (list),
              }))))
        (acquired (get acquired res))
        (spent (get spent res))
      )
      (asserts! (> acquired u0) ERR_NO_FILL)
      (var-set offer-book (get kept res))
      ;; permanently out of supply - this is the whole point
      (try! (as-contract? ((with-ft MIA_TOKEN_V2 "miamicoin" acquired))
        (try! (contract-call? MIA_TOKEN_V2 burn acquired current-contract))))
      (var-set total-burned-mia (+ (var-get total-burned-mia) acquired))
      (var-set total-spent-sats (+ (var-get total-spent-sats) spent))
      (print { notification: "cross-book", payload: {
        spent: spent,
        acquired: acquired,
        price: price,
        remaining-sats: (get remaining res),
        offer-count: (len (var-get offer-book)),
      } })
      (ok { spent: spent, acquired: acquired })
    )
  )
)

;; READ ONLY FUNCTIONS

;; STX/BTC priced off Stacks itself: miners bid BTC for a known STX coinbase, so
;; the ratio of coinbase to average tenure spend IS the market's revealed rate.
;; No external feed, no publisher to bribe, nothing to go stale - the price is a
;; byproduct of the chain already being mined.
(define-read-only (get-native-price)
  (let (
      (samples (fold sample-spend TENURE_SAMPLE_OFFSETS {
        sum: u0,
        n: u0,
      }))
      (n (get n samples))
    )
    (asserts! (> n u0) ERR_ZERO_PRICE)
    (let ((avg-spend (/ (get sum samples) n)))
      (asserts! (> avg-spend u0) ERR_ZERO_PRICE)
      (ok (/ (* DECIMAL_FACTOR (var-get coinbase-ustx) PRICE_PRECISION) avg-spend))
    )
  )
)

;; Is `ask` sats for `amount` micro-MIA strictly below par?
;;   ask * price / NATIVE_PRICE_DIVISOR  <  amount * par-scaled / PAR_SCALE
;; cross-multiplied to avoid two truncating divisions:
;;   ask * price  <  amount * par-scaled * PAR_PRICE_RATIO
;; With par-scaled at u0 (not yet committed) nothing is below par, so cross-book
;; would find no fill even without its explicit ERR_PAR_NOT_SET guard.
(define-read-only (below-par? (amount uint) (ask uint) (price uint))
  (< (* ask price) (* amount (var-get par-scaled) PAR_PRICE_RATIO))
)

;; The committed par expressed the way it was ratified: uSTX per 1,000,000 MIA.
(define-read-only (get-par-ustx-per-1m-mia)
  (/ (* ONE_MILLION_MIA (var-get par-scaled)) PAR_SCALE)
)

(define-read-only (get-par-scaled)
  (var-get par-scaled)
)

(define-read-only (get-offer-book) (var-get offer-book))

(define-read-only (get-offer-count) (len (var-get offer-book)))

(define-read-only (get-offer (owner principal))
  (get found (fold find-owner-step (var-get offer-book) { target: owner, found: none })))

(define-read-only (get-book-totals)
  (fold sum-step (var-get offer-book) { btc: u0, amount: u0 })
)

;; Live STX backing per micro-MIA, scaled by PAR_SCALE - the ratified formula.
;; Advisory until `update-par` commits its output as the fixed par.
(define-read-only (calculate-par)
  (let (
      (treasury-ustx (get-treasury-balance))
      (supply (get-mia-total-supply))
    )
    (if (or (is-eq supply u0) (is-eq treasury-ustx u0))
      none
      (some (/ (* treasury-ustx PAR_SCALE) supply))
    )
  )
)

;; The mining treasury, exactly as ccd013's ratified formula scopes it - just
;; followed to where the funds now sit. ccd013 reads mining-v3 via stx-account
;; (locked plus unlocked); CCIP-027 moved that treasury into
;; ccd014-pox5-staking-mia, where it stacks under PoX-5, so this reads both:
;; mining-v3 for anything that returns there, the pox5 contract for the live
;; balance. stx-account rather than stx-get-balance because the stacked STX is
;; locked - a plain balance read sees it as zero, which is the exact mistake
;; that left ccd013's reader at 0. Both principals are fully qualified: they
;; live at their own deployers, not wherever this contract is deployed from.
(define-read-only (get-treasury-balance)
  (let (
      (mining-v3 (stx-account MINING_TREASURY))
      (staked (stx-account POX5_STAKING))
    )
    (+
      (get locked mining-v3)
      (get unlocked mining-v3)
      (get locked staked)
      (get unlocked staked)
    )
  )
)

;; Combined v1 + v2 supply, exactly as ccd013's initialize-redemption counts it:
;; v1 carries no decimals so it is scaled to micro before adding v2 (6 decimals).
;; Literal principals, not constants: a contract-call? through a constant cannot
;; be statically resolved, so the checker assumes it may write and rejects it
;; inside define-read-only.
(define-read-only (get-mia-total-supply)
  (+
    (* MICRO_CITYCOINS (unwrap-panic (contract-call?
      'SP466FNC0P7JWTNM2R9T199QRZN1MYEDTAR0KP27.miamicoin-token get-total-supply)))
    (unwrap-panic (contract-call?
      'SP1H1733V5MZ3SZ9XRW9FKYGEZT0JDGEB8Y634C7R.miamicoin-token-v2 get-total-supply))
  )
)

(define-read-only (get-info)
  {
    paused: (var-get paused),
    min-deposit: (var-get min-deposit),
    offer-count: (len (var-get offer-book)),
    par-scaled: (var-get par-scaled),
    calculated-par: (calculate-par),
    ;; live STX in the pox5 staking contract, locked plus unlocked
    pox5-staked-ustx: (let ((staked (stx-account
        'SPN4Y5QPGQA8882ZXW90ADC2DHYXMSTN8VAR8C3X.ccd014-pox5-staking-mia
      )))
      (+ (get locked staked) (get unlocked staked))
    ),
    ;; sBTC still sitting in the rewards treasury, claimable via fund-from-treasury.
    ;; Literal principal: the sBTC lives at the mainnet treasury regardless of
    ;; where this contract is deployed from.
    pending-treasury-sats: (contract-call?
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-rewards-v3),
    coinbase-ustx: (var-get coinbase-ustx),
    native-price: (get-native-price),
    ;; literal principal - a contract-call? through a constant is not statically
    ;; resolvable, so the checker rejects it inside define-read-only
    available-sats: (contract-call?
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract),
    total-burned-mia: (var-get total-burned-mia),
    total-spent-sats: (var-get total-spent-sats),
  }
)

;; PRIVATE FUNCTIONS

;; Average miner spend across TENURE_SAMPLE_OFFSETS. Offsets deeper than the chain
;; are skipped rather than counted as zero, so a young chain narrows the window
;; instead of dragging the average down.
(define-private (sample-spend
    (offset uint)
    (acc {
      sum: uint,
      n: uint,
    })
  )
  (if (>= offset stacks-block-height)
    acc
    (match (get-tenure-info? miner-spend-total (- stacks-block-height offset))
      spend {
        sum: (+ (get sum acc) spend),
        n: (+ (get n acc) u1),
      }
      acc
    )
  )
)

(define-private (push-rec
    (lst (list 50 { owner: principal, amount: uint, btc: uint }))
    (r { owner: principal, amount: uint, btc: uint })
  )
  (unwrap-panic (as-max-len? (append lst r) u50))
)

(define-private (is-target-owner (r { owner: principal, amount: uint, btc: uint }))
  (is-eq (get owner r) (var-get target-owner)))
(define-private (not-target-owner (r { owner: principal, amount: uint, btc: uint }))
  (not (is-eq (get owner r) (var-get target-owner))))

(define-private (find-owner-step
    (r { owner: principal, amount: uint, btc: uint })
    (acc { target: principal, found: (optional { owner: principal, amount: uint, btc: uint }) })
  )
  (if (is-eq (get owner r) (get target acc))
    (merge acc { found: (some r) })
    acc
  )
)

(define-private (sum-step
    (r { owner: principal, amount: uint, btc: uint })
    (acc { btc: uint, amount: uint })
  )
  { btc: (+ (get btc acc) (get btc r)), amount: (+ (get amount acc) (get amount r)) }
)

(define-private (refund-rec (r { owner: principal, amount: uint, btc: uint }))
  (as-contract? ((with-ft MIA_TOKEN_V2 "miamicoin" (get amount r)))
    (try! (contract-call? MIA_TOKEN_V2 transfer (get amount r) current-contract (get owner r) none)))
)

;; Keeps the book sorted ascending by price (btc/amount), compared by
;; cross-multiplication so no division truncates the ordering.
(define-private (insert-step
    (entry { owner: principal, amount: uint, btc: uint })
    (acc {
      nrec: { owner: principal, amount: uint, btc: uint },
      out: (list 50 { owner: principal, amount: uint, btc: uint }),
      placed: bool,
    })
  )
  (let (
      (nrec (get nrec acc))
      (nask (get btc nrec))
      (numia (get amount nrec))
      (eask (get btc entry))
      (eumia (get amount entry))
    )
    (if (and (not (get placed acc)) (< (* nask eumia) (* eask numia)))
      (merge acc { out: (push-rec (push-rec (get out acc) nrec) entry), placed: true })
      (merge acc { out: (push-rec (get out acc) entry) })
    )
  )
)

;; Runs inside cross-book's as-contract?, so tx-sender is this contract and the
;; sBTC allowance caps total payout at the credited budget.
(define-private (settle-step
    (entry { owner: principal, amount: uint, btc: uint })
    (acc {
      remaining: uint,
      price: uint,
      spent: uint,
      acquired: uint,
      kept: (list 50 { owner: principal, amount: uint, btc: uint }),
    })
  )
  (let (
      (remaining (get remaining acc))
      (ask (get btc entry))
      (amount (get amount entry))
    )
    ;; par is the hard ceiling: at or above it, the DAO does not buy
    (if (not (below-par? amount ask (get price acc)))
      (merge acc { kept: (push-rec (get kept acc) entry) })
      (if (>= remaining ask)
        (begin
          (unwrap-panic (contract-call? SBTC_TOKEN transfer ask current-contract (get owner entry) none))
          (merge acc {
            remaining: (- remaining ask),
            spent: (+ (get spent acc) ask),
            acquired: (+ (get acquired acc) amount),
          })
        )
        ;; marginal offer fills partially and the remainder stays on the book
        (let ((taken (/ (* amount remaining) ask)))
          (if (> taken u0)
            (begin
              (unwrap-panic (contract-call? SBTC_TOKEN transfer remaining current-contract (get owner entry) none))
              (merge acc {
                remaining: u0,
                spent: (+ (get spent acc) remaining),
                acquired: (+ (get acquired acc) taken),
                kept: (push-rec (get kept acc)
                  (merge entry {
                    amount: (- amount taken),
                    btc: (- ask remaining),
                  })),
              })
            )
            (merge acc { kept: (push-rec (get kept acc) entry) })
          )
        )
      )
    )
  )
)
