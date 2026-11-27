(use-trait sweep-interface .sweep-trait.sweep-interface)
(define-map extensions principal bool)
(define-public (set-extension (who principal) (enabled bool)) (ok (map-set extensions who enabled)))
(define-read-only (is-extension (who principal)) (default-to false (map-get? extensions who)))

(define-public (sweep (vault <sweep-interface>)) (as-contract? () (try! (contract-call? vault sweep))))
