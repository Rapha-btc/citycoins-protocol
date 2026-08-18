(use-trait ft-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

(define-constant CANCEL_THRESHOLD u42)

(define-constant PHASE_DEPOSIT u0)
(define-constant PHASE_SETTLE u2)

(define-constant MAX_DEPOSITORS u50)
(define-constant FEE_BPS u10)
;; Taker rebate. A batch auction has no book to sit on, so nothing rewards the
;; depositors who escrow early and wait out the window - yet they are the only
;; reason a `swap` caller can clear immediately. This charges the taker (the
;; `swap` caller, who deposits and settles in one tx) an extra 20 bps and pays
;; it to the OPPOSITE side's filled depositors, pro rata. Resting depositors
;; still pay only FEE_BPS.
;;
;; 20 rather than 25: a Bitflow LP earns 25 bps but is filled at whatever the
;; curve reached, so that yield is payment for impermanent loss. A maker here
;; fills only inside their own limit and carries none, so 20 bps IL-free is the
;; better risk-adjusted side of the trade. Matching 25 would price us as though
;; we were selling the same thing. See README-maker-economics.md.
;;
;; Taker therefore pays 30 bps all-in (10 protocol + 20 to makers) against
;; Bitflow's 50, before slippage - which the auction does not have at all.
(define-constant TAKER_REBATE_BPS u20)

;; Exposed so integrating vaults can assert their mirrored rebate constant
;; matches at initialize time, refusing to register against a market whose
;; taker economics drifted from their template.
(define-read-only (get-taker-rebate-bps)
  TAKER_REBATE_BPS
)
(define-constant BPS_PRECISION u10000)
(define-constant MIN_SHARE_BPS u20)

(define-constant PRICE_PRECISION u100000000)

(define-constant DECIMAL_FACTOR u100)

(define-constant MAX_STALENESS u80)
(define-constant MAX_CONF_RATIO u50)

(define-constant SAINT 'SP000000000000000000002Q6VF78)
(define-constant SAINT_FEED 0x0000000000000000000000000000000000000000000000000000000000000000)

(define-data-var token-x principal SAINT)
(define-data-var token-y principal SAINT)
(define-data-var initialized bool false)

(define-data-var oracle-feed-x (buff 32) SAINT_FEED)
(define-data-var oracle-feed-y (buff 32) SAINT_FEED)

(define-constant ERR_DEPOSIT_TOO_SMALL (err u1001))
(define-constant ERR_NOT_DEPOSIT_PHASE (err u1002))
(define-constant ERR_NOT_SETTLE_PHASE (err u1003))
(define-constant ERR_ALREADY_SETTLED (err u1004))
(define-constant ERR_STALE_PRICE (err u1005))
(define-constant ERR_PRICE_UNCERTAIN (err u1006))
(define-constant ERR_NOTHING_TO_WITHDRAW (err u1008))
(define-constant ERR_ZERO_PRICE (err u1009))
(define-constant ERR_PAUSED (err u1010))
(define-constant ERR_NOT_AUTHORIZED (err u1011))
(define-constant ERR_NOTHING_TO_SETTLE (err u1012))
(define-constant ERR_QUEUE_FULL (err u1013))
(define-constant ERR_CANCEL_TOO_EARLY (err u1014))
(define-constant ERR_ALREADY_CLOSED (err u1016))
(define-constant ERR_LIMIT_REQUIRED (err u1017))
(define-constant ERR_ALREADY_INITIALIZED (err u1018))
(define-constant ERR_WRONG_TRAIT (err u1019))
(define-constant ERR_EXPO_MISMATCH (err u1020))
(define-constant ERR_NOTHING_FILLED (err u1021))
(define-constant ERR_MUST_USE_SWAP (err u1022))
(define-constant ERR_PARTIAL_FILL (err u1023))

(define-data-var treasury principal tx-sender)
(define-data-var operator principal tx-sender)
(define-data-var paused bool false)
(define-data-var min-token-y-deposit uint u0)
(define-data-var min-token-x-deposit uint u0)
(define-data-var current-cycle uint u0)
(define-data-var cycle-start-block uint stacks-block-height)

(define-data-var deposits-closed-block uint u0)

(define-data-var settle-token-y-cleared uint u0)
(define-data-var settle-token-x-cleared uint u0)
(define-data-var settle-total-token-y uint u0)
(define-data-var settle-total-token-x uint u0)
(define-data-var settle-token-x-after-fee uint u0)
(define-data-var settle-token-y-after-fee uint u0)
(define-data-var bumped-token-y-principal principal tx-sender)
(define-data-var bumped-token-x-principal principal tx-sender)

(define-data-var acc-token-x-out uint u0)
(define-data-var acc-token-y-out uint u0)
(define-data-var acc-token-y-rolled uint u0)
(define-data-var acc-token-x-rolled uint u0)

(define-data-var caller-token-x-received uint u0)
(define-data-var caller-token-y-rolled uint u0)
(define-data-var caller-token-y-received uint u0)
(define-data-var caller-token-x-rolled uint u0)

(define-data-var settle-clearing-price uint u0)

;; Rebate parked by `swap` before it settles, denominated in the token the
;; taker deposited. `swap` is atomic (deposit -> close -> settle in one tx), so
;; either settlement consumes this or the whole tx reverts and it is never
;; stranded. Settlement zeroes both on the way out.
(define-data-var pending-rebate-x uint u0)
(define-data-var pending-rebate-y uint u0)

(define-map token-y-deposits
  {
    cycle: uint,
    depositor: principal,
  }
  uint
)

(define-map token-x-deposits
  {
    cycle: uint,
    depositor: principal,
  }
  uint
)

(define-map token-y-depositor-list
  uint
  (list 50 principal)
)

(define-map token-x-depositor-list
  uint
  (list 50 principal)
)

(define-map cycle-totals
  uint
  {
    total-token-y: uint,
    total-token-x: uint,
  }
)

(define-map settlements
  uint
  {
    price: uint,
    token-y-cleared: uint,
    token-x-cleared: uint,
    token-y-fee: uint,
    token-x-fee: uint,
    settled-at: uint,
  }
)

(define-map token-y-deposit-limits
  principal
  uint
)
(define-map token-x-deposit-limits
  principal
  uint
)

(define-read-only (get-current-cycle)
  (var-get current-cycle)
)

(define-read-only (get-cycle-start-block)
  (var-get cycle-start-block)
)

(define-read-only (get-blocks-elapsed)
  (- stacks-block-height (var-get cycle-start-block))
)

(define-read-only (get-cycle-phase)
  (let ((closed-block (var-get deposits-closed-block)))
    (if (is-eq closed-block u0)
      PHASE_DEPOSIT
      PHASE_SETTLE
    )
  )
)

(define-read-only (get-cycle-totals (cycle uint))
  (default-to {
    total-token-y: u0,
    total-token-x: u0,
  }
    (map-get? cycle-totals cycle)
  )
)

(define-read-only (get-settlement (cycle uint))
  (map-get? settlements cycle)
)

(define-read-only (get-token-y-deposit
    (cycle uint)
    (depositor principal)
  )
  (default-to u0
    (map-get? token-y-deposits {
      cycle: cycle,
      depositor: depositor,
    })
  )
)

(define-read-only (get-token-x-deposit
    (cycle uint)
    (depositor principal)
  )
  (default-to u0
    (map-get? token-x-deposits {
      cycle: cycle,
      depositor: depositor,
    })
  )
)

(define-read-only (get-token-y-depositors (cycle uint))
  (default-to (list) (map-get? token-y-depositor-list cycle))
)

(define-read-only (get-token-x-depositors (cycle uint))
  (default-to (list) (map-get? token-x-depositor-list cycle))
)

(define-read-only (get-min-deposits)
  {
    min-token-y: (var-get min-token-y-deposit),
    min-token-x: (var-get min-token-x-deposit),
  }
)

(define-read-only (get-token-y-limit (depositor principal))
  (default-to u0 (map-get? token-y-deposit-limits depositor))
)

(define-read-only (get-token-x-limit (depositor principal))
  (default-to u0 (map-get? token-x-deposit-limits depositor))
)

(define-private (advance-cycle)
  (begin
    (var-set current-cycle (+ (var-get current-cycle) u1))
    (var-set cycle-start-block stacks-block-height)
    (var-set deposits-closed-block u0)
  )
)

(define-private (find-smallest-token-y-fold
    (depositor principal)
    (acc {
      cycle: uint,
      smallest: uint,
      smallest-principal: principal,
    })
  )
  (let ((amount (get-token-y-deposit (get cycle acc) depositor)))
    (if (< amount (get smallest acc))
      (merge acc {
        smallest: amount,
        smallest-principal: depositor,
      })
      acc
    )
  )
)

(define-private (find-smallest-token-x-fold
    (depositor principal)
    (acc {
      cycle: uint,
      smallest: uint,
      smallest-principal: principal,
    })
  )
  (let ((amount (get-token-x-deposit (get cycle acc) depositor)))
    (if (< amount (get smallest acc))
      (merge acc {
        smallest: amount,
        smallest-principal: depositor,
      })
      acc
    )
  )
)

(define-private (not-eq-bumped-token-y (entry principal))
  (not (is-eq entry (var-get bumped-token-y-principal)))
)

(define-private (not-eq-bumped-token-x (entry principal))
  (not (is-eq entry (var-get bumped-token-x-principal)))
)

(define-private (roll-token-y-depositor (depositor principal))
  (let ((cycle (var-get current-cycle)))
    (map-set token-y-deposits {
      cycle: (+ cycle u1),
      depositor: depositor,
    }
      (get-token-y-deposit cycle depositor)
    )
    (map-delete token-y-deposits {
      cycle: cycle,
      depositor: depositor,
    })
  )
)

(define-private (roll-token-x-depositor (depositor principal))
  (let ((cycle (var-get current-cycle)))
    (map-set token-x-deposits {
      cycle: (+ cycle u1),
      depositor: depositor,
    }
      (get-token-x-deposit cycle depositor)
    )
    (map-delete token-x-deposits {
      cycle: cycle,
      depositor: depositor,
    })
  )
)

(define-private (roll-depositor-lists (cycle uint))
  (let ((next-cycle (+ cycle u1)))
    (map-set token-y-depositor-list next-cycle
      (unwrap-panic (as-max-len?
        (concat (get-token-y-depositors next-cycle)
          (get-token-y-depositors cycle)
        )
        u50
      ))
    )
    (map-set token-x-depositor-list next-cycle
      (unwrap-panic (as-max-len?
        (concat (get-token-x-depositors next-cycle)
          (get-token-x-depositors cycle)
        )
        u50
      ))
    )
    (map-delete token-y-depositor-list cycle)
    (map-delete token-x-depositor-list cycle)
  )
)

;; --- Maker / taker ----------------------------------------------------------
;;
;; Role is decided by entry point, not by a stored flag. `swap` is the taker
;; path: deposit, close and settle in one tx, paying TAKER_REBATE_BPS for the
;; immediate fill. The public deposit functions are the maker path: they refuse
;; any deposit that would cross live resting size on the other side, so the
;; only way to be filled in the same tx is to pay for it. Crossing means both
;; halves hold at the stored oracle price: the depositor's own limit is live,
;; AND the opposite side has at least one resting deposit whose limit is live.
;; Limits follow the settlement filters: y-limits are ceilings (a bid is live
;; while price <= limit), x-limits are floors (an offer is live while
;; price >= limit).
;;
;; The check reads only the OPPOSITE side. Reading your own side would let you
;; seed a dust maker deposit and walk real size in for free - for the same
;; reason the check also applies to top-ups of an existing deposit.
;;
;; Classification runs against a FRESH price. Each gated call carries a Pyth
;; VAA (the platform's frontend supplies it; the depositor only pays gas):
;; the market refreshes storage, then classifies, and reverts ERR_STALE_PRICE
;; if what is stored is still older than MAX_STALENESS - so a replayed old
;; VAA cannot fake freshness. Same window as settlement: the VAA is fetched
;; at broadcast, so like `swap` the tx must land within MAX_STALENESS of the
;; publish-time or it reverts and is retried with a fresh one.
;;
;; When the opposite side has no resting entries at all, no crossing is
;; possible at any price: the VAA is ignored (pass 0x) so an empty book
;; bootstraps - and exits always work - without a live oracle. Cancels never
;; read the price at all.
;;
;; Two feeds here, so the classification price is the same ratio settlement
;; computes: price-x scaled by PRICE_PRECISION over price-y.
;; The frontend predicts the gate by calling would-take-as-x/-y with the
;; price from the SAME Hermes payload whose VAA it will attach - never a
;; stored price, which can disagree with the VAA and mispredict.
(define-private (fresh-classification-price (vaa (buff 8192)))
  (begin
    (try! (contract-call? 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
      verify-and-update-price-feeds vaa {
      pyth-storage-contract: 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4,
      pyth-decoder-contract: 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-pnau-decoder-v3,
      wormhole-core-contract: 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.wormhole-core-v4,
    }))
    (let (
        (feed-x (unwrap!
          (contract-call?
            'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
            get-price (var-get oracle-feed-x)
          )
          ERR_ZERO_PRICE
        ))
        (feed-y (unwrap!
          (contract-call?
            'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
            get-price (var-get oracle-feed-y)
          )
          ERR_ZERO_PRICE
        ))
        (min-freshness (- stacks-block-time MAX_STALENESS))
      )
      (asserts! (> (get publish-time feed-x) min-freshness) ERR_STALE_PRICE)
      (asserts! (> (get publish-time feed-y) min-freshness) ERR_STALE_PRICE)
      (asserts! (> (get price feed-x) 0) ERR_ZERO_PRICE)
      (asserts! (> (get price feed-y) 0) ERR_ZERO_PRICE)
      (ok (/ (* (to-uint (get price feed-x)) PRICE_PRECISION)
        (to-uint (get price feed-y))
      ))
    )
  )
)

;; Resting size only counts as live when it is at least the market minimum.
;; Fresh deposits always are, but pro-rata roll remainders and small-share
;; rolls land in the next cycle below min with their limits intact - and if
;; that dust classified the other side, one live dust entry would block every
;; maker deposit opposite it while being too small for any FOK swap to clear.
;; Sub-min dust still settles normally; it is just invisible to the gate.
(define-private (live-bid-fold
    (depositor principal)
    (acc {
      price: uint,
      found: bool,
    })
  )
  (if (get found acc)
    acc
    (let ((amount (get-token-y-deposit (var-get current-cycle) depositor)))
      (if (and
          (> amount u0)
          (>= amount (var-get min-token-y-deposit))
          (<= (get price acc) (get-token-y-limit depositor))
        )
        (merge acc { found: true })
        acc
      )
    )
  )
)

(define-private (live-offer-fold
    (depositor principal)
    (acc {
      price: uint,
      found: bool,
    })
  )
  (if (get found acc)
    acc
    (let ((amount (get-token-x-deposit (var-get current-cycle) depositor)))
      (if (and
          (> amount u0)
          (>= amount (var-get min-token-x-deposit))
          (>= (get price acc) (get-token-x-limit depositor))
        )
        (merge acc { found: true })
        acc
      )
    )
  )
)

(define-read-only (would-take-as-x
    (price uint)
    (limit uint)
  )
  (and
    (> price u0)
    (>= price limit)
    (get found
      (fold live-bid-fold (get-token-y-depositors (var-get current-cycle)) {
        price: price,
        found: false,
      })
    )
  )
)

(define-read-only (would-take-as-y
    (price uint)
    (limit uint)
  )
  (and
    (> price u0)
    (<= price limit)
    (get found
      (fold live-offer-fold (get-token-x-depositors (var-get current-cycle)) {
        price: price,
        found: false,
      })
    )
  )
)

(define-private (deposit-token-y-core
    (amount uint)
    (limit-price uint)
    (t <ft-trait>)
    (asset-name (string-ascii 128))
  )
  (let (
      (cycle (var-get current-cycle))
      (existing (get-token-y-deposit cycle tx-sender))
      (totals (get-cycle-totals cycle))
      (depositors (get-token-y-depositors cycle))
      (tok-y (var-get token-y))
    )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-token-y-deposit)) ERR_DEPOSIT_TOO_SMALL)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (is-eq (contract-of t) tok-y) ERR_WRONG_TRAIT)

    (if (and (is-eq existing u0) (>= (len depositors) MAX_DEPOSITORS))
      (let (
          (smallest-info (fold find-smallest-token-y-fold depositors {
            cycle: cycle,
            smallest: u999999999999999999,
            smallest-principal: tx-sender,
          }))
          (smallest-amount (get smallest smallest-info))
          (smallest-who (get smallest-principal smallest-info))
        )
        (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)
        (try! (as-contract? ((with-stx smallest-amount))
          (try! (stx-transfer? smallest-amount current-contract smallest-who))
        ))
        (try! (stx-transfer? amount tx-sender current-contract))
        (var-set bumped-token-y-principal smallest-who)
        (map-set token-y-depositor-list cycle
          (unwrap-panic (as-max-len?
            (append (filter not-eq-bumped-token-y depositors) tx-sender) u50
          ))
        )
        (map-delete token-y-deposits {
          cycle: cycle,
          depositor: smallest-who,
        })
        (map-delete token-y-deposit-limits smallest-who)
        (map-set token-y-deposits {
          cycle: cycle,
          depositor: tx-sender,
        }
          amount
        )
        (map-set token-y-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-token-y: (+ (- (get total-token-y totals) smallest-amount) amount) })
        )
        (try! (contract-call? .jing-core-v3 log-deposit-y tx-sender amount amount
          limit-price cycle (some smallest-who) smallest-amount
          (var-get token-x) tok-y
        ))
        (ok amount)
      )
      (begin
        (try! (stx-transfer? amount tx-sender current-contract))
        (map-set token-y-deposits {
          cycle: cycle,
          depositor: tx-sender,
        }
          (+ existing amount)
        )
        (map-set token-y-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-token-y: (+ (get total-token-y totals) amount) })
        )
        (if (is-eq existing u0)
          (map-set token-y-depositor-list cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50))
          )
          true
        )
        (try! (contract-call? .jing-core-v3 log-deposit-y tx-sender (+ existing amount)
          amount limit-price cycle none u0 (var-get token-x) tok-y
        ))
        (ok amount)
      )
    )
  )
)

(define-public (deposit-token-y
    (amount uint)
    (limit-price uint)
    (vaa (buff 8192))
    (t <ft-trait>)
    (asset-name (string-ascii 128))
  )
  (begin
    (if (> (len (get-token-x-depositors (var-get current-cycle))) u0)
      (asserts!
        (not (would-take-as-y (try! (fresh-classification-price vaa)) limit-price))
        ERR_MUST_USE_SWAP
      )
      true
    )
    (deposit-token-y-core amount limit-price t asset-name)
  )
)

(define-private (deposit-token-x-core
    (amount uint)
    (limit-price uint)
    (t <ft-trait>)
    (asset-name (string-ascii 128))
  )
  (let (
      (cycle (var-get current-cycle))
      (existing (get-token-x-deposit cycle tx-sender))
      (totals (get-cycle-totals cycle))
      (depositors (get-token-x-depositors cycle))
      (tok-x (var-get token-x))
    )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (>= amount (var-get min-token-x-deposit)) ERR_DEPOSIT_TOO_SMALL)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (is-eq (contract-of t) tok-x) ERR_WRONG_TRAIT)
    (if (and (is-eq existing u0) (>= (len depositors) MAX_DEPOSITORS))
      (let (
          (smallest-info (fold find-smallest-token-x-fold depositors {
            cycle: cycle,
            smallest: u999999999999999999,
            smallest-principal: tx-sender,
          }))
          (smallest-amount (get smallest smallest-info))
          (smallest-who (get smallest-principal smallest-info))
        )
        (asserts! (> amount smallest-amount) ERR_QUEUE_FULL)
        (try! (as-contract? ((with-ft (contract-of t) asset-name smallest-amount))
          (try! (contract-call? t transfer smallest-amount current-contract
            smallest-who none
          ))
        ))
        (try! (contract-call? t transfer amount tx-sender current-contract none))
        (var-set bumped-token-x-principal smallest-who)
        (map-set token-x-depositor-list cycle
          (unwrap-panic (as-max-len?
            (append (filter not-eq-bumped-token-x depositors) tx-sender) u50
          ))
        )
        (map-delete token-x-deposits {
          cycle: cycle,
          depositor: smallest-who,
        })
        (map-delete token-x-deposit-limits smallest-who)
        (map-set token-x-deposits {
          cycle: cycle,
          depositor: tx-sender,
        }
          amount
        )
        (map-set token-x-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-token-x: (+ (- (get total-token-x totals) smallest-amount) amount) })
        )
        (try! (contract-call? .jing-core-v3 log-deposit-x tx-sender amount amount
          limit-price cycle (some smallest-who) smallest-amount tok-x
          (var-get token-y)
        ))
        (ok amount)
      )
      (begin
        (try! (contract-call? t transfer amount tx-sender current-contract none))
        (map-set token-x-deposits {
          cycle: cycle,
          depositor: tx-sender,
        }
          (+ existing amount)
        )
        (map-set token-x-deposit-limits tx-sender limit-price)
        (map-set cycle-totals cycle
          (merge totals { total-token-x: (+ (get total-token-x totals) amount) })
        )
        (if (is-eq existing u0)
          (map-set token-x-depositor-list cycle
            (unwrap-panic (as-max-len? (append depositors tx-sender) u50))
          )
          true
        )
        (try! (contract-call? .jing-core-v3 log-deposit-x tx-sender (+ existing amount)
          amount limit-price cycle none u0 tok-x (var-get token-y)
        ))
        (ok amount)
      )
    )
  )
)

(define-public (deposit-token-x
    (amount uint)
    (limit-price uint)
    (vaa (buff 8192))
    (t <ft-trait>)
    (asset-name (string-ascii 128))
  )
  (begin
    (if (> (len (get-token-y-depositors (var-get current-cycle))) u0)
      (asserts!
        (not (would-take-as-x (try! (fresh-classification-price vaa)) limit-price))
        ERR_MUST_USE_SWAP
      )
      true
    )
    (deposit-token-x-core amount limit-price t asset-name)
  )
)

(define-public (cancel-token-y-deposit
    (t <ft-trait>)
    (asset-name (string-ascii 128))
  )
  (let (
      (cycle (var-get current-cycle))
      (caller tx-sender)
      (amount (get-token-y-deposit cycle caller))
      (totals (get-cycle-totals cycle))
      (tok-y (var-get token-y))
    )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)
    (asserts! (is-eq (contract-of t) tok-y) ERR_WRONG_TRAIT)
    (try! (as-contract? ((with-stx amount))
      (try! (stx-transfer? amount current-contract caller))
    ))
    (map-delete token-y-deposits {
      cycle: cycle,
      depositor: caller,
    })
    (map-delete token-y-deposit-limits caller)
    (var-set bumped-token-y-principal caller)
    (map-set token-y-depositor-list cycle
      (filter not-eq-bumped-token-y (get-token-y-depositors cycle))
    )
    (map-set cycle-totals cycle
      (merge totals { total-token-y: (- (get total-token-y totals) amount) })
    )
    (try! (contract-call? .jing-core-v3 log-refund-y caller amount cycle
      (var-get token-x) tok-y
    ))
    (ok amount)
  )
)

(define-public (cancel-token-x-deposit
    (t <ft-trait>)
    (asset-name (string-ascii 128))
  )
  (let (
      (cycle (var-get current-cycle))
      (caller tx-sender)
      (amount (get-token-x-deposit cycle caller))
      (totals (get-cycle-totals cycle))
      (tok-x (var-get token-x))
    )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)
    (asserts! (is-eq (contract-of t) tok-x) ERR_WRONG_TRAIT)
    (try! (as-contract? ((with-ft (contract-of t) asset-name amount))
      (try! (contract-call? t transfer amount current-contract caller none))
    ))
    (map-delete token-x-deposits {
      cycle: cycle,
      depositor: caller,
    })
    (map-delete token-x-deposit-limits caller)
    (var-set bumped-token-x-principal caller)
    (map-set token-x-depositor-list cycle
      (filter not-eq-bumped-token-x (get-token-x-depositors cycle))
    )
    (map-set cycle-totals cycle
      (merge totals { total-token-x: (- (get total-token-x totals) amount) })
    )
    (try! (contract-call? .jing-core-v3 log-refund-x caller amount cycle tok-x
      (var-get token-y)
    ))
    (ok amount)
  )
)

;; Same gate as the deposits: without it, a depositor could enter with a dead
;; limit (passing the maker gate) and then retarget the limit into the live
;; range - a crossing position built without ever touching `swap`.
(define-public (set-token-y-limit
    (limit-price uint)
    (vaa (buff 8192))
  )
  (begin
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (> (get-token-y-deposit (var-get current-cycle) tx-sender) u0)
      ERR_NOTHING_TO_WITHDRAW
    )
    (if (> (len (get-token-x-depositors (var-get current-cycle))) u0)
      (asserts!
        (not (would-take-as-y (try! (fresh-classification-price vaa)) limit-price))
        ERR_MUST_USE_SWAP
      )
      true
    )
    (map-set token-y-deposit-limits tx-sender limit-price)
    (try! (contract-call? .jing-core-v3 log-set-limit-y tx-sender limit-price
      (var-get token-x) (var-get token-y)
    ))
    (ok true)
  )
)

(define-public (set-token-x-limit
    (limit-price uint)
    (vaa (buff 8192))
  )
  (begin
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (> (get-token-x-deposit (var-get current-cycle) tx-sender) u0)
      ERR_NOTHING_TO_WITHDRAW
    )
    (if (> (len (get-token-y-depositors (var-get current-cycle))) u0)
      (asserts!
        (not (would-take-as-x (try! (fresh-classification-price vaa)) limit-price))
        ERR_MUST_USE_SWAP
      )
      true
    )
    (map-set token-x-deposit-limits tx-sender limit-price)
    (try! (contract-call? .jing-core-v3 log-set-limit-x tx-sender limit-price
      (var-get token-x) (var-get token-y)
    ))
    (ok true)
  )
)

;; --- Reprice with take-through -----------------------------------------------
;;
;; set-token-*-limit refuses a limit that crosses live resting size
;; (ERR_MUST_USE_SWAP): a maker must not become a taker for free. These are the
;; paid versions of the same move. If the new limit does NOT cross (or nothing
;; live rests opposite), they are exactly set-token-*-limit: the limit moves
;; and the deposit keeps resting. If it DOES cross, the caller's whole resting
;; deposit turns taker on the spot with `swap`'s economics: TAKER_REBATE_BPS
;; is charged on the resting amount (transferred fresh, on top of what already
;; rests, so the resting size itself is what settles), the cycle closes and
;; settles in this tx, and the fill is all-or-nothing - the caller must clear
;; 100% or the whole tx reverts, reprice included, and the old limit stands.
;; The same VAA drives classification and settlement, so the price that says
;; "you cross" is the price the fill happens at.

(define-public (reprice-or-swap-token-y
    (limit-price uint)
    (vaa (buff 8192))
    (tx-trait <ft-trait>)
    (tx-name (string-ascii 128))
    (ty-trait <ft-trait>)
    (ty-name (string-ascii 128))
  )
  (let (
      (cycle (var-get current-cycle))
      (amount (get-token-y-deposit cycle tx-sender))
    )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)
    (asserts! (is-eq (contract-of tx-trait) (var-get token-x)) ERR_WRONG_TRAIT)
    (asserts! (is-eq (contract-of ty-trait) (var-get token-y)) ERR_WRONG_TRAIT)
    (map-set token-y-deposit-limits tx-sender limit-price)
    (try! (contract-call? .jing-core-v3 log-set-limit-y tx-sender limit-price
      (var-get token-x) (var-get token-y)
    ))
    (if (and
        (> (len (get-token-x-depositors cycle)) u0)
        (would-take-as-y (try! (fresh-classification-price vaa)) limit-price)
      )
      (let ((rebate (/ (* amount TAKER_REBATE_BPS) BPS_PRECISION)))
        (and
          (> rebate u0)
          (try! (stx-transfer? rebate tx-sender current-contract))
        )
        (var-set pending-rebate-y rebate)
        (try! (close-deposits))
        (let ((result (try! (settle-with-refresh vaa tx-trait tx-name ty-trait ty-name))))
          (asserts! (> (get token-x-received result) u0) ERR_NOTHING_FILLED)
          (asserts! (is-eq (get token-y-rolled result) u0) ERR_PARTIAL_FILL)
          (ok result)
        )
      )
      (ok {
        token-x-received: u0,
        token-y-rolled: u0,
        token-y-received: u0,
        token-x-rolled: u0,
      })
    )
  )
)

(define-public (reprice-or-swap-token-x
    (limit-price uint)
    (vaa (buff 8192))
    (tx-trait <ft-trait>)
    (tx-name (string-ascii 128))
    (ty-trait <ft-trait>)
    (ty-name (string-ascii 128))
  )
  (let (
      (cycle (var-get current-cycle))
      (amount (get-token-x-deposit cycle tx-sender))
    )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_NOT_DEPOSIT_PHASE)
    (asserts! (> limit-price u0) ERR_LIMIT_REQUIRED)
    (asserts! (> amount u0) ERR_NOTHING_TO_WITHDRAW)
    (asserts! (is-eq (contract-of tx-trait) (var-get token-x)) ERR_WRONG_TRAIT)
    (asserts! (is-eq (contract-of ty-trait) (var-get token-y)) ERR_WRONG_TRAIT)
    (map-set token-x-deposit-limits tx-sender limit-price)
    (try! (contract-call? .jing-core-v3 log-set-limit-x tx-sender limit-price
      (var-get token-x) (var-get token-y)
    ))
    (if (and
        (> (len (get-token-y-depositors cycle)) u0)
        (would-take-as-x (try! (fresh-classification-price vaa)) limit-price)
      )
      (let ((rebate (/ (* amount TAKER_REBATE_BPS) BPS_PRECISION)))
        (and
          (> rebate u0)
          (try! (contract-call? tx-trait transfer rebate tx-sender current-contract
            none
          ))
        )
        (var-set pending-rebate-x rebate)
        (try! (close-deposits))
        (let ((result (try! (settle-with-refresh vaa tx-trait tx-name ty-trait ty-name))))
          (asserts! (> (get token-y-received result) u0) ERR_NOTHING_FILLED)
          (asserts! (is-eq (get token-x-rolled result) u0) ERR_PARTIAL_FILL)
          (ok result)
        )
      )
      (ok {
        token-x-received: u0,
        token-y-rolled: u0,
        token-y-received: u0,
        token-x-rolled: u0,
      })
    )
  )
)

(define-private (filter-small-token-y-depositor (depositor principal))
  (let (
      (cycle (var-get current-cycle))
      (totals (get-cycle-totals cycle))
      (total-token-y (get total-token-y totals))
      (amount (get-token-y-deposit cycle depositor))
      (next-cycle (+ cycle u1))
      (totals-next (get-cycle-totals next-cycle))
    )
    (if (< (* amount BPS_PRECISION) (* total-token-y MIN_SHARE_BPS))
      (begin
        (map-set token-y-deposits {
          cycle: next-cycle,
          depositor: depositor,
        }
          amount
        )
        (map-set token-y-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-y-depositors next-cycle) depositor) u50))
        )
        (map-set cycle-totals next-cycle
          (merge totals-next { total-token-y: (+ (get total-token-y totals-next) amount) })
        )
        (map-delete token-y-deposits {
          cycle: cycle,
          depositor: depositor,
        })
        (var-set bumped-token-y-principal depositor)
        (map-set token-y-depositor-list cycle
          (filter not-eq-bumped-token-y (get-token-y-depositors cycle))
        )
        (map-set cycle-totals cycle
          (merge totals { total-token-y: (- total-token-y amount) })
        )
        (try! (contract-call? .jing-core-v3 log-small-share-roll-y depositor cycle
          amount (var-get token-x) (var-get token-y)
        ))
        (ok true)
      )
      (ok true)
    )
  )
)

(define-private (filter-small-token-x-depositor (depositor principal))
  (let (
      (cycle (var-get current-cycle))
      (totals (get-cycle-totals cycle))
      (total-token-x (get total-token-x totals))
      (amount (get-token-x-deposit cycle depositor))
      (next-cycle (+ cycle u1))
      (totals-next (get-cycle-totals next-cycle))
    )
    (if (< (* amount BPS_PRECISION) (* total-token-x MIN_SHARE_BPS))
      (begin
        (map-set token-x-deposits {
          cycle: next-cycle,
          depositor: depositor,
        }
          amount
        )
        (map-set token-x-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-x-depositors next-cycle) depositor) u50))
        )
        (map-set cycle-totals next-cycle
          (merge totals-next { total-token-x: (+ (get total-token-x totals-next) amount) })
        )
        (map-delete token-x-deposits {
          cycle: cycle,
          depositor: depositor,
        })
        (var-set bumped-token-x-principal depositor)
        (map-set token-x-depositor-list cycle
          (filter not-eq-bumped-token-x (get-token-x-depositors cycle))
        )
        (map-set cycle-totals cycle
          (merge totals { total-token-x: (- total-token-x amount) })
        )
        (try! (contract-call? .jing-core-v3 log-small-share-roll-x depositor cycle
          amount (var-get token-x) (var-get token-y)
        ))
        (ok true)
      )
      (ok true)
    )
  )
)

(define-private (filter-limit-violating-token-y-depositor (depositor principal))
  (let (
      (cycle (var-get current-cycle))
      (totals (get-cycle-totals cycle))
      (amount (get-token-y-deposit cycle depositor))
      (next-cycle (+ cycle u1))
      (totals-next (get-cycle-totals next-cycle))
      (limit (get-token-y-limit depositor))
      (clearing (var-get settle-clearing-price))
    )
    (if (> clearing limit)
      (begin
        (map-set token-y-deposits {
          cycle: next-cycle,
          depositor: depositor,
        }
          amount
        )
        (map-set token-y-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-y-depositors next-cycle) depositor) u50))
        )
        (map-set cycle-totals next-cycle
          (merge totals-next { total-token-y: (+ (get total-token-y totals-next) amount) })
        )
        (map-delete token-y-deposits {
          cycle: cycle,
          depositor: depositor,
        })
        (var-set bumped-token-y-principal depositor)
        (map-set token-y-depositor-list cycle
          (filter not-eq-bumped-token-y (get-token-y-depositors cycle))
        )
        (map-set cycle-totals cycle
          (merge totals { total-token-y: (- (get total-token-y totals) amount) })
        )
        (try! (contract-call? .jing-core-v3 log-limit-roll-y depositor cycle amount
          limit clearing (var-get token-x) (var-get token-y)
        ))
        (ok true)
      )
      (ok true)
    )
  )
)

(define-private (filter-limit-violating-token-x-depositor (depositor principal))
  (let (
      (cycle (var-get current-cycle))
      (totals (get-cycle-totals cycle))
      (amount (get-token-x-deposit cycle depositor))
      (next-cycle (+ cycle u1))
      (totals-next (get-cycle-totals next-cycle))
      (limit (get-token-x-limit depositor))
      (clearing (var-get settle-clearing-price))
    )
    (if (< clearing limit)
      (begin
        (map-set token-x-deposits {
          cycle: next-cycle,
          depositor: depositor,
        }
          amount
        )
        (map-set token-x-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-x-depositors next-cycle) depositor) u50))
        )
        (map-set cycle-totals next-cycle
          (merge totals-next { total-token-x: (+ (get total-token-x totals-next) amount) })
        )
        (map-delete token-x-deposits {
          cycle: cycle,
          depositor: depositor,
        })
        (var-set bumped-token-x-principal depositor)
        (map-set token-x-depositor-list cycle
          (filter not-eq-bumped-token-x (get-token-x-depositors cycle))
        )
        (map-set cycle-totals cycle
          (merge totals { total-token-x: (- (get total-token-x totals) amount) })
        )
        (try! (contract-call? .jing-core-v3 log-limit-roll-x depositor cycle amount
          limit clearing (var-get token-x) (var-get token-y)
        ))
        (ok true)
      )
      (ok true)
    )
  )
)

(define-public (close-deposits)
  (let (
      (cycle (var-get current-cycle))
      (elapsed (get-blocks-elapsed))
      (totals (get-cycle-totals cycle))
    )
    (asserts! (is-eq (get-cycle-phase) PHASE_DEPOSIT) ERR_ALREADY_CLOSED)
    (asserts!
      (and
        (>= (get total-token-y totals) (var-get min-token-y-deposit))
        (>= (get total-token-x totals) (var-get min-token-x-deposit))
      )
      ERR_NOTHING_TO_SETTLE
    )
    (map filter-small-token-y-depositor (get-token-y-depositors cycle))
    (map filter-small-token-x-depositor (get-token-x-depositors cycle))
    (var-set deposits-closed-block stacks-block-height)
    (try! (contract-call? .jing-core-v3 log-close-deposits cycle stacks-block-height
      elapsed (var-get token-x) (var-get token-y)
    ))
    (ok true)
  )
)

(define-public (settle
    (tx-trait <ft-trait>)
    (tx-name (string-ascii 128))
    (ty-trait <ft-trait>)
    (ty-name (string-ascii 128))
  )
  (let (
      (feed-x (unwrap!
        (contract-call?
          'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4 get-price
          (var-get oracle-feed-x)
        )
        ERR_ZERO_PRICE
      ))
      (feed-y (unwrap!
        (contract-call?
          'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4 get-price
          (var-get oracle-feed-y)
        )
        ERR_ZERO_PRICE
      ))
      (cycle (var-get current-cycle))
    )
    (asserts! (is-eq (contract-of tx-trait) (var-get token-x)) ERR_WRONG_TRAIT)
    (asserts! (is-eq (contract-of ty-trait) (var-get token-y)) ERR_WRONG_TRAIT)
    (try! (execute-settlement cycle feed-x feed-y tx-trait tx-name ty-trait ty-name))
    (var-set acc-token-x-out u0)
    (var-set acc-token-y-out u0)
    (var-set acc-token-y-rolled u0)
    (var-set acc-token-x-rolled u0)
    (var-set caller-token-x-received u0)
    (var-set caller-token-y-rolled u0)
    (var-set caller-token-y-received u0)
    (var-set caller-token-x-rolled u0)
    (try! (fold distribute-to-token-y-depositor (get-token-y-depositors cycle)
      (ok {
        t: tx-trait,
        name: tx-name,
      })
    ))
    (try! (fold distribute-to-token-x-depositor (get-token-x-depositors cycle)
      (ok {
        t: ty-trait,
        name: ty-name,
      })
    ))
    (try! (roll-and-sweep-dust tx-trait tx-name ty-trait ty-name))
    (advance-cycle)
    (ok {
      token-x-received: (var-get caller-token-x-received),
      token-y-rolled: (var-get caller-token-y-rolled),
      token-y-received: (var-get caller-token-y-received),
      token-x-rolled: (var-get caller-token-x-rolled),
    })
  )
)

;; The Pyth execution plan is hard-coded rather than taken as trait arguments.
;; pyth-governance-v3 already validates whatever is passed, so this buys no
;; extra safety against a malicious caller. It buys independence from what Pyth
;; changes underneath: nothing a caller supplies can steer which contracts this
;; market talks to. If Pyth rotates the storage, decoder or wormhole contract,
;; this market is redeployed deliberately instead of silently following.
;; One bundled multi-feed VAA (Hermes multi-id query) refreshes BOTH feeds in
;; a single verify. Correctness does not rest on the caller bundling
;; properly: execute-settlement asserts publish-time freshness on each feed,
;; so a VAA covering only one of them leaves the other stale and the settle
;; reverts ERR_STALE_PRICE. v1 took two VAA slots for caller flexibility, but
;; in practice both slots always carried the same bundle - the second verify
;; re-checked identical bytes.
(define-public (settle-with-refresh
    (vaa (buff 8192))
    (tx-trait <ft-trait>)
    (tx-name (string-ascii 128))
    (ty-trait <ft-trait>)
    (ty-name (string-ascii 128))
  )
  (begin
    (asserts! (is-eq (contract-of tx-trait) (var-get token-x)) ERR_WRONG_TRAIT)
    (asserts! (is-eq (contract-of ty-trait) (var-get token-y)) ERR_WRONG_TRAIT)
    (try! (contract-call? 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4
      verify-and-update-price-feeds vaa {
      pyth-storage-contract: 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4,
      pyth-decoder-contract: 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-pnau-decoder-v3,
      wormhole-core-contract: 'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.wormhole-core-v4,
    }))
    (let (
        (feed-x (unwrap!
          (contract-call?
            'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
            get-price (var-get oracle-feed-x)
          )
          ERR_ZERO_PRICE
        ))
        (feed-y (unwrap!
          (contract-call?
            'SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4
            get-price (var-get oracle-feed-y)
          )
          ERR_ZERO_PRICE
        ))
        (cycle (var-get current-cycle))
      )
      (try! (execute-settlement cycle feed-x feed-y tx-trait tx-name ty-trait ty-name))
      (var-set acc-token-x-out u0)
      (var-set acc-token-y-out u0)
      (var-set acc-token-y-rolled u0)
      (var-set acc-token-x-rolled u0)
      (var-set caller-token-x-received u0)
      (var-set caller-token-y-rolled u0)
      (var-set caller-token-y-received u0)
      (var-set caller-token-x-rolled u0)
      (try! (fold distribute-to-token-y-depositor (get-token-y-depositors cycle)
        (ok {
          t: tx-trait,
          name: tx-name,
        })
      ))
      (try! (fold distribute-to-token-x-depositor (get-token-x-depositors cycle)
        (ok {
          t: ty-trait,
          name: ty-name,
        })
      ))
      (try! (roll-and-sweep-dust tx-trait tx-name ty-trait ty-name))
      (advance-cycle)
      (ok {
        token-x-received: (var-get caller-token-x-received),
        token-y-rolled: (var-get caller-token-y-rolled),
        token-y-received: (var-get caller-token-y-received),
        token-x-rolled: (var-get caller-token-x-rolled),
      })
    )
  )
)

(define-public (close-and-settle-with-refresh
    (vaa (buff 8192))
    (tx-trait <ft-trait>)
    (tx-name (string-ascii 128))
    (ty-trait <ft-trait>)
    (ty-name (string-ascii 128))
  )
  (begin
    (try! (close-deposits))
    (settle-with-refresh vaa tx-trait tx-name ty-trait ty-name)
  )
)

(define-public (swap
    (amount uint)
    (limit-price uint)
    (vaa (buff 8192))
    (tx-trait <ft-trait>)
    (tx-name (string-ascii 128))
    (ty-trait <ft-trait>)
    (ty-name (string-ascii 128))
    (deposit-x bool)
  )
  ;; The taker pays TAKER_REBATE_BPS on top of FEE_BPS. It is taken off the
  ;; deposit here rather than at settlement so the maths stays inside the
  ;; existing pro-rata machinery: the taker is credited for `net` only, and the
  ;; withheld slice is handed to the other side's filled depositors below.
  (let (
      (rebate (/ (* amount TAKER_REBATE_BPS) BPS_PRECISION))
      (net (- amount rebate))
    )
    (asserts! (> net u0) ERR_DEPOSIT_TOO_SMALL)
    (if deposit-x
      (begin
        (and
          (> rebate u0)
          (try! (contract-call? tx-trait transfer rebate tx-sender current-contract
            none
          ))
        )
        (var-set pending-rebate-x rebate)
        (try! (deposit-token-x-core net limit-price tx-trait tx-name))
      )
      (begin
        (and (> rebate u0) (try! (stx-transfer? rebate tx-sender current-contract)))
        (var-set pending-rebate-y rebate)
        (try! (deposit-token-y-core net limit-price ty-trait ty-name))
      )
    )
    (try! (close-deposits))
    ;; Fill-or-kill. The 20 bps buys full immediate execution, so a swap that
    ;; would fill nothing (limit rolled out, nothing live resting) or only
    ;; partially (rolled remainder would rest as an unwanted maker position,
    ;; with the rebate overpaid on the unfilled part) reverts instead. Swap is
    ;; atomic, so the parked rebate unwinds with it rather than being gifted
    ;; to the other side. A taker who wants to rest the remainder swaps the
    ;; absorbable size, then maker-deposits the rest in a second tx.
    (let ((result (try! (settle-with-refresh vaa tx-trait tx-name ty-trait ty-name))))
      (asserts!
        (>
          (if deposit-x
            (get token-y-received result)
            (get token-x-received result)
          )
          u0
        )
        ERR_NOTHING_FILLED
      )
      (asserts!
        (is-eq
          (if deposit-x
            (get token-x-rolled result)
            (get token-y-rolled result)
          )
          u0
        )
        ERR_PARTIAL_FILL
      )
      (ok result)
    )
  )
)

(define-public (cancel-cycle)
  (let (
      (cycle (var-get current-cycle))
      (closed-block (var-get deposits-closed-block))
      (totals (get-cycle-totals cycle))
      (totals-next (get-cycle-totals (+ cycle u1)))
      (merged-x (+ (get total-token-x totals) (get total-token-x totals-next)))
      (merged-y (+ (get total-token-y totals) (get total-token-y totals-next)))
    )
    (asserts! (> closed-block u0) ERR_NOT_SETTLE_PHASE)
    (asserts! (>= stacks-block-height (+ closed-block CANCEL_THRESHOLD))
      ERR_CANCEL_TOO_EARLY
    )
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    (map-set cycle-totals (+ cycle u1) {
      total-token-x: merged-x,
      total-token-y: merged-y,
    })
    (map-delete cycle-totals cycle)
    (map roll-token-y-depositor (get-token-y-depositors cycle))
    (map roll-token-x-depositor (get-token-x-depositors cycle))
    (roll-depositor-lists cycle)
    (advance-cycle)
    (try! (contract-call? .jing-core-v3 log-cancel-cycle cycle merged-x merged-y
      (var-get token-x) (var-get token-y)
    ))
    (ok true)
  )
)

(define-private (execute-settlement
    (cycle uint)
    (feed-x {
      price: int,
      conf: uint,
      expo: int,
      ema-price: int,
      ema-conf: uint,
      publish-time: uint,
      prev-publish-time: uint,
    })
    (feed-y {
      price: int,
      conf: uint,
      expo: int,
      ema-price: int,
      ema-conf: uint,
      publish-time: uint,
      prev-publish-time: uint,
    })
    (tx-trait <ft-trait>)
    (tx-name (string-ascii 128))
    (ty-trait <ft-trait>)
    (ty-name (string-ascii 128))
  )
  (let (
      (price-x (to-uint (get price feed-x)))
      (price-y (to-uint (get price feed-y)))
      (min-freshness (- stacks-block-time MAX_STALENESS))
    )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-eq (get-cycle-phase) PHASE_SETTLE) ERR_NOT_SETTLE_PHASE)
    (asserts! (is-none (map-get? settlements cycle)) ERR_ALREADY_SETTLED)
    (asserts! (> price-x u0) ERR_ZERO_PRICE)
    (asserts! (> price-y u0) ERR_ZERO_PRICE)
    (asserts! (> (get publish-time feed-x) min-freshness) ERR_STALE_PRICE)
    (asserts! (> (get publish-time feed-y) min-freshness) ERR_STALE_PRICE)
    (asserts! (< (get conf feed-x) (/ price-x MAX_CONF_RATIO))
      ERR_PRICE_UNCERTAIN
    )
    (asserts! (< (get conf feed-y) (/ price-y MAX_CONF_RATIO))
      ERR_PRICE_UNCERTAIN
    )
    (asserts! (is-eq (get expo feed-x) (get expo feed-y)) ERR_EXPO_MISMATCH)
    (let ((oracle-price (/ (* price-x PRICE_PRECISION) price-y)))
      (asserts! (> oracle-price u0) ERR_ZERO_PRICE)

      (var-set settle-clearing-price oracle-price)
      (map filter-limit-violating-token-y-depositor
        (get-token-y-depositors cycle)
      )
      (map filter-limit-violating-token-x-depositor
        (get-token-x-depositors cycle)
      )
      (let (
          (totals (get-cycle-totals cycle))
          (total-token-y (get total-token-y totals))
          (total-token-x (get total-token-x totals))
          (token-y-value-of-token-x (/ (* total-token-x oracle-price) (* PRICE_PRECISION DECIMAL_FACTOR)))
          (token-x-is-binding (<= token-y-value-of-token-x total-token-y))
          (token-y-clearing (if token-x-is-binding
            token-y-value-of-token-x
            total-token-y
          ))
          (token-x-clearing (if token-x-is-binding
            total-token-x
            (/ (* total-token-y (* PRICE_PRECISION DECIMAL_FACTOR)) oracle-price)
          ))
          (token-y-fee (/ (* token-y-clearing FEE_BPS) BPS_PRECISION))
          (token-x-fee (/ (* token-x-clearing FEE_BPS) BPS_PRECISION))
          (token-y-unfilled (- total-token-y token-y-clearing))
          (token-x-unfilled (- total-token-x token-x-clearing))
          ;; Bound here because the vars are zeroed below, before the log call.
          (rebate-x (var-get pending-rebate-x))
          (rebate-y (var-get pending-rebate-y))
        )
        (asserts!
          (and
            (>= total-token-y (var-get min-token-y-deposit))
            (>= total-token-x (var-get min-token-x-deposit))
          )
          ERR_NOTHING_TO_SETTLE
        )
        (map-set settlements cycle {
          price: oracle-price,
          token-y-cleared: token-y-clearing,
          token-x-cleared: token-x-clearing,
          token-y-fee: token-y-fee,
          token-x-fee: token-x-fee,
          settled-at: stacks-block-height,
        })
        (if (> token-y-fee u0)
          (try! (as-contract? ((with-stx token-y-fee))
            (try! (stx-transfer? token-y-fee current-contract (var-get treasury)))
          ))
          true
        )
        (if (> token-x-fee u0)
          (try! (as-contract? ((with-ft (contract-of tx-trait) tx-name token-x-fee))
            (try! (contract-call? tx-trait transfer token-x-fee current-contract
              (var-get treasury) none
            ))
          ))
          true
        )
        (var-set settle-token-y-cleared token-y-clearing)
        (var-set settle-token-x-cleared token-x-clearing)
        (var-set settle-total-token-y total-token-y)
        (var-set settle-total-token-x total-token-x)
        ;; The taker's rebate rides along with the pool it is paid out of: token-x
        ;; the taker sent is what token-y depositors receive, so adding it here
        ;; splits it across exactly the makers who filled, in proportion to their
        ;; fill. Zeroed immediately so a later settlement cannot pay it twice.
        (var-set settle-token-x-after-fee
          (+ (- token-x-clearing token-x-fee) rebate-x)
        )
        (var-set settle-token-y-after-fee
          (+ (- token-y-clearing token-y-fee) rebate-y)
        )
        (var-set pending-rebate-x u0)
        (var-set pending-rebate-y u0)
        (try! (contract-call? .jing-core-v3 log-settlement cycle oracle-price
          oracle-price token-x-clearing token-y-clearing token-x-unfilled
          token-y-unfilled token-x-fee token-y-fee rebate-x rebate-y
          token-x-is-binding (var-get token-x) (var-get token-y)
        ))
        (ok true)
      )
    )
  )
)

(define-private (distribute-to-token-y-depositor
    (depositor principal)
    (acc (response {
      t: <ft-trait>,
      name: (string-ascii 128),
    } uint
    ))
  )
  (let (
      (unwrapped (try! acc))
      (tt (get t unwrapped))
      (cycle (var-get current-cycle))
      (my-deposit (get-token-y-deposit cycle depositor))
      (total-token-y (var-get settle-total-token-y))
      (my-token-x-received (if (> total-token-y u0)
        (/ (* my-deposit (var-get settle-token-x-after-fee)) total-token-y)
        u0
      ))
      (my-token-y-unfilled (if (> total-token-y u0)
        (/ (* my-deposit (- total-token-y (var-get settle-token-y-cleared)))
          total-token-y
        )
        u0
      ))
      (my-token-y-cleared (- my-deposit my-token-y-unfilled))
      (next-cycle (+ cycle u1))
    )
    (map-delete token-y-deposits {
      cycle: cycle,
      depositor: depositor,
    })
    (var-set acc-token-x-out (+ (var-get acc-token-x-out) my-token-x-received))
    (var-set acc-token-y-rolled
      (+ (var-get acc-token-y-rolled) my-token-y-unfilled)
    )
    (if (is-eq depositor tx-sender)
      (begin
        (var-set caller-token-x-received my-token-x-received)
        (var-set caller-token-y-rolled my-token-y-unfilled)
        true
      )
      true
    )
    (if (> my-token-x-received u0)
      (try! (as-contract?
        ((with-ft (contract-of tt) (get name unwrapped) my-token-x-received))
        (try! (contract-call? tt transfer my-token-x-received current-contract
          depositor none
        ))
      ))
      true
    )
    (if (> my-token-y-unfilled u0)
      (begin
        (map-set token-y-deposits {
          cycle: next-cycle,
          depositor: depositor,
        }
          my-token-y-unfilled
        )
        (map-set token-y-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-y-depositors next-cycle) depositor) u50))
        )
        true
      )
      (begin
        (map-delete token-y-deposit-limits depositor)
        true
      )
    )
    (try! (contract-call? .jing-core-v3 log-distribute-y-depositor depositor cycle
      my-token-x-received my-token-y-cleared my-token-y-unfilled
      (var-get token-x) (var-get token-y)
    ))
    (ok unwrapped)
  )
)

(define-private (distribute-to-token-x-depositor
    (depositor principal)
    (acc (response {
      t: <ft-trait>,
      name: (string-ascii 128),
    } uint
    ))
  )
  (let (
      (unwrapped (try! acc))
      (tt (get t unwrapped))
      (cycle (var-get current-cycle))
      (my-deposit (get-token-x-deposit cycle depositor))
      (total-token-x (var-get settle-total-token-x))
      (my-token-y-received (if (> total-token-x u0)
        (/ (* my-deposit (var-get settle-token-y-after-fee)) total-token-x)
        u0
      ))
      (my-token-x-unfilled (if (> total-token-x u0)
        (/ (* my-deposit (- total-token-x (var-get settle-token-x-cleared)))
          total-token-x
        )
        u0
      ))
      (my-token-x-cleared (- my-deposit my-token-x-unfilled))
      (next-cycle (+ cycle u1))
    )
    (map-delete token-x-deposits {
      cycle: cycle,
      depositor: depositor,
    })
    (var-set acc-token-y-out (+ (var-get acc-token-y-out) my-token-y-received))
    (var-set acc-token-x-rolled
      (+ (var-get acc-token-x-rolled) my-token-x-unfilled)
    )
    (if (is-eq depositor tx-sender)
      (begin
        (var-set caller-token-y-received my-token-y-received)
        (var-set caller-token-x-rolled my-token-x-unfilled)
        true
      )
      true
    )
    (if (> my-token-y-received u0)
      (try! (as-contract? ((with-stx my-token-y-received))
        (try! (stx-transfer? my-token-y-received current-contract depositor))
      ))
      true
    )
    (if (> my-token-x-unfilled u0)
      (begin
        (map-set token-x-deposits {
          cycle: next-cycle,
          depositor: depositor,
        }
          my-token-x-unfilled
        )
        (map-set token-x-depositor-list next-cycle
          (unwrap-panic (as-max-len? (append (get-token-x-depositors next-cycle) depositor) u50))
        )
        true
      )
      (begin
        (map-delete token-x-deposit-limits depositor)
        true
      )
    )
    (try! (contract-call? .jing-core-v3 log-distribute-x-depositor depositor cycle
      my-token-y-received my-token-x-cleared my-token-x-unfilled
      (var-get token-x) (var-get token-y)
    ))
    (ok unwrapped)
  )
)

(define-private (roll-and-sweep-dust
    (tx-trait <ft-trait>)
    (tx-name (string-ascii 128))
    (ty-trait <ft-trait>)
    (ty-name (string-ascii 128))
  )
  (let (
      (acc-token-y-rol (var-get acc-token-y-rolled))
      (acc-token-x-rol (var-get acc-token-x-rolled))
      (token-y-payout-dust (- (var-get settle-token-y-after-fee) (var-get acc-token-y-out)))
      (token-y-roll-dust (- (- (var-get settle-total-token-y) (var-get settle-token-y-cleared))
        acc-token-y-rol
      ))
      (token-y-dust (+ token-y-payout-dust token-y-roll-dust))
      (token-x-payout-dust (- (var-get settle-token-x-after-fee) (var-get acc-token-x-out)))
      (token-x-roll-dust (- (- (var-get settle-total-token-x) (var-get settle-token-x-cleared))
        acc-token-x-rol
      ))
      (token-x-dust (+ token-x-payout-dust token-x-roll-dust))
      (next-cycle (+ (var-get current-cycle) u1))
      (next-totals (get-cycle-totals next-cycle))
    )
    (map-set cycle-totals next-cycle {
      total-token-y: (+ (get total-token-y next-totals) acc-token-y-rol),
      total-token-x: (+ (get total-token-x next-totals) acc-token-x-rol),
    })
    (if (> token-y-dust u0)
      (try! (as-contract? ((with-stx token-y-dust))
        (try! (stx-transfer? token-y-dust current-contract (var-get treasury)))
      ))
      true
    )
    (if (> token-x-dust u0)
      (try! (as-contract? ((with-ft (contract-of tx-trait) tx-name token-x-dust))
        (try! (contract-call? tx-trait transfer token-x-dust current-contract
          (var-get treasury) none
        ))
      ))
      true
    )
    (try! (contract-call? .jing-core-v3 log-sweep-dust acc-token-x-rol acc-token-y-rol
      token-x-dust token-x-payout-dust token-x-roll-dust token-y-dust
      token-y-payout-dust token-y-roll-dust (var-get token-x)
      (var-get token-y)
    ))
    (ok true)
  )
)

(define-public (initialize
    (canonical principal)
    (x principal)
    (y principal)
    (min-x uint)
    (min-y uint)
    (feed-x (buff 32))
    (feed-y (buff 32))
  )
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (asserts! (is-eq tx-sender (contract-call? .jing-core-v3 get-contract-owner))
      ERR_NOT_AUTHORIZED
    )
    (asserts! (not (var-get initialized)) ERR_ALREADY_INITIALIZED)
    (var-set token-x x)
    (var-set token-y y)
    (var-set min-token-x-deposit min-x)
    (var-set min-token-y-deposit min-y)
    (var-set oracle-feed-x feed-x)
    (var-set oracle-feed-y feed-y)
    (var-set initialized true)
    (try! (contract-call? .jing-core-v3 register canonical))
    (ok true)
  )
)

(define-public (set-treasury (new-treasury principal))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set treasury new-treasury))
  )
)

(define-public (set-paused (is-paused bool))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set paused is-paused))
  )
)

(define-public (set-operator (new-operator principal))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set operator new-operator))
  )
)

(define-public (set-min-token-y-deposit (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set min-token-y-deposit amount))
  )
)

(define-public (set-min-token-x-deposit (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set min-token-x-deposit amount))
  )
)
