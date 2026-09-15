;; Title: CCD016 swap vault: trust Lazer alone (DIA band off)
;; Escape hatch, not a routine: run only if the DIA push oracle goes stale or
;; silent for long enough that the vault's patience window would burn with
;; nothing on the book (jing-place cannot price without DIA while the band
;; is on; a stale DIA push is u16036, a missing one u16035). Sets the
;; vault's DIA band to 0: current-mid then trusts the Jing market's own
;; Lazer verification (signed update, max age 80 s, confidence required)
;; with no second oracle. A follow-up proposal restores the band
;; (set-dia-band-bps u1000) once DIA is back.
;;
;; MAINNET: the vault ships from the ccd015 book's deployer, not the DAO's;
;; replace the relative reference with the literal before submitting.
(impl-trait 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.proposal-trait.proposal-trait)

(define-public (execute (sender principal))
  (begin
    (try! (contract-call? .ccd016-swap-vault-mia-v2 set-dia-band-bps u0))
    (print "CCD016: DIA band off, the vault prices on Lazer alone until a proposal turns it back on")
    (ok true)
  )
)
