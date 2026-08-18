;; SPN4Y5QPGQA8882ZXW90ADC2DHYXMSTN8VAR8C3X.ccd014-pox5-staking-mia

;; Title: CCD014 - MIA PoX-5 Staking
;; Version: 2
;; Summary: An extension that stakes the MiamiCoin mining treasury's STX under
;;   PoX-5 and forwards the sBTC rewards to the MIA rewards treasury.
;; Description: PoX-5 (Stacks 4.0) removed delegated stacking. `pox-5.stake`
;;   locks the STX of `tx-sender`, so the principal that calls it must itself
;;   hold the STX. CCD002 treasuries can only reach `pox-4.delegate-stx`
;;   (hard-coded), which no longer produces rewards, so the DAO needs a
;;   contract that can hold STX and call PoX-5 directly. This is that contract.
;;
;;   Trust properties, in order of importance:
;;   - Both destinations for funds are CONSTANTS, not parameters. STX can only
;;     ever go back to `ccd002-treasury-mia-mining-v3`, and sBTC rewards can
;;     only ever go to `ccd002-treasury-mia-rewards-v3`. No proposal, and no
;;     caller, can redirect either.
;;   - Every call that leaves this contract runs inside `as-contract?` with an
;;     explicit asset allowance. A signer-manager reached through the
;;     `signer-manager-trait`, or any other callee, cannot move assets this
;;     contract did not intend to move: `stake-stx` permits staking and no
;;     transfer at all, `unstake-stx` permits the PoX interaction and no
;;     transfer either, and the two forwarding functions permit exactly the
;;     balance being forwarded.
;;   - The signer is a DAO-set allowlist of exactly one principal. Trait
;;     arguments cannot be stored in Clarity, so callers pass the
;;     signer-manager and this contract checks it against `approved-signer`.
;;   - Staking and reward forwarding are permissionless: anyone can re-stake or
;;     sweep rewards, so keeping the position alive never needs a governance
;;     round. Exiting the position (`unstake-stx`) and returning principal
;;     (`return-stx`) are DAO-gated.
;;
;;   Rewards are paid in sBTC because `stake` is called with a `signer-calldata`
;;   of `none`. Under the canonical signer-manager implementation, supplying a
;;   pox-addr in the calldata routes rewards to an L1 Bitcoin address via an
;;   sBTC withdrawal; omitting it pays sBTC directly to the staker principal.
;;

;; TRAITS

(impl-trait 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.extension-trait.extension-trait)
(use-trait signer-manager-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)

;; CONSTANTS

;; error codes
(define-constant ERR_UNAUTHORIZED (err u14000)) ;; caller is not the DAO or an authorized extension
(define-constant ERR_NO_APPROVED_SIGNER (err u14001)) ;; the DAO has not set a signer yet
(define-constant ERR_SIGNER_NOT_APPROVED (err u14002)) ;; the supplied signer-manager is not the approved one
(define-constant ERR_INVALID_NUM_CYCLES (err u14003)) ;; cycle count above pox-5's 96, or nothing left to extend by
(define-constant ERR_NOTHING_TO_STAKE (err u14004)) ;; no unlocked STX held by this contract
(define-constant ERR_NOTHING_TO_FORWARD (err u14005)) ;; no sBTC held by this contract
(define-constant ERR_NOTHING_TO_RETURN (err u14006)) ;; no unlocked STX to send onward

;; the only account STX principal can ever be returned to
(define-constant MINING_TREASURY 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-mining-v3)
;; the only account sBTC rewards can ever be forwarded to
(define-constant REWARDS_TREASURY 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-rewards-v3)

;; matches pox-5's own MAX_NUM_CYCLES
(define-constant MAX_NUM_CYCLES u96)

;; DATA VARS

;; The single signer-manager the DAO has approved. `none` disables staking.
(define-data-var approved-signer (optional principal) none)
;; Lock length used by `stake-stx`, and the ceiling on what a single
;; `stake-update` may add. Zero disables both.
(define-data-var num-cycles uint u12)

;; PUBLIC FUNCTIONS

;; Authorization check: caller must be the DAO base contract or an enabled extension.
(define-public (is-dao-or-extension)
  (ok (asserts!
    (or
      (is-eq tx-sender 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.base-dao)
      (contract-call? 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.base-dao
        is-extension contract-caller
      )
    )
    ERR_UNAUTHORIZED
  ))
)

;; Required by extension-trait. No-op callback.
(define-public (callback
    ;; #[allow(unused_binding)]
    (sender principal)
    ;; #[allow(unused_binding)]
    (memo (buff 34))
  )
  (ok true)
)

;; Set (or clear, with `none`) the signer-manager this contract may stake with.
;; Clearing it does not unstake an existing position; it only blocks new
;; `stake-stx` / `stake-update` calls.
(define-public (set-approved-signer (signer (optional principal)))
  (begin
    (try! (is-dao-or-extension))
    (print {
      event: "set-approved-signer",
      signer: signer,
      caller: contract-caller,
      sender: tx-sender,
    })
    (ok (var-set approved-signer signer))
  )
)

;; Set the lock length used by `stake-stx`, and the maximum a single
;; `stake-update` call may add.
(define-public (set-num-cycles (cycles uint))
  (begin
    (try! (is-dao-or-extension))
    (asserts! (<= cycles MAX_NUM_CYCLES)
      ERR_INVALID_NUM_CYCLES
    )
    (print {
      event: "set-num-cycles",
      cycles: cycles,
      caller: contract-caller,
      sender: tx-sender,
    })
    (ok (var-set num-cycles cycles))
  )
)

;; Stake this contract's entire unlocked STX balance with the approved signer,
;; starting at the next reward cycle, for `num-cycles` cycles.
;;
;; Permissionless: anyone may call it, and it can only ever lock this
;; contract's own STX with the DAO-approved signer. `start-burn-ht` is the
;; current burn height, which PoX-5 resolves to the next reward cycle.
;; `signer-calldata` is `none`, which selects sBTC rewards paid to this
;; contract rather than an L1 Bitcoin withdrawal.
;;
;; The allowance permits staking `amount` and nothing else: no transfer of any
;; kind can leave this contract through the signer-manager callback.
;;
;; Reverts inside PoX-5 during a prepare phase, and reverts if this contract is
;; already staking.
(define-public (stake-stx (signer-manager <signer-manager-trait>))
  (let ((amount (stx-get-balance current-contract)))
    (try! (assert-approved-signer (contract-of signer-manager)))
    (asserts! (> amount u0) ERR_NOTHING_TO_STAKE)
    (print {
      event: "stake-stx",
      amount: amount,
      cycles: (var-get num-cycles),
      signer: (contract-of signer-manager),
      caller: contract-caller,
    })
    (ok (try! (as-contract? ((with-staking amount))
      (try! (contract-call? 'SP000000000000000000002Q6VF78.pox-5 stake signer-manager
        amount (var-get num-cycles) burn-block-height none
      ))
    )))
  )
)

;; Extend an existing position back out to `num-cycles`, and fold in any STX
;; that has accumulated here since the last call.
;;
;; The increment is derived from the live position rather than passed straight
;; through: pox-5 caps the resulting TOTAL lock at 96 cycles, not the increment,
;; so handing it the configured length raw makes every call on a healthy
;; position ask for `remaining + num-cycles` and be rejected. `cycles-to-extend`
;; is therefore the headroom left under the cap, capped in turn at `num-cycles`.
;; See `get-cycles-to-extend`.
;;
;; Permissionless, same reasoning as `stake-stx`. `signer-manager` may differ
;; from `old-signer-manager` to migrate signers, but must still be the approved
;; one. The allowance covers the whole resulting position and permits no
;; transfers.
;;
;; This is the path that has to be closed to exit for good: `unstake-stx` only
;; shortens the lock to the end of the current cycle, and anyone may call this
;; to re-lock it for another term. Setting `num-cycles` to zero stops it: the
;; headroom is then capped at zero and the assert below rejects the call.
(define-public (stake-update
    (signer-manager <signer-manager-trait>)
    (old-signer-manager <signer-manager-trait>)
  )
  (let (
      (account (stx-account current-contract))
      (amount (get unlocked account))
      (staked (+ (get locked account) amount))
      (cycles-to-extend (get-cycles-to-extend))
    )
    (try! (assert-approved-signer (contract-of signer-manager)))
    ;; nothing to extend: either staking is disabled (`num-cycles` u0) or the
    ;; position is already locked for the maximum pox-5 allows
    (asserts! (> cycles-to-extend u0) ERR_INVALID_NUM_CYCLES)
    (print {
      event: "stake-update",
      amount-increase: amount,
      cycles-to-extend: cycles-to-extend,
      signer: (contract-of signer-manager),
      old-signer: (contract-of old-signer-manager),
      caller: contract-caller,
    })
    (ok (try! (as-contract? ((with-staking staked))
      (try! (contract-call? 'SP000000000000000000002Q6VF78.pox-5 stake-update
        signer-manager old-signer-manager cycles-to-extend amount none
      ))
    )))
  )
)

;; Wind the position down: PoX-5 shortens the lock to the end of the current
;; reward cycle. DAO-gated, because leaving the signer set is a governance
;; decision rather than routine maintenance. Nothing may leave the contract.
;;
;; On its own this does not end the position for good -- `stake-update` is
;; permissionless and re-locks it. A proposal that means to exit should call
;; `set-num-cycles` with u0 alongside this, in the same transaction.
(define-public (unstake-stx (old-signer-manager <signer-manager-trait>))
  (begin
    (try! (is-dao-or-extension))
    (print {
      event: "unstake-stx",
      old-signer: (contract-of old-signer-manager),
      caller: contract-caller,
      sender: tx-sender,
    })
    (ok (try! (as-contract? ((with-pox))
      (try! (contract-call? 'SP000000000000000000002Q6VF78.pox-5 unstake
        old-signer-manager
      ))
    )))
  )
)

;; Forward every sBTC reward held here to the MIA rewards treasury.
;;
;; Permissionless, and the recipient is a constant, so the worst a caller can
;; do is move rewards to their only legal destination sooner. The allowance is
;; exactly the balance being forwarded.
;;
;; Rewards only appear here after someone calls `claim-staker-rewards` on the
;; signer-manager for this contract; that call is itself permissionless.
(define-public (forward-rewards)
  (let ((balance (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance-available current-contract
    ))))
    (asserts! (> balance u0) ERR_NOTHING_TO_FORWARD)
    (print {
      event: "forward-rewards",
      amount: balance,
      recipient: REWARDS_TREASURY,
      caller: contract-caller,
    })
    (ok (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token"
        balance
      ))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer balance current-contract REWARDS_TREASURY none
      ))
    )))
  )
)

;; Return all unlocked STX to the mining treasury. DAO-gated so that a griefer
;; cannot empty this contract between the funding proposal and the first
;; `stake-stx` call; the destination is a constant either way.
(define-public (return-stx)
  (let ((amount (stx-get-balance current-contract)))
    (try! (is-dao-or-extension))
    (asserts! (> amount u0) ERR_NOTHING_TO_RETURN)
    (print {
      event: "return-stx",
      amount: amount,
      recipient: MINING_TREASURY,
      caller: contract-caller,
      sender: tx-sender,
    })
    (ok (try! (as-contract? ((with-stx amount))
      (try! (contract-call? MINING_TREASURY deposit-stx amount))
    )))
  )
)

;; READ ONLY FUNCTIONS

(define-read-only (get-approved-signer)
  (var-get approved-signer)
)

(define-read-only (get-num-cycles)
  (var-get num-cycles)
)

;; Cycles still on the position after the current one, as pox-5 counts them:
;; `first-reward-cycle + num-cycles` is the first cycle the STX is unlocked in,
;; and `stake-update` validates `that - current-cycle - 1` against the 96-cycle
;; cap. Zero once the position has lapsed, or when there is no position.
(define-read-only (get-cycles-remaining)
  (let (
      (current-cycle (contract-call? 'SP000000000000000000002Q6VF78.pox-5
        current-pox-reward-cycle
      ))
      (unlock-cycle (match (contract-call? 'SP000000000000000000002Q6VF78.pox-5
        get-staker-info current-contract
      )
        info (+ (get first-reward-cycle info) (get num-cycles info))
        u0
      ))
    )
    (if (> unlock-cycle (+ current-cycle u1))
      (- unlock-cycle current-cycle u1)
      u0
    )
  )
)

;; What `stake-update` may add: the DAO-set length, or whatever headroom is
;; left under pox-5's cap, whichever is smaller. Zero means the call would be
;; rejected -- either the position is already at the cap, or `num-cycles` is
;; zero because the DAO has switched staking off.
(define-read-only (get-cycles-to-extend)
  (let (
      (remaining (get-cycles-remaining))
      ;; guarded rather than a bare subtraction: an underflow would abort the
      ;; transaction instead of returning an error
      (headroom (if (> MAX_NUM_CYCLES remaining)
        (- MAX_NUM_CYCLES remaining)
        u0
      ))
      (configured (var-get num-cycles))
    )
    (if (< configured headroom)
      configured
      headroom
    )
  )
)

;; Everything a caller needs to decide whether to stake, extend, or forward.
(define-read-only (get-staking-info)
  (let ((account (stx-account current-contract)))
    {
      approved-signer: (var-get approved-signer),
      num-cycles: (var-get num-cycles),
      stx-unlocked: (get unlocked account),
      stx-locked: (get locked account),
      stx-unlock-height: (get unlock-height account),
      sbtc-balance: (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        get-balance-available current-contract
      )),
      staker-info: (contract-call? 'SP000000000000000000002Q6VF78.pox-5 get-staker-info
        current-contract
      ),
    }
  )
)

;; PRIVATE FUNCTIONS

(define-private (assert-approved-signer (signer principal))
  (ok (asserts!
    (is-eq signer (unwrap! (var-get approved-signer) ERR_NO_APPROVED_SIGNER))
    ERR_SIGNER_NOT_APPROVED
  ))
)