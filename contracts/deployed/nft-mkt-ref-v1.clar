(use-trait nft-trait 'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.nft-trait.nft-trait)
(use-trait ft-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

(define-constant CONTRACT-OWNER tx-sender)
(define-constant FAKFUN-NFTS-CORE 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.fakfun-nfts-core)
(define-constant PEPECOIN 'SP1Z92MPDQEWZXW36VX71Q25HKF5K2EPCJ304F275.tokensoft-token-v4k68639zxz)

(define-data-var fakfun principal 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22)

(define-constant ERR-NOT-AUTHORIZED (err u200))
(define-constant ERR-ALREADY-LISTED (err u201))
(define-constant ERR-NOT-LISTED (err u202))
(define-constant ERR-NOT-OWNER (err u203))
(define-constant ERR-FT-NOT-WHITELISTED (err u204))
(define-constant ERR-INVALID-PRICE (err u205))
(define-constant ERR-CANNOT-BUY-OWN (err u206))
(define-constant ERR-PAUSED (err u207))
(define-constant ERR-WRONG-NFT (err u208))
(define-constant ERR-ALREADY-INITIALIZED (err u209))
(define-constant ERR-NOT-INITIALIZED (err u210))
(define-constant ERR-WRONG-FT (err u211))
(define-constant ERR-NFT-NOT-TRANSFERRED (err u212))

(define-data-var contract-paused bool false)
(define-data-var royalty-percent uint u250)
(define-data-var royalty-recipient principal CONTRACT-OWNER)
(define-data-var platform-fee uint u250)
(define-data-var platform-recipient principal 'SMH8FRN30ERW1SX26NJTJCKTDR3H27NRJ6W75WQE)

(define-data-var allowed-nft (optional principal) none)

(define-map whitelisted-fts principal bool)

(define-map listings uint {
  seller: principal,
  ft-contract: principal,
  price: uint,
  listed-at: uint
})

(define-public (initialize (nft-contract principal))
  (begin
    (asserts! (is-eq tx-sender (var-get fakfun)) ERR-NOT-AUTHORIZED)
    (asserts! (is-none (var-get allowed-nft)) ERR-ALREADY-INITIALIZED)
    (var-set allowed-nft (some nft-contract))
    (map-set whitelisted-fts PEPECOIN true)
    (print {event: "initialized", nft-contract: nft-contract})
    (ok true)))

(define-public (register-nft-marketplace
    (verified-contract principal)
    (name (string-ascii 128)))
  (let ((nft-principal (unwrap! (var-get allowed-nft) ERR-NOT-INITIALIZED)))
    (asserts! (or
      (is-eq tx-sender CONTRACT-OWNER)
      (is-eq tx-sender (var-get fakfun)))
      ERR-NOT-AUTHORIZED)
    (contract-call?
      FAKFUN-NFTS-CORE
      register-marketplace
      verified-contract
      nft-principal
      name)))

(define-public (set-paused (paused bool))
  (begin
    (asserts! (is-eq tx-sender (var-get fakfun)) ERR-NOT-AUTHORIZED)
    (var-set contract-paused paused)
    (print {event: "contract-paused", paused: paused})
    (ok true)))

(define-public (whitelist-ft (ft <ft-trait>) (whitelisted bool))
  (begin
    (asserts! (is-eq tx-sender (var-get fakfun)) ERR-NOT-AUTHORIZED)
    (map-set whitelisted-fts (contract-of ft) whitelisted)
    (print {event: "ft-whitelist-update", ft-contract: (contract-of ft), whitelisted: whitelisted})
    (ok true)))

(define-public (set-royalty-percent (percent uint))
  (begin
    (asserts! (is-eq tx-sender (var-get fakfun)) ERR-NOT-AUTHORIZED)
    (asserts! (<= percent u1000) ERR-NOT-AUTHORIZED) ;; Max 10%
    (var-set royalty-percent percent)
    (print {event: "royalty-percent-updated", percent: percent})
    (ok true)))

(define-public (set-royalty-recipient (recipient principal))
  (begin
    (asserts! (or
      (is-eq tx-sender CONTRACT-OWNER)
      (is-eq tx-sender (var-get fakfun)))
      ERR-NOT-AUTHORIZED)
    (var-set royalty-recipient recipient)
    (print {event: "royalty-recipient-updated", recipient: recipient})
    (ok true)))

(define-public (set-platform-fee (fee uint))
  (begin
    (asserts! (is-eq tx-sender (var-get fakfun)) ERR-NOT-AUTHORIZED)
    (asserts! (<= fee u500) ERR-NOT-AUTHORIZED) ;; Max 5%
    (var-set platform-fee fee)
    (print {event: "platform-fee-updated", fee: fee})
    (ok true)))

(define-public (set-platform-recipient (recipient principal))
  (begin
    (asserts! (is-eq tx-sender (var-get fakfun)) ERR-NOT-AUTHORIZED)
    (var-set platform-recipient recipient)
    (print {event: "platform-recipient-updated", recipient: recipient})
    (ok true)))

(define-public (set-fakfun (new-fakfun principal))
  (begin
    (asserts! (is-eq tx-sender (var-get fakfun)) ERR-NOT-AUTHORIZED)
    (var-set fakfun new-fakfun)
    (print {event: "fakfun-updated", new-fakfun: new-fakfun})
    (ok true)))

(define-private (check-nft-allowed (nft-contract <nft-trait>))
  (match (var-get allowed-nft)
    allowed (is-eq (contract-of nft-contract) allowed)
    false))

(define-public (list-nft (token-id uint) (nft-contract <nft-trait>) (ft-contract <ft-trait>) (price uint))
  (let (
    (ft-principal (contract-of ft-contract))
    (seller tx-sender)
  )
    (asserts! (is-some (var-get allowed-nft)) ERR-NOT-INITIALIZED)
    (asserts! (check-nft-allowed nft-contract) ERR-WRONG-NFT)
    (asserts! (not (var-get contract-paused)) ERR-PAUSED)
    (asserts! (> price u0) ERR-INVALID-PRICE)
    (asserts! (is-ft-whitelisted ft-principal) ERR-FT-NOT-WHITELISTED)
    (asserts! (is-none (map-get? listings token-id)) ERR-ALREADY-LISTED)

    (try! (contract-call? nft-contract transfer token-id seller current-contract))
    (asserts!
      (is-eq (try! (contract-call? nft-contract get-owner token-id)) (some current-contract))
      ERR-NFT-NOT-TRANSFERRED)

    (map-set listings token-id {
      seller: seller,
      ft-contract: ft-principal,
      price: price,
      listed-at: stacks-block-height
    })

    (print {
      event: "nft-listed",
      token-id: token-id,
      seller: seller,
      ft-contract: ft-principal,
      price: price
    })
    (ok true)))

(define-public (update-price (token-id uint) (new-price uint))
  (let (
    (listing (unwrap! (map-get? listings token-id) ERR-NOT-LISTED))
  )
    (asserts! (not (var-get contract-paused)) ERR-PAUSED)
    (asserts! (is-eq (get seller listing) tx-sender) ERR-NOT-OWNER)
    (asserts! (> new-price u0) ERR-INVALID-PRICE)

    (map-set listings token-id (merge listing {price: new-price}))

    (print {event: "price-updated", token-id: token-id, new-price: new-price})
    (ok true)))

(define-public (update-listing-ft (token-id uint) (new-ft-contract <ft-trait>) (new-price uint))
  (let (
    (listing (unwrap! (map-get? listings token-id) ERR-NOT-LISTED))
    (new-ft-principal (contract-of new-ft-contract))
  )
    (asserts! (not (var-get contract-paused)) ERR-PAUSED)
    (asserts! (is-eq (get seller listing) tx-sender) ERR-NOT-OWNER)
    (asserts! (> new-price u0) ERR-INVALID-PRICE)
    (asserts! (is-ft-whitelisted new-ft-principal) ERR-FT-NOT-WHITELISTED)

    (map-set listings token-id (merge listing {
      ft-contract: new-ft-principal,
      price: new-price
    }))

    (print {
      event: "listing-updated",
      token-id: token-id,
      ft-contract: new-ft-principal,
      price: new-price
    })
    (ok true)))

(define-public (unlist-nft (token-id uint) (nft-contract <nft-trait>))
  (let (
    (listing (unwrap! (map-get? listings token-id) ERR-NOT-LISTED))
    (seller (get seller listing))
  )
    (asserts! (check-nft-allowed nft-contract) ERR-WRONG-NFT)
    (asserts! (is-eq seller tx-sender) ERR-NOT-OWNER)

    (try! (as-contract? ((with-nft (contract-of nft-contract) "*" (list token-id)))
      (try! (contract-call? nft-contract transfer token-id current-contract seller))))
    (asserts!
      (is-eq (try! (contract-call? nft-contract get-owner token-id)) (some seller))
      ERR-NFT-NOT-TRANSFERRED)

    (map-delete listings token-id)

    (print {event: "nft-unlisted", token-id: token-id, seller: seller})
    (ok true)))

(define-public (buy-nft (token-id uint) (nft-contract <nft-trait>) (ft-contract <ft-trait>))
  (let (
    (buyer tx-sender)
    (listing (unwrap! (map-get? listings token-id) ERR-NOT-LISTED))
    (seller (get seller listing))
    (price (get price listing))
    (listing-ft (get ft-contract listing))
    (royalty-amount (/ (* price (var-get royalty-percent)) u10000))
    (platform-amount (/ (* price (var-get platform-fee)) u10000))
    (seller-amount (- price (+ royalty-amount platform-amount)))
  )
    (asserts! (check-nft-allowed nft-contract) ERR-WRONG-NFT)
    (asserts! (not (var-get contract-paused)) ERR-PAUSED)
    (asserts! (is-eq (contract-of ft-contract) listing-ft) ERR-WRONG-FT)
    (asserts! (is-ft-whitelisted listing-ft) ERR-FT-NOT-WHITELISTED)
    (asserts! (not (is-eq buyer seller)) ERR-CANNOT-BUY-OWN)

    (try! (contract-call? ft-contract transfer seller-amount buyer seller none))

    (if (> royalty-amount u0)
      (try! (contract-call? ft-contract transfer royalty-amount buyer (var-get royalty-recipient) none))
      true
    )

    (if (> platform-amount u0)
      (try! (contract-call? ft-contract transfer platform-amount buyer (var-get platform-recipient) none))
      true
    )

    (try! (as-contract? ((with-nft (contract-of nft-contract) "*" (list token-id)))
      (try! (contract-call? nft-contract transfer token-id current-contract buyer))))
    (asserts!
      (is-eq (try! (contract-call? nft-contract get-owner token-id)) (some buyer))
      ERR-NFT-NOT-TRANSFERRED)

    (map-delete listings token-id)

    (print {
      event: "nft-sold",
      token-id: token-id,
      seller: seller,
      buyer: buyer,
      price: price,
      ft-contract: listing-ft,
      royalty-paid: royalty-amount,
      platform-fee-paid: platform-amount
    })
    (ok true)))

(define-public (admin-emergency-return (token-id uint) (nft-contract <nft-trait>))
  (let (
    (listing (unwrap! (map-get? listings token-id) ERR-NOT-LISTED))
    (seller (get seller listing))
  )
    (asserts! (is-eq tx-sender (var-get fakfun)) ERR-NOT-AUTHORIZED)
    (asserts! (check-nft-allowed nft-contract) ERR-WRONG-NFT)

    (try! (as-contract? ((with-nft (contract-of nft-contract) "*" (list token-id)))
      (try! (contract-call? nft-contract transfer token-id current-contract seller))))
    (asserts!
      (is-eq (try! (contract-call? nft-contract get-owner token-id)) (some seller))
      ERR-NFT-NOT-TRANSFERRED)

    (map-delete listings token-id)

    (print {event: "admin-emergency-return", token-id: token-id, seller: seller})
    (ok true)))

(define-read-only (get-listing (token-id uint))
  (map-get? listings token-id))

(define-read-only (is-ft-whitelisted (ft-contract principal))
  (default-to false (map-get? whitelisted-fts ft-contract)))

(define-read-only (get-allowed-nft)
  (var-get allowed-nft))

(define-read-only (get-fakfun)
  (var-get fakfun))

(define-read-only (get-royalty-info)
  {
    percent: (var-get royalty-percent),
    recipient: (var-get royalty-recipient)
  })

(define-read-only (get-platform-info)
  {
    fee: (var-get platform-fee),
    recipient: (var-get platform-recipient)
  })

(define-read-only (is-paused)
  (var-get contract-paused))

(define-read-only (is-initialized)
  (is-some (var-get allowed-nft)))
