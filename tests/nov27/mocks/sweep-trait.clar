(define-trait sweep-interface ((sweep () (response {notification: (string-ascii 5), payload: {recipient: principal, sbtc: uint, stx: uint}} uint))))
