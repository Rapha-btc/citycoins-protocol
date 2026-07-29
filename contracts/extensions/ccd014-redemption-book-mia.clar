;; Title: CCD014 - MiamiCoin Redemption Book (MIA)
;; Version: 0.2.0 (DRAFT - unaudited, not deployed)
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

(impl-trait .extension-trait.extension-trait)

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

(define-constant MICRO_CITYCOINS (pow u10 u6)) ;; MIA v2 carries 6 decimals
(define-constant ONE_MILLION_MIA (* u1000000 MICRO_CITYCOINS))
(define-constant MAX_OFFERS u50)
(define-constant MAX_ASK u1000000000000000)

;; v2 only throughout - v1 is not referenced anywhere in this contract.
(define-constant MIA_TOKEN_V2 'SP1H1733V5MZ3SZ9XRW9FKYGEZT0JDGEB8Y634C7R.miamicoin-token-v2)
(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

;; --- par -------------------------------------------------------------------
;; FIXED at the ratio the DAO already ratified: 17,100 STX per 1,000,000 MIA.
;;   17,100 STX    = 17_100 * 1e6 uSTX   = 1.71e10 uSTX
;;   1,000,000 MIA = 1e6 * 1e6 micro-MIA = 1e12 micro-MIA
;;   par           = 1.71e10 / 1e12      = 0.0171 uSTX per micro-MIA
;;   PAR_SCALED    = 0.0171 * 1e8        = 1_710_000
;; Frozen, not recomputed - a par that moves under offerers is a par nobody can
;; price against. `calculate-par` stays advisory so anyone can watch live backing
;; pull away from this number; that gap IS the accretion this contract produces.
(define-constant PAR_SCALE (pow u10 u8))
(define-constant PAR_SCALED u1710000)

;; --- native price ----------------------------------------------------------
;; Scaling identical to .rfq-sbtc-stx-jing-v2-3:
;;   uSTX = sats * price / (PRICE_PRECISION * DECIMAL_FACTOR)
(define-constant PRICE_PRECISION u100000000)
(define-constant DECIMAL_FACTOR u100)
(define-constant NATIVE_PRICE_DIVISOR (* PRICE_PRECISION DECIMAL_FACTOR))
;; Lets the par check cross-multiply instead of dividing twice. See below-par?.
(define-constant PAR_PRICE_RATIO (/ NATIVE_PRICE_DIVISOR PAR_SCALE))

;; 48 tenures spaced 366 blocks apart, reaching ~17.2k blocks back. Averaging over
;; a long sparse window makes the price expensive to move: an attacker would have
;; to distort miner spend across months of tenures, not a handful of blocks.
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
  (ok (asserts! (or (is-eq tx-sender .base-dao)
    (contract-call? .base-dao is-extension contract-caller)) ERR_UNAUTHORIZED
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
;;   ask * price / NATIVE_PRICE_DIVISOR  <  amount * PAR_SCALED / PAR_SCALE
;; cross-multiplied to avoid two truncating divisions:
;;   ask * price  <  amount * PAR_SCALED * PAR_PRICE_RATIO
(define-read-only (below-par? (amount uint) (ask uint) (price uint))
  (< (* ask price) (* amount PAR_SCALED PAR_PRICE_RATIO))
)

;; Par expressed the way it was ratified, so the constant is auditable at a glance:
;; returns 17_100_000_000 uSTX = 17,100 STX per 1,000,000 MIA.
(define-read-only (get-par-ustx-per-1m-mia)
  (/ (* ONE_MILLION_MIA PAR_SCALED) PAR_SCALE)
)

(define-read-only (get-offer-book) (var-get offer-book))

(define-read-only (get-offer-count) (len (var-get offer-book)))

(define-read-only (get-offer (owner principal))
  (get found (fold find-owner-step (var-get offer-book) { target: owner, found: none })))

(define-read-only (get-book-totals)
  (fold sum-step (var-get offer-book) { btc: u0, amount: u0 })
)

;; ADVISORY ONLY - live STX backing per micro-MIA, scaled by PAR_SCALE. Nothing
;; consumes it. Sums every ccd002 treasury holding MIA's STX, which is the part a
;; single stx-get-balance gets wrong.
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

(define-read-only (get-treasury-balance)
  (+
    (stx-get-balance .ccd002-treasury-mia-mining)
    (stx-get-balance .ccd002-treasury-mia-mining-v2)
    (stx-get-balance .ccd002-treasury-mia-mining-v3)
    (stx-get-balance .ccd002-treasury-mia-rewards-v3)
    (stx-get-balance .ccd002-treasury-mia-stacking)
  )
)

;; v2 only. v1 was migrated out by CCIP-013, so v2 supply is live supply.
;; Literal principal, not the MIA_TOKEN_V2 constant: a contract-call? through a
;; constant cannot be statically resolved, so the checker assumes it may write and
;; rejects it inside define-read-only.
(define-read-only (get-mia-total-supply)
  (unwrap-panic (contract-call?
    'SP1H1733V5MZ3SZ9XRW9FKYGEZT0JDGEB8Y634C7R.miamicoin-token-v2 get-total-supply))
)

(define-read-only (get-info)
  {
    paused: (var-get paused),
    min-deposit: (var-get min-deposit),
    offer-count: (len (var-get offer-book)),
    par-scaled: PAR_SCALED,
    calculated-par: (calculate-par),
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
