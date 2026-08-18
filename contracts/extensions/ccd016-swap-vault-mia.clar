;; Title: CCD016 - MiamiCoin One-Way Swap Vault (sBTC -> STX)
;; Version: 0.1.0 (DRAFT - unaudited, not deployed)
;; Summary: Converts the DAO's sBTC rewards to STX at best execution; STX can only reach the ccd015 book, sBTC can only return to the treasury.
;; Description:
;;   Solution 2's execution layer, forked from the Jing vault
;;   (SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.vault-sbtc-stx-jing lineage).
;;   The Jing vault is a personal trading vault; four changes turn it into a
;;   DAO conduit whose operator controls WHEN and AT WHAT PRICE, never WHERE:
;;
;;   1. ONE DIRECTION. Only sBTC -> STX executes. The STX side of every venue
;;      call is gone; the operator cannot trade the DAO's STX back into sBTC.
;;   2. HARD-WIRED EXITS. STX leaves only to the ccd015 redemption book,
;;      bound as a constant at deploy time; sBTC leaves only back to the
;;      rewards treasury it came from. Neither the operator nor a proposal
;;      can redirect either exit - there is no path from this vault to any
;;      other address.
;;   3. DAO FUNDING AND RECALL. `fund-from-treasury` (permissionless, no
;;      arguments) pulls the rewards treasury's full sBTC balance in;
;;      `dao-recall-sbtc` lets a proposal pull it back without the operator.
;;   4. NO EQUITY LEDGER. The Jing vault's jing-core registration and logging
;;      are dropped; the DAO needs events, not a PnL ledger.
;;
;;   Execution authorization is two-factor: the transaction must come from
;;   the DAO-appointed keeper (or the DAO itself), AND the call must carry a
;;   signature from the DAO-appointed pubkey over the exact parameters
;;   (amount, limit price, auth id, expiry) hashed by the deployed
;;   jing-vault-auth. Each intent hash is consumed on use - no replay. A
;;   stolen signing key alone cannot broadcast; a rogue keeper can only
;;   execute trades the signer already signed, within the signed limit price.
;;
;;   Venues, maker-first: rest the sBTC on the Jing v2 market with the maker
;;   rebate, reprice or take when the book allows, reclaim after the
;;   off-chain patience window, and fall back to the Bitflow XYK / DLMM
;;   taker legs. The Jing market is not yet deployed on mainnet, so it is
;;   vendored locally and bound relatively; in prod the JING_MARKET constant
;;   is repointed to the deployed literal.
;;
;;   Every deployed external principal is a fully qualified mainnet address.
;;   Two references are relative - the STX destination (binds to the ccd015
;;   book at this vault's own deployer, so vault and book ship from the same
;;   address, book first) and the vendored Jing market noted above.

;; TRAITS

(impl-trait 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.extension-trait.extension-trait)

;; CONSTANTS

;; error codes
(define-constant ERR_UNAUTHORIZED (err u16000))
(define-constant ERR_NOT_OWNER (err u16001))
(define-constant ERR_INVALID_SIGNATURE (err u16002))
(define-constant ERR_REPLAY (err u16003))
(define-constant ERR_EXPIRED (err u16004))
(define-constant ERR_NO_FUNDS (err u16006))
(define-constant ERR_NO_BUDGET (err u16010))
(define-constant ERR_INVALID_PRICE (err u16013))
(define-constant ERR_PUBKEY_NOT_SET (err u16021))
(define-constant ERR_AMOUNT_MISMATCH (err u16022))

(define-constant PRICE_PRECISION u100000000)
(define-constant DECIMAL_FACTOR u100)

(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant ASSET_SBTC "sbtc-token")

;; the only account sBTC can ever be returned to - same constant as ccd014/ccd015
(define-constant REWARDS_TREASURY 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-rewards-v3)

;; The only account STX can ever be sent to: the ccd015 redemption book.
;; Relative on purpose - it binds at deploy time to the book at THIS deployer,
;; so vault and book must ship from the same address, book first. Neither the
;; operator nor a proposal can redirect it.
(define-constant STX_FAIR_BOOK .ccd015-redemption-book-mia-stx) ;; in prod change this to litteral

;; intent hashing, shared with the Jing vaults so signing tooling is reusable
(define-constant JING-VAULT-AUTH 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.jing-vault-auth)

;; The Jing v2 market, maker-first preferred venue. Relative: binds to the
;; vendored copy for local compile/tests; in prod change this to the literal
;; once markets-sbtc-stx-jing-v2 is deployed on mainnet.
(define-constant JING_MARKET .markets-sbtc-stx-jing-v2)
(define-constant ASSET_WSTX "wstx")
(define-constant BPS_PRECISION u10000)

;; The market's VAA paths call Pyth verify-and-update, which pulls a
;; per-updated-feed STX fee from tx-sender - the vault, inside as-contract?.
;; Without an explicit with-stx allowance the fee transfer aborts the whole
;; call whenever the vault is the first to submit its VAA (the fee is zero
;; only when the feeds were already refreshed). Current mainnet fee is 1 uSTX
;; per feed (2 feeds on this market); u10 leaves governance headroom.
;; fuel-fair-book leaves this much behind so the Jing legs always work.
(define-constant PYTH_FEE_BUDGET u10)

;; venues (both live on mainnet)
(define-constant XYK_CORE 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2)
(define-constant XYK_POOL_SBTC_STX 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1)
(define-constant WSTX_TOKEN 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2)
(define-constant DLMM_ROUTER 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1)
(define-constant DLMM_POOL_STX_SBTC 'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15)

(define-constant DEFAULT_PUBKEY 0x000000000000000000000000000000000000000000000000000000000000000000)

;; DATA VARS

(define-data-var owner-pubkey (buff 33) DEFAULT_PUBKEY)
(define-data-var keeper (optional principal) none)

(define-map used-pubkey-authorizations
  (buff 32)
  (buff 33)
)

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

;; Governance escape hatch: a proposal returns the vault's entire unswapped
;; sBTC balance to the rewards treasury, no operator required.
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

;; --- operator credentials (DAO-appointed) -----------------------------------
;; The DAO, not the operator, appoints the signing pubkey and the keeper by
;; proposal. The operator cannot rotate their own credentials, and no phishing
;; of the operator's wallet can either - only governance can. Together with
;; the hard-wired exits this makes every authority in the vault DAO-granted:
;; the operator merely exercises what a proposal handed them.

(define-public (set-owner-pubkey (pubkey (buff 33)))
  (begin
    (try! (is-dao-or-extension))
    (ok (var-set owner-pubkey pubkey))
  )
)

(define-public (set-keeper (new-keeper (optional principal)))
  (begin
    (try! (is-dao-or-extension))
    (ok (var-set keeper new-keeper))
  )
)

;; --- funding (the pipe from the rewards treasury) ---------------------------

;; Pull the rewards treasury's entire sBTC balance into the vault.
;; Permissionless and argumentless: a caller controls neither amount nor
;; destination. Requires this contract to be an enabled extension (the
;; treasury gates withdraw-ft on is-dao-or-extension) and sBTC on the
;; treasury's allowlist - both set by the enabling proposal.
(define-public (fund-from-treasury)
  (let ((amount (unwrap!
      (contract-call? SBTC_TOKEN get-balance REWARDS_TREASURY)
      ERR_NO_BUDGET
    )))
    (asserts! (> amount u0) ERR_NO_BUDGET)
    ;; No as-contract needed: the treasury's extension gate reads
    ;; contract-caller, which is this contract on a direct call.
    (try! (contract-call? REWARDS_TREASURY withdraw-ft
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token amount current-contract
    ))
    (ok (print { notification: "fund-from-treasury", payload: { amount: amount } }))
  )
)

;; --- exits (destinations hard-wired) ---------------------------------------

;; Fuel the fair book: flush the vault's entire STX balance to the ccd015 book - no amount, no
;; destination: the budget is the balance, the exit is a constant.
;; Permissionless, like fund-from-treasury and the book's cross-book: every
;; step of the pipeline that involves no pricing needs nobody's permission. A
;; caller controls neither amount nor destination - converted STX was always
;; headed to the book, this only moves it along - so proceeds can never be
;; stranded here.
(define-public (fuel-fair-book)
  ;; keep PYTH_FEE_BUDGET behind (10 micro-STX) so the Jing legs can always
  ;; pay their oracle fee - see the constant's comment
  (let ((balance (stx-get-balance current-contract)))
    (asserts! (> balance PYTH_FEE_BUDGET) ERR_NO_FUNDS)
    (let ((flushed (- balance PYTH_FEE_BUDGET)))
      (try! (as-contract? ((with-stx flushed))
        (try! (stx-transfer? flushed current-contract STX_FAIR_BOOK))
      ))
      (ok (print { notification: "fuel-fair-book", payload: { amount: flushed, book: STX_FAIR_BOOK } }))
    )
  )
)

;; --- execution (sBTC -> STX only, two-factor authorized) --------------------

;; Kill an outstanding signed intent before it executes. The DAO-appointed
;; keeper gets the fast brake (no governance latency); the DAO itself can
;; always revoke by proposal.
(define-public (revoke-intent (target-hash (buff 32)))
  (begin
    (asserts!
      (or
        (is-eq (some tx-sender) (var-get keeper))
        (is-ok (is-dao-or-extension))
      )
      ERR_NOT_OWNER
    )
    (asserts! (is-none (map-get? used-pubkey-authorizations target-hash))
      ERR_REPLAY
    )
    (map-set used-pubkey-authorizations target-hash (var-get owner-pubkey))
    (ok (print { notification: "revoke-intent", payload: { hash: target-hash } }))
  )
)

;; --- Jing legs (maker-first, the preferred venue; sBTC side only) -----------
;; The strategy in display order: rest the sBTC on the Jing market with the
;; maker rebate (execute-jing-deposit), manage the resting position
;; (execute-jing-reprice), take against the book when it is deep enough
;; (execute-jing-swap), and if the market has not absorbed the position
;; within the off-chain patience window, reclaim (cancel-jing-sbtc) and fall
;; back to the Bitflow taker legs below.
;;
;; `vaa` is keeper-supplied oracle data for the market's maker gate, NOT part
;; of the signed intent: VAAs go stale in minutes, so the keeper attaches the
;; freshest one at execution time. It cannot influence what was authorized -
;; only whether the market classifies the deposit against a fresh price.

(define-public (execute-jing-deposit
    (sig (buff 65))
    (amount uint)
    (limit-price uint)
    (auth-id uint)
    (expiry uint)
    (vaa (buff 8192))
  )
  (let ((msg-hash (contract-call? JING-VAULT-AUTH build-intent-hash {
      action: "jing-deposit",
      side: ASSET_SBTC,
      amount: amount,
      limit-price: limit-price,
      auth-id: auth-id,
      expiry: expiry,
    })))
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (verify-and-consume msg-hash sig expiry))
    (try! (as-contract?
      (
        (with-ft SBTC_TOKEN ASSET_SBTC amount)
        (with-stx PYTH_FEE_BUDGET)
      )
      (try! (contract-call? JING_MARKET deposit-token-x amount limit-price vaa
        SBTC_TOKEN ASSET_SBTC
      ))
    ))
    (print { notification: "jing-deposit", payload: {
      hash: msg-hash, amount: amount, limit-price: limit-price,
    } })
    (ok msg-hash)
  )
)

;; Taker path into the Jing market: the market's `swap` is fill-or-kill, so
;; this either clears the vault's full `amount` inside `limit-price` in one tx
;; or reverts whole. The market charges its taker rebate out of `amount`
;; (rebate plus net deposit sum to exactly `amount`), so the asset allowance
;; below is the total outlay.
(define-public (execute-jing-swap
    (sig (buff 65))
    (amount uint)
    (limit-price uint)
    (auth-id uint)
    (expiry uint)
    (vaa (buff 8192))
  )
  (let ((msg-hash (contract-call? JING-VAULT-AUTH build-intent-hash {
      action: "jing-swap",
      side: ASSET_SBTC,
      amount: amount,
      limit-price: limit-price,
      auth-id: auth-id,
      expiry: expiry,
    })))
    (asserts! (> limit-price u0) ERR_INVALID_PRICE)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (verify-and-consume msg-hash sig expiry))
    (let ((result (try! (as-contract?
        (
          (with-ft SBTC_TOKEN ASSET_SBTC amount)
          (with-stx PYTH_FEE_BUDGET)
        )
        (try! (contract-call? JING_MARKET swap amount limit-price vaa
          SBTC_TOKEN ASSET_SBTC WSTX_TOKEN ASSET_WSTX true
        ))
      ))))
      (print { notification: "jing-swap", payload: {
        hash: msg-hash, amount: amount, limit-price: limit-price,
        out: (get token-y-received result),
      } })
      (ok msg-hash)
    )
  )
)

;; Reprice the vault's RESTING Jing position; if the new limit crosses live
;; resting size, the market turns it taker on the spot (fill-or-kill). The
;; signed intent's `amount` must equal the vault's current resting deposit -
;; so a keeper cannot execute a stale intent after the position changed; the
;; signer re-signs against the new size instead. The allowance is exactly the
;; taker rebate: that is all the crossing path may pull from the vault (the
;; resting size itself already sits on the market). The plain reprice path
;; moves no assets at all.
(define-public (execute-jing-reprice
    (sig (buff 65))
    (amount uint)
    (limit-price uint)
    (auth-id uint)
    (expiry uint)
    (vaa (buff 8192))
  )
  (let (
      (msg-hash (contract-call? JING-VAULT-AUTH build-intent-hash {
        action: "jing-reprice",
        side: ASSET_SBTC,
        amount: amount,
        limit-price: limit-price,
        auth-id: auth-id,
        expiry: expiry,
      }))
      (cycle (contract-call? JING_MARKET get-current-cycle))
      (rebate (/ (* amount (contract-call? JING_MARKET get-taker-rebate-bps))
        BPS_PRECISION
      ))
    )
    (asserts! (> limit-price u0) ERR_INVALID_PRICE)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (asserts!
      (is-eq amount (contract-call? JING_MARKET get-token-x-deposit cycle current-contract))
      ERR_AMOUNT_MISMATCH
    )
    (try! (verify-and-consume msg-hash sig expiry))
    (let ((result (try! (as-contract?
        (
          (with-ft SBTC_TOKEN ASSET_SBTC rebate)
          (with-stx PYTH_FEE_BUDGET)
        )
        (try! (contract-call? JING_MARKET reprice-or-swap-token-x limit-price vaa
          SBTC_TOKEN ASSET_SBTC WSTX_TOKEN ASSET_WSTX
        ))
      ))))
      (print { notification: "jing-reprice", payload: {
        hash: msg-hash, amount: amount, limit-price: limit-price,
        out: (get token-y-received result),
      } })
      (ok msg-hash)
    )
  )
)

;; Reclaim the resting sBTC deposit from the Jing market back into the vault.
;; No signature needed: funds can only return here. Keeper for the day-to-day
;; patience-window reclaim, DAO by proposal.
(define-public (cancel-jing-sbtc)
  (begin
    (asserts!
      (or
        (is-eq (some tx-sender) (var-get keeper))
        (is-ok (is-dao-or-extension))
      )
      ERR_NOT_OWNER
    )
    (try! (as-contract? ()
      (try! (contract-call? JING_MARKET cancel-token-x-deposit SBTC_TOKEN ASSET_SBTC))
    ))
    (ok (print { notification: "cancel-jing-sbtc", payload: { market: JING_MARKET } }))
  )
)

;; --- Bitflow taker legs (the fallback) --------------------------------------

(define-public (execute-bitflow-swap
    (sig (buff 65))
    (amount uint)
    (limit-price uint)
    (auth-id uint)
    (expiry uint)
  )
  (begin
    (asserts! (> limit-price u0) ERR_INVALID_PRICE)
    (let (
        (msg-hash (contract-call? JING-VAULT-AUTH build-intent-hash {
          action: "bitflow-swap",
          side: ASSET_SBTC,
          amount: amount,
          limit-price: limit-price,
          auth-id: auth-id,
          expiry: expiry,
        }))
        (min-out (derive-min-out amount limit-price))
      )
      (try! (verify-and-consume msg-hash sig expiry))
      (let ((out (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
          (try! (contract-call? XYK_CORE swap-x-for-y XYK_POOL_SBTC_STX SBTC_TOKEN
            WSTX_TOKEN amount min-out
          ))
        ))))
        (print { notification: "bitflow-swap", payload: {
          hash: msg-hash, amount: amount, limit-price: limit-price, out: out,
        } })
        (ok msg-hash)
      )
    )
  )
)

(define-public (execute-dlmm-swap
    (sig (buff 65))
    (amount uint)
    (limit-price uint)
    (auth-id uint)
    (expiry uint)
  )
  (begin
    (asserts! (> limit-price u0) ERR_INVALID_PRICE)
    (let (
        (msg-hash (contract-call? JING-VAULT-AUTH build-intent-hash {
          action: "dlmm-swap",
          side: ASSET_SBTC,
          amount: amount,
          limit-price: limit-price,
          auth-id: auth-id,
          expiry: expiry,
        }))
        (min-out (derive-min-out amount limit-price))
      )
      (try! (verify-and-consume msg-hash sig expiry))
      (let ((result (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
          (try! (contract-call? DLMM_ROUTER swap-y-for-x-simple-multi
            DLMM_POOL_STX_SBTC WSTX_TOKEN SBTC_TOKEN amount min-out
          ))
        ))))
        (print { notification: "dlmm-swap", payload: {
          hash: msg-hash, amount: amount, limit-price: limit-price,
          out: (get out result),
        } })
        (ok msg-hash)
      )
    )
  )
)

;; READ ONLY FUNCTIONS

(define-read-only (is-signature-used (h (buff 32)))
  (is-some (map-get? used-pubkey-authorizations h))
)

(define-read-only (get-status)
  {
    pubkey: (var-get owner-pubkey),
    keeper: (var-get keeper),
    stx-destination: STX_FAIR_BOOK,
    stx-balance: (stx-get-balance current-contract),
    sbtc-balance: (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance current-contract
    )),
    ;; sBTC still sitting in the rewards treasury, claimable via fund-from-treasury
    pending-treasury-sats: (contract-call?
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-rewards-v3),
  }
)

;; PRIVATE FUNCTIONS

(define-private (verify-and-consume
    (msg-hash (buff 32))
    (sig (buff 65))
    (expiry uint)
  )
  (begin
    (asserts!
      (or
        (is-eq (some tx-sender) (var-get keeper))
        (is-ok (is-dao-or-extension))
      )
      ERR_NOT_OWNER
    )
    (asserts! (not (is-eq (var-get owner-pubkey) DEFAULT_PUBKEY))
      ERR_PUBKEY_NOT_SET
    )
    (asserts! (is-none (map-get? used-pubkey-authorizations msg-hash)) ERR_REPLAY)
    (asserts! (or (is-eq expiry u0) (< burn-block-height expiry)) ERR_EXPIRED)
    (let ((signer (unwrap! (secp256k1-recover? msg-hash sig) ERR_INVALID_SIGNATURE)))
      (asserts! (is-eq signer (var-get owner-pubkey)) ERR_INVALID_SIGNATURE)
      (map-set used-pubkey-authorizations msg-hash signer)
      (ok true)
    )
  )
)

;; Floor of the STX the vault must receive for `amount` sats at `limit-price`,
;; identical scaling to the Jing vault:
;;   uSTX = sats * price / (PRICE_PRECISION * DECIMAL_FACTOR)
(define-private (derive-min-out (amount uint) (limit-price uint))
  (/ (* amount limit-price) (* PRICE_PRECISION DECIMAL_FACTOR))
)
