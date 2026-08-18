(define-constant ERR_NOT_AUTHORIZED (err u5001))
(define-constant ERR_INVALID_CONTRACT_HASH (err u5002))
(define-constant ERR_ALREADY_REGISTERED (err u5003))
(define-constant ERR_NOT_VERIFIED (err u5005))
(define-constant ERR_HASH_MISMATCH (err u5006))
(define-constant ERR_TIMELOCK_NOT_ELAPSED (err u5008))
(define-constant ERR_PAUSED (err u5016))
(define-constant ERR_NOT_PAUSED (err u5017))
(define-constant ERR_NO_PENDING_OWNER (err u5018))

(define-constant TIMELOCK_BURN_BLOCKS u144)

(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

(define-data-var contract-owner principal tx-sender)
(define-data-var pending-owner (optional principal) none)

(define-map verified-contracts
  principal
  (buff 32)
)

(define-data-var paused bool false)
(define-data-var paused-at uint u0)

(define-map registered-contracts
  principal
  bool
)

(define-map token-equity
  {
    token: principal,
    owner: principal,
  }
  uint
)
(define-map total-token-equity
  principal
  uint
)

(define-read-only (is-verified-contract (contract principal))
  (is-some (map-get? verified-contracts contract))
)

(define-read-only (get-verified-hash (contract principal))
  (map-get? verified-contracts contract)
)

(define-read-only (get-contract-owner)
  (var-get contract-owner)
)

(define-read-only (get-pending-owner)
  (var-get pending-owner)
)

(define-read-only (is-paused)
  (var-get paused)
)

(define-read-only (get-paused-at)
  (var-get paused-at)
)

(define-read-only (get-unpause-eligible-at)
  (+ (var-get paused-at) TIMELOCK_BURN_BLOCKS)
)

(define-read-only (is-registered (p principal))
  (default-to false (map-get? registered-contracts p))
)

(define-read-only (get-token-equity
    (token principal)
    (owner principal)
  )
  (default-to u0
    (map-get? token-equity {
      token: token,
      owner: owner,
    })
  )
)

(define-read-only (get-total-token-equity (token principal))
  (default-to u0 (map-get? total-token-equity token))
)

(define-read-only (get-balance (user principal))
  (ok (get-token-equity SBTC_TOKEN user))
)

(define-private (credit
    (token principal)
    (who principal)
    (amount uint)
  )
  (let (
      (current (get-token-equity token who))
      (total (get-total-token-equity token))
    )
    (map-set token-equity {
      token: token,
      owner: who,
    }
      (+ current amount)
    )
    (map-set total-token-equity token (+ total amount))
    true
  )
)

(define-private (debit
    (token principal)
    (who principal)
    (amount uint)
  )
  (let (
      (current (get-token-equity token who))
      (total (get-total-token-equity token))
      (applied (if (> amount current)
        current
        amount
      ))
    )
    (map-set token-equity {
      token: token,
      owner: who,
    }
      (- current applied)
    )
    (map-set total-token-equity token (- total applied))
    true
  )
)

(define-private (credit-if-not-registered
    (token principal)
    (p principal)
    (amount uint)
  )
  (if (is-registered p)
    true
    (credit token p amount)
  )
)

(define-private (debit-if-not-registered
    (token principal)
    (p principal)
    (amount uint)
  )
  (if (is-registered p)
    true
    (debit token p amount)
  )
)

(define-private (credit-if-registered
    (token principal)
    (p principal)
    (amount uint)
  )
  (if (is-registered p)
    (credit token p amount)
    true
  )
)

(define-private (check-not-paused)
  (if (var-get paused)
    ERR_PAUSED
    (ok true)
  )
)

(define-public (set-verified-contract (contract principal))
  (let ((computed-hash (unwrap! (contract-hash? contract) ERR_INVALID_CONTRACT_HASH)))
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (asserts! (is-none (map-get? verified-contracts contract))
      ERR_ALREADY_REGISTERED
    )
    (map-set verified-contracts contract computed-hash)
    (print {
      event: "verified-contract-set",
      contract: contract,
      hash: computed-hash,
      by: tx-sender,
    })
    (ok true)
  )
)

(define-public (pause)
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (var-set paused true)
    (var-set paused-at burn-block-height)
    (print {
      event: "paused",
      by: tx-sender,
      paused-at: burn-block-height,
      eligible-at: (+ burn-block-height TIMELOCK_BURN_BLOCKS),
    })
    (ok true)
  )
)

(define-public (unpause)
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (asserts! (var-get paused) ERR_NOT_PAUSED)
    (asserts! (>= burn-block-height (+ (var-get paused-at) TIMELOCK_BURN_BLOCKS))
      ERR_TIMELOCK_NOT_ELAPSED
    )
    (var-set paused false)
    (print {
      event: "unpaused",
      by: tx-sender,
    })
    (ok true)
  )
)

(define-public (propose-owner (new-owner (optional principal)))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR_NOT_AUTHORIZED)
    (var-set pending-owner new-owner)
    (print {
      event: "owner-proposed",
      proposed-by: tx-sender,
      pending-owner: new-owner,
    })
    (ok true)
  )
)

(define-public (accept-owner)
  (let ((pending (unwrap! (var-get pending-owner) ERR_NO_PENDING_OWNER)))
    (asserts! (is-eq tx-sender pending) ERR_NOT_AUTHORIZED)
    (var-set contract-owner pending)
    (var-set pending-owner none)
    (print {
      event: "owner-accepted",
      new-owner: pending,
    })
    (ok true)
  )
)

(define-public (register (canonical principal))
  (let (
      (caller contract-caller)
      (caller-hash (unwrap! (contract-hash? contract-caller) ERR_INVALID_CONTRACT_HASH))
      (verified-hash (unwrap! (map-get? verified-contracts canonical) ERR_NOT_VERIFIED))
    )
    (asserts! (is-eq caller-hash verified-hash) ERR_HASH_MISMATCH)
    (asserts! (is-none (map-get? registered-contracts caller))
      ERR_ALREADY_REGISTERED
    )
    (map-set registered-contracts caller true)
    (print {
      event: "registered",
      contract: caller,
      canonical: canonical,
      hash: caller-hash,
    })
    (ok true)
  )
)

(define-public (log-deposit
    (token principal)
    (amount uint)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (credit token contract-caller amount)
    (print {
      event: "vault-deposit",
      vault: contract-caller,
      token: token,
      amount: amount,
      equity: (get-token-equity token contract-caller),
    })
    (ok true)
  )
)

(define-public (log-withdraw
    (token principal)
    (amount uint)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit token contract-caller amount)
    (print {
      event: "vault-withdraw",
      vault: contract-caller,
      token: token,
      amount: amount,
      equity: (get-token-equity token contract-caller),
    })
    (ok true)
  )
)

(define-public (log-revoke (target-hash (buff 32)))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "vault-revoke",
      vault: contract-caller,
      target-hash: target-hash,
    })
    (ok true)
  )
)

(define-public (log-cancel
    (market principal)
    (token-in principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "vault-cancel",
      vault: contract-caller,
      market: market,
      token-in: token-in,
    })
    (ok true)
  )
)

(define-public (log-jing-deposit
    (msg-hash (buff 32))
    (market principal)
    (token-in principal)
    (token-out principal)
    (amount uint)
    (limit-price uint)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "vault-jing-deposit",
      vault: contract-caller,
      market: market,
      msg-hash: msg-hash,
      token-in: token-in,
      token-out: token-out,
      amount: amount,
      limit-price: limit-price,
    })
    (ok true)
  )
)

(define-public (log-bitflow-swap
    (msg-hash (buff 32))
    (token-in principal)
    (token-out principal)
    (amount uint)
    (limit-price uint)
    (out uint)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit token-in contract-caller amount)
    (credit token-out contract-caller out)
    (print {
      event: "vault-bitflow-swap",
      vault: contract-caller,
      msg-hash: msg-hash,
      token-in: token-in,
      token-out: token-out,
      amount: amount,
      limit-price: limit-price,
      out: out,
      equity-in: (get-token-equity token-in contract-caller),
      equity-out: (get-token-equity token-out contract-caller),
    })
    (ok true)
  )
)

(define-public (log-deposit-x
    (depositor principal)
    (amount uint)
    (delta uint)
    (limit uint)
    (cycle uint)
    (bumped (optional principal))
    (bumped-amount uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (match bumped
      b (debit-if-not-registered token-x b bumped-amount)
      true
    )
    (credit-if-not-registered token-x depositor delta)
    (print {
      event: "deposit-x",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      amount: amount,
      delta: delta,
      limit: limit,
      cycle: cycle,
      bumped: bumped,
      bumped-amount: bumped-amount,
      equity-x: (get-token-equity token-x depositor),
      bumped-equity-x: (match bumped
        b (some (get-token-equity token-x b))
        none
      ),
    })
    (ok true)
  )
)

(define-public (log-deposit-y
    (depositor principal)
    (amount uint)
    (delta uint)
    (limit uint)
    (cycle uint)
    (bumped (optional principal))
    (bumped-amount uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (match bumped
      b (debit-if-not-registered token-y b bumped-amount)
      true
    )
    (credit-if-not-registered token-y depositor delta)
    (print {
      event: "deposit-y",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      amount: amount,
      delta: delta,
      limit: limit,
      cycle: cycle,
      bumped: bumped,
      bumped-amount: bumped-amount,
      equity-y: (get-token-equity token-y depositor),
      bumped-equity-y: (match bumped
        b (some (get-token-equity token-y b))
        none
      ),
    })
    (ok true)
  )
)

(define-public (log-refund-x
    (depositor principal)
    (amount uint)
    (cycle uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit-if-not-registered token-x depositor amount)
    (print {
      event: "refund-x",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      amount: amount,
      cycle: cycle,
      equity-x: (get-token-equity token-x depositor),
    })
    (ok true)
  )
)

(define-public (log-refund-y
    (depositor principal)
    (amount uint)
    (cycle uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit-if-not-registered token-y depositor amount)
    (print {
      event: "refund-y",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      amount: amount,
      cycle: cycle,
      equity-y: (get-token-equity token-y depositor),
    })
    (ok true)
  )
)

(define-public (log-set-limit-x
    (depositor principal)
    (limit uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "set-limit-x",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      limit: limit,
    })
    (ok true)
  )
)

(define-public (log-set-limit-y
    (depositor principal)
    (limit uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "set-limit-y",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      limit: limit,
    })
    (ok true)
  )
)

(define-public (log-close-deposits
    (cycle uint)
    (closed-at-block uint)
    (elapsed-blocks uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "close-deposits",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      cycle: cycle,
      closed-at-block: closed-at-block,
      elapsed-blocks: elapsed-blocks,
    })
    (ok true)
  )
)

(define-public (log-small-share-roll-x
    (depositor principal)
    (cycle uint)
    (amount uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "small-share-roll-x",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      cycle: cycle,
      amount: amount,
    })
    (ok true)
  )
)

(define-public (log-small-share-roll-y
    (depositor principal)
    (cycle uint)
    (amount uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "small-share-roll-y",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      cycle: cycle,
      amount: amount,
    })
    (ok true)
  )
)

(define-public (log-limit-roll-x
    (depositor principal)
    (cycle uint)
    (amount uint)
    (limit uint)
    (clearing uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "limit-roll-x",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      cycle: cycle,
      amount: amount,
      limit: limit,
      clearing: clearing,
    })
    (ok true)
  )
)

(define-public (log-limit-roll-y
    (depositor principal)
    (cycle uint)
    (amount uint)
    (limit uint)
    (clearing uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "limit-roll-y",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      cycle: cycle,
      amount: amount,
      limit: limit,
      clearing: clearing,
    })
    (ok true)
  )
)

(define-public (log-settlement
    (cycle uint)
    (oracle-price uint)
    (clearing-price uint)
    (x-cleared uint)
    (y-cleared uint)
    (x-unfilled uint)
    (y-unfilled uint)
    (x-fee uint)
    (y-fee uint)
    ;; Taker rebates withheld at deposit time and paid out to the opposite
    ;; side's filled depositors in this settlement. Reported separately from
    ;; the fee because the treasury never receives them: they stay inside the
    ;; pool and raise what the makers are paid. An indexer that reads only
    ;; x-cleared/y-cleared understates maker proceeds by exactly this amount.
    (x-rebate uint)
    (y-rebate uint)
    (x-is-binding bool)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "settlement",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      cycle: cycle,
      oracle-price: oracle-price,
      clearing-price: clearing-price,
      x-cleared: x-cleared,
      y-cleared: y-cleared,
      x-unfilled: x-unfilled,
      y-unfilled: y-unfilled,
      x-fee: x-fee,
      y-fee: y-fee,
      x-rebate: x-rebate,
      y-rebate: y-rebate,
      binding-side: (if x-is-binding
        "x"
        "y"
      ),
    })
    (ok true)
  )
)

(define-public (log-distribute-x-depositor
    (depositor principal)
    (cycle uint)
    (y-received uint)
    (x-cleared uint)
    (x-rolled uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (if (> x-cleared u0)
      (debit token-x depositor x-cleared)
      true
    )
    (credit-if-registered token-y depositor y-received)
    (print {
      event: "distribute-x-depositor",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      cycle: cycle,
      x-cleared: x-cleared,
      y-received: y-received,
      x-rolled: x-rolled,
      equity-x: (get-token-equity token-x depositor),
      equity-y: (get-token-equity token-y depositor),
    })
    (ok true)
  )
)

(define-public (log-distribute-y-depositor
    (depositor principal)
    (cycle uint)
    (x-received uint)
    (y-cleared uint)
    (y-rolled uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (if (> y-cleared u0)
      (debit token-y depositor y-cleared)
      true
    )
    (credit-if-registered token-x depositor x-received)
    (print {
      event: "distribute-y-depositor",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      depositor: depositor,
      cycle: cycle,
      y-cleared: y-cleared,
      x-received: x-received,
      y-rolled: y-rolled,
      equity-x: (get-token-equity token-x depositor),
      equity-y: (get-token-equity token-y depositor),
    })
    (ok true)
  )
)

(define-public (log-sweep-dust
    (x-unfilled uint)
    (y-unfilled uint)
    (x-dust uint)
    (x-payout-dust uint)
    (x-roll-dust uint)
    (y-dust uint)
    (y-payout-dust uint)
    (y-roll-dust uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "sweep-dust",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      x-unfilled: x-unfilled,
      y-unfilled: y-unfilled,
      x-dust: x-dust,
      x-payout-dust: x-payout-dust,
      x-roll-dust: x-roll-dust,
      y-dust: y-dust,
      y-payout-dust: y-payout-dust,
      y-roll-dust: y-roll-dust,
    })
    (ok true)
  )
)

(define-public (log-cancel-cycle
    (cycle uint)
    (x-rolled uint)
    (y-rolled uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "cancel-cycle",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      cycle: cycle,
      x-rolled: x-rolled,
      y-rolled: y-rolled,
    })
    (ok true)
  )
)

;; RFQ event stream, mirrored verbatim from the deployed mainnet jing-core-v2
;; so the local rfq-* contracts resolve against the same interface.
(define-public (log-rfq-open
    (rfq-id uint)
    (client principal)
    (x-in uint)
    (min-y-out uint)
    (expiry uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "rfq-open",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      rfq-id: rfq-id,
      client: client,
      x-in: x-in,
      min-y-out: min-y-out,
      expiry: expiry,
    })
    (ok true)
  )
)

(define-public (log-rfq-fill
    (rfq-id uint)
    (client principal)
    (mm principal)
    (x-in uint)
    (y-out uint)
    (y-fee uint)
    (price uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "rfq-fill",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      rfq-id: rfq-id,
      client: client,
      mm: mm,
      x-in: x-in,
      y-out: y-out,
      y-fee: y-fee,
      price: price,
    })
    (ok true)
  )
)

(define-public (log-rfq-cancel
    (rfq-id uint)
    (client principal)
    (x-in uint)
    (token-x principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "rfq-cancel",
      market: contract-caller,
      token-x: token-x,
      token-y: token-y,
      rfq-id: rfq-id,
      client: client,
      x-in: x-in,
    })
    (ok true)
  )
)

(define-public (log-reserve-supply (amount uint))
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (credit SBTC_TOKEN contract-caller amount)
    (print {
      event: "reserve-supply",
      reserve: contract-caller,
      amount: amount,
      sbtc-equity: (get-token-equity SBTC_TOKEN contract-caller),
    })
    (ok true)
  )
)

(define-public (log-reserve-withdraw-sbtc (amount uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit SBTC_TOKEN contract-caller amount)
    (print {
      event: "reserve-withdraw-sbtc",
      reserve: contract-caller,
      amount: amount,
      sbtc-equity: (get-token-equity SBTC_TOKEN contract-caller),
    })
    (ok true)
  )
)

(define-public (log-reserve-withdraw-stx (amount uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "reserve-withdraw-stx",
      reserve: contract-caller,
      amount: amount,
    })
    (ok true)
  )
)

(define-public (log-reserve-open-credit-line
    (snpl principal)
    (borrower principal)
    (cap-sbtc uint)
    (interest-bps uint)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "reserve-open-credit-line",
      reserve: contract-caller,
      snpl: snpl,
      borrower: borrower,
      cap-sbtc: cap-sbtc,
      interest-bps: interest-bps,
    })
    (ok true)
  )
)

(define-public (log-reserve-set-credit-line-cap
    (snpl principal)
    (cap-sbtc uint)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "reserve-set-credit-line-cap",
      reserve: contract-caller,
      snpl: snpl,
      cap-sbtc: cap-sbtc,
    })
    (ok true)
  )
)

(define-public (log-reserve-set-credit-line-interest
    (snpl principal)
    (interest-bps uint)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "reserve-set-credit-line-interest",
      reserve: contract-caller,
      snpl: snpl,
      interest-bps: interest-bps,
    })
    (ok true)
  )
)

(define-public (log-reserve-close-credit-line (snpl principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "reserve-close-credit-line",
      reserve: contract-caller,
      snpl: snpl,
    })
    (ok true)
  )
)

(define-public (log-reserve-set-paused (paused-state bool))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "reserve-set-paused",
      reserve: contract-caller,
      paused: paused-state,
    })
    (ok true)
  )
)

(define-public (log-reserve-set-min-sbtc-draw (amount uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "reserve-set-min-sbtc-draw",
      reserve: contract-caller,
      amount: amount,
    })
    (ok true)
  )
)

(define-public (log-reserve-draw
    (snpl principal)
    (amount uint)
    (new-outstanding-sbtc uint)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "reserve-draw",
      reserve: contract-caller,
      snpl: snpl,
      amount: amount,
      new-outstanding-sbtc: new-outstanding-sbtc,
    })
    (ok true)
  )
)

(define-public (log-reserve-notify-return
    (snpl principal)
    (amount uint)
    (new-outstanding-sbtc uint)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "reserve-notify-return",
      reserve: contract-caller,
      snpl: snpl,
      amount: amount,
      new-outstanding-sbtc: new-outstanding-sbtc,
    })
    (ok true)
  )
)

(define-public (log-snpl-set-reserve (reserve principal))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "snpl-set-reserve",
      snpl: contract-caller,
      reserve: reserve,
    })
    (ok true)
  )
)

(define-public (log-snpl-borrow
    (loan-id uint)
    (borrower principal)
    (amount uint)
    (interest-bps uint)
    (deadline uint)
    (reserve principal)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "snpl-borrow",
      snpl: contract-caller,
      loan-id: loan-id,
      borrower: borrower,
      amount: amount,
      interest-bps: interest-bps,
      deadline: deadline,
      reserve: reserve,
    })
    (ok true)
  )
)

(define-public (log-snpl-swap-deposit
    (loan-id uint)
    (amount uint)
    (limit uint)
    (cycle uint)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "snpl-swap-deposit",
      snpl: contract-caller,
      loan-id: loan-id,
      amount: amount,
      limit: limit,
      cycle: cycle,
    })
    (ok true)
  )
)

(define-public (log-snpl-cancel-swap (loan-id uint))
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "snpl-cancel-swap",
      snpl: contract-caller,
      loan-id: loan-id,
    })
    (ok true)
  )
)

(define-public (log-snpl-set-swap-limit
    (loan-id uint)
    (limit-price uint)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (print {
      event: "snpl-set-swap-limit",
      snpl: contract-caller,
      loan-id: loan-id,
      limit-price: limit-price,
    })
    (ok true)
  )
)

(define-public (log-snpl-repay
    (loan-id uint)
    (payoff-sbtc uint)
    (lender-payoff-sbtc uint)
    (fee-sbtc uint)
    (delta-sbtc uint)
    (is-shortfall bool)
    (token-y-released uint)
    (reserve principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit token-y contract-caller token-y-released)
    (print {
      event: "snpl-repay",
      snpl: contract-caller,
      loan-id: loan-id,
      payoff-sbtc: payoff-sbtc,
      lender-payoff-sbtc: lender-payoff-sbtc,
      fee-sbtc: fee-sbtc,
      delta-sbtc: delta-sbtc,
      is-shortfall: is-shortfall,
      token-y: token-y,
      token-y-released: token-y-released,
      reserve: reserve,
    })
    (ok true)
  )
)

(define-public (log-snpl-seize
    (loan-id uint)
    (token-y-seized uint)
    (sbtc-seized uint)
    (reserve principal)
    (token-y principal)
  )
  (begin
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit token-y contract-caller token-y-seized)
    (print {
      event: "snpl-seize",
      snpl: contract-caller,
      loan-id: loan-id,
      token-y: token-y,
      token-y-seized: token-y-seized,
      sbtc-seized: sbtc-seized,
      reserve: reserve,
    })
    (ok true)
  )
)

;; v3 addition: vault-side swap/crossing-reprice equity event. Appended at
;; the end to keep the diff against the deployed jing-core-v2 minimal.
(define-public (log-jing-swap
    (msg-hash (buff 32))
    (market principal)
    (token-in principal)
    (token-out principal)
    (amount uint)
    (limit-price uint)
    (out uint)
  )
  (begin
    (try! (check-not-paused))
    (asserts! (is-registered contract-caller) ERR_NOT_AUTHORIZED)
    (debit token-in contract-caller amount)
    (credit token-out contract-caller out)
    (print {
      event: "vault-jing-swap",
      vault: contract-caller,
      market: market,
      msg-hash: msg-hash,
      token-in: token-in,
      token-out: token-out,
      amount: amount,
      limit-price: limit-price,
      out: out,
      equity-in: (get-token-equity token-in contract-caller),
      equity-out: (get-token-equity token-out contract-caller),
    })
    (ok true)
  )
)
