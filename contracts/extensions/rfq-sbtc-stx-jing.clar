(use-trait ft-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

(define-constant PRICE_PRECISION u100000000)
(define-constant DECIMAL_FACTOR u100)
(define-constant BPS_PRECISION u10000)
(define-constant MAX_QUOTE_DRIFT_BPS u20)
(define-constant MAX_REF_STALENESS u120)
(define-constant FEE_BPS u10)

(define-data-var coinbase-ustx uint u500000000)
(define-constant TENURE_SAMPLE_OFFSETS (list
  u1 u367 u733 u1099 u1465 u1831 u2197 u2563
  u2929 u3295 u3661 u4027 u4393 u4759 u5125 u5491
  u5857 u6223 u6589 u6955 u7321 u7687 u8053 u8419
  u8785 u9151 u9517 u9883 u10249 u10615 u10981 u11347
  u11713 u12079 u12445 u12811 u13177 u13543 u13909 u14275
  u14641 u15007 u15373 u15739 u16105 u16471 u16837 u17203
))
(define-constant BAND_DIVISOR u2)

(define-constant OPEN_TTL u6)

(define-constant SIP018_MSG_PREFIX 0x534950303138)

(define-constant SAINT 'SP000000000000000000002Q6VF78)

(define-constant ERR_AMOUNT_TOO_SMALL (err u1001))
(define-constant ERR_STALE_PRICE (err u1005))
(define-constant ERR_ZERO_PRICE (err u1009))
(define-constant ERR_PAUSED (err u1010))
(define-constant ERR_NOT_AUTHORIZED (err u1011))
(define-constant ERR_ALREADY_INITIALIZED (err u1018))
(define-constant ERR_WRONG_TRAIT (err u1019))
(define-constant ERR_BAD_COINBASE (err u1021))
(define-constant ERR_NOT_CLIENT_ADMIN (err u1022))
(define-constant ERR_SAME_ADMIN (err u1023))
(define-constant ERR_RFQ_NOT_FOUND (err u2001))
(define-constant ERR_RFQ_CLOSED (err u2002))
(define-constant ERR_EXPIRED (err u2003))
(define-constant ERR_NOT_EXPIRED (err u2004))
(define-constant ERR_PREMIUM_TOO_HIGH (err u2005))
(define-constant ERR_BELOW_MIN_OUT (err u2006))
(define-constant ERR_BAD_AUTH (err u2007))
(define-constant ERR_AUTH_EXPIRED (err u2008))
(define-constant ERR_ABOVE_MAX_OUT (err u2009))
(define-constant ERR_ALREADY_FIXED (err u2011))
(define-constant ERR_NOT_FIXED (err u2012))
(define-constant ERR_NOT_WINNER (err u2013))
(define-constant ERR_QUOTE_DRIFT (err u2014))
(define-constant ERR_NOT_WHITELISTED (err u2015))
(define-constant ERR_BAD_REFERENCE (err u2016))
(define-constant ERR_CLIENT_NOT_WHITELISTED (err u2017))
(define-constant ERR_NO_PENDING_CLIENT (err u2018))
(define-constant ERR_CLIENT_IN_COOLDOWN (err u2019))
(define-constant ERR_NO_PENDING_MM (err u2020))
(define-constant ERR_MM_IN_COOLDOWN (err u2021))

(define-constant CLIENT_WHITELIST_COOLDOWN u144)
(define-constant MM_WHITELIST_COOLDOWN u144)

(define-data-var initialized bool false)
(define-data-var operator principal tx-sender)
(define-data-var treasury principal tx-sender)

(define-data-var client-admin principal tx-sender)
(define-data-var paused bool false)

(define-data-var token-x principal SAINT)
(define-data-var token-y principal SAINT)
(define-data-var min-sbtc-in uint u0)

(define-data-var band-enabled bool true)

(define-data-var next-rfq-id uint u0)

(define-map whitelisted-mms principal bool)
(define-map whitelisted-clients principal bool)
(define-map pending-clients principal uint)
(define-map pending-mms principal uint)

(define-map rfqs
  uint
  {
    client: principal,
    sbtc-in: uint,
    min-stx-out: uint,
    open-expiry: uint,
    winner: (optional principal),
    fixed-stx-out: (optional uint),
    fixed-oracle-price: (optional uint),
    open: bool,
  }
)

(define-read-only (get-domain-hash)
  (sha256 (unwrap-panic (to-consensus-buff? {
    name: "jing-rfq",
    version: "1",
    chain-id: chain-id,
  })))
)

(define-read-only (build-auth-hash
    (rfq-id uint)
    (winner principal)
    (quoted-out uint)
    (ref-price uint)
    (ref-timestamp uint)
    (ref-venue (string-ascii 16))
    (auth-expiry uint)
  )
  (sha256 (concat SIP018_MSG_PREFIX
    (concat (get-domain-hash)
      (sha256 (unwrap-panic (to-consensus-buff? {
        market: current-contract,
        rfq-id: rfq-id,
        winner: winner,
        quoted-out: quoted-out,
        ref-price: ref-price,
        ref-timestamp: ref-timestamp,
        ref-venue: ref-venue,
        expiry: auth-expiry,
      })))
    )))
)

(define-read-only (get-rfq (id uint))
  (map-get? rfqs id)
)

(define-read-only (is-whitelisted-mm (mm principal))
  (default-to false (map-get? whitelisted-mms mm))
)

(define-read-only (is-whitelisted-client (client principal))
  (default-to false (map-get? whitelisted-clients client))
)

(define-read-only (get-pending-client (client principal))
  (map-get? pending-clients client)
)

(define-read-only (get-pending-mm (mm principal))
  (map-get? pending-mms mm)
)

(define-read-only (get-client-admin)
  (var-get client-admin)
)

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
      (ok (/ (* u100 (var-get coinbase-ustx) PRICE_PRECISION) avg-spend))
    )
  )
)

(define-read-only (get-next-rfq-id)
  (var-get next-rfq-id)
)

(define-public (open-rfq
    (sbtc-in uint)
    (min-stx-out uint)
    (x <ft-trait>)
    (x-name (string-ascii 128))
  )
  (let (
      (id (var-get next-rfq-id))
      (open-expiry (+ burn-block-height OPEN_TTL))
    )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-whitelisted-client tx-sender) ERR_CLIENT_NOT_WHITELISTED)
    (asserts! (is-eq (contract-of x) (var-get token-x)) ERR_WRONG_TRAIT)
    (asserts! (> sbtc-in (var-get min-sbtc-in)) ERR_AMOUNT_TOO_SMALL)
    (asserts! (> min-stx-out u0) ERR_AMOUNT_TOO_SMALL)
    (try! (contract-call? x transfer sbtc-in tx-sender current-contract none))
    (map-set rfqs id {
      client: tx-sender,
      sbtc-in: sbtc-in,
      min-stx-out: min-stx-out,
      open-expiry: open-expiry,
      winner: none,
      fixed-stx-out: none,
      fixed-oracle-price: none,
      open: true,
    })
    (var-set next-rfq-id (+ id u1))
    (try! (contract-call? .jing-core-v2 log-rfq-open id tx-sender sbtc-in min-stx-out
      open-expiry (var-get token-x) (var-get token-y)
    ))
    (ok id)
  )
)

(define-public (fix-price
    (id uint)
    (committed-out uint)
    (quoted-out uint)
    (ref-price uint)
    (ref-timestamp uint)
    (ref-venue (string-ascii 16))
    (auth-expiry uint)
    (sig (buff 65))
  )
  (let (
      (rfq (unwrap! (map-get? rfqs id) ERR_RFQ_NOT_FOUND))
      (mm tx-sender)
      (client (get client rfq))
      (sbtc-in (get sbtc-in rfq))
    )
    (asserts! (not (var-get paused)) ERR_PAUSED)
    (asserts! (is-whitelisted-mm mm) ERR_NOT_WHITELISTED)
    (asserts! (get open rfq) ERR_RFQ_CLOSED)
    (asserts! (is-none (get winner rfq)) ERR_ALREADY_FIXED)
    (asserts! (<= burn-block-height (get open-expiry rfq)) ERR_EXPIRED)
    (asserts! (< stacks-block-height auth-expiry) ERR_AUTH_EXPIRED)
    (asserts! (> ref-price u0) ERR_BAD_REFERENCE)
    (asserts! (> (len ref-venue) u0) ERR_BAD_REFERENCE)
    (asserts! (<= ref-timestamp stacks-block-time) ERR_BAD_REFERENCE)
    (asserts! (> ref-timestamp (- stacks-block-time MAX_REF_STALENESS))
      ERR_STALE_PRICE
    )

    (asserts!
      (is-eq
        (unwrap!
          (principal-of?
            (unwrap! (secp256k1-recover?
              (build-auth-hash id mm quoted-out ref-price ref-timestamp ref-venue
                auth-expiry
              ) sig)
              ERR_BAD_AUTH
            ))
          ERR_BAD_AUTH
        )
        client
      )
      ERR_BAD_AUTH
    )

    (let (
        (band-on (var-get band-enabled))
        (oracle-price (if band-on (try! (get-native-price)) u0))
        (stx-mid (/ (* sbtc-in oracle-price) (* PRICE_PRECISION DECIMAL_FACTOR)))
      )
      (asserts! (or (not band-on) (> oracle-price u0)) ERR_ZERO_PRICE)
      (asserts! (or (not band-on) (>= committed-out (/ stx-mid BAND_DIVISOR)))
        ERR_PREMIUM_TOO_HIGH
      )
      (asserts! (>= committed-out (get min-stx-out rfq)) ERR_BELOW_MIN_OUT)
      (asserts! (or (not band-on) (<= committed-out (* stx-mid BAND_DIVISOR)))
        ERR_ABOVE_MAX_OUT
      )
      (asserts!
        (>= (* committed-out BPS_PRECISION)
          (* quoted-out (- BPS_PRECISION MAX_QUOTE_DRIFT_BPS))
        )
        ERR_QUOTE_DRIFT
      )
      (asserts!
        (<= (* committed-out BPS_PRECISION)
          (* quoted-out BPS_PRECISION)
        )
        ERR_QUOTE_DRIFT
      )

      (map-set rfqs id (merge rfq {
        winner: (some mm),
        fixed-stx-out: (some committed-out),
        fixed-oracle-price: (some oracle-price),
      }))
      (print {
        event: "rfq-fix",
        rfq-id: id,
        client: client,
        mm: mm,
        sbtc-in: sbtc-in,
        stx-out: committed-out,
        quoted-out: quoted-out,
        ref-price: ref-price,
        ref-timestamp: ref-timestamp,
        ref-venue: ref-venue,
        oracle-price: oracle-price,
        open-expiry: (get open-expiry rfq),
      })
      (ok {
        stx-out: committed-out,
        open-expiry: (get open-expiry rfq),
        oracle-price: oracle-price,
      })
    )
    )
  )

(define-public (fulfill
    (id uint)
    (x <ft-trait>)
    (x-name (string-ascii 128))
  )
  (let (
      (rfq (unwrap! (map-get? rfqs id) ERR_RFQ_NOT_FOUND))
      (mm tx-sender)
      (client (get client rfq))
      (sbtc-in (get sbtc-in rfq))
      (winner (unwrap! (get winner rfq) ERR_NOT_FIXED))
      (stx-out (unwrap! (get fixed-stx-out rfq) ERR_NOT_FIXED))
      (oracle-price (unwrap! (get fixed-oracle-price rfq) ERR_NOT_FIXED))
      (fee (/ (* stx-out FEE_BPS) BPS_PRECISION))
      (client-receives (- stx-out fee))
    )
    (asserts! (get open rfq) ERR_RFQ_CLOSED)
    (asserts! (is-eq mm winner) ERR_NOT_WINNER)
    (asserts! (<= burn-block-height (get open-expiry rfq)) ERR_EXPIRED)
    (asserts! (is-eq (contract-of x) (var-get token-x)) ERR_WRONG_TRAIT)

    (and (> fee u0)
      (try! (stx-transfer? fee mm (var-get treasury)))
    )
    (try! (stx-transfer? client-receives mm client))

    (try! (as-contract? ((with-ft (contract-of x) x-name sbtc-in))
      (try! (contract-call? x transfer sbtc-in current-contract mm none))
    ))

    (map-set rfqs id (merge rfq { open: false }))
    (try! (contract-call? .jing-core-v2 log-rfq-fill id client mm sbtc-in stx-out
      fee oracle-price (var-get token-x) (var-get token-y)
    ))
    (ok {
      stx-out: stx-out,
      fee: fee,
      client-receives: client-receives,
      oracle-price: oracle-price,
    })
  )
)

(define-public (reclaim
    (id uint)
    (x <ft-trait>)
    (x-name (string-ascii 128))
  )
  (let (
      (rfq (unwrap! (map-get? rfqs id) ERR_RFQ_NOT_FOUND))
      (sbtc-in (get sbtc-in rfq))
    )
    (asserts! (get open rfq) ERR_RFQ_CLOSED)
    (asserts! (is-eq (contract-of x) (var-get token-x)) ERR_WRONG_TRAIT)
    (asserts! (> burn-block-height (get open-expiry rfq)) ERR_NOT_EXPIRED)
    (try! (as-contract? ((with-ft (contract-of x) x-name sbtc-in))
      (try! (contract-call? x transfer sbtc-in current-contract (get client rfq) none))
    ))
    (map-set rfqs id (merge rfq { open: false }))
    (try! (contract-call? .jing-core-v2 log-rfq-cancel id (get client rfq) sbtc-in
      (var-get token-x) (var-get token-y)
    ))
    (ok sbtc-in)
  )
)

(define-public (initialize
    (canonical principal)
    (x principal)
    (y principal)
    (min-x uint)
    (new-client-admin principal)
  )
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (asserts! (is-eq tx-sender (contract-call? .jing-core-v2 get-contract-owner))
      ERR_NOT_AUTHORIZED
    )
    (asserts! (not (var-get initialized)) ERR_ALREADY_INITIALIZED)
    (asserts! (not (is-eq new-client-admin (var-get operator))) ERR_SAME_ADMIN)
    (var-set token-x x)
    (var-set token-y y)
    (var-set min-sbtc-in min-x)
    (var-set client-admin new-client-admin)
    (var-set initialized true)
    (map-set whitelisted-clients 'SP3KJBWTS3K562BF5NXWG5JC8W90HEG7WPYH5B97X true)
    (map-set whitelisted-clients 'SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP true)
    (map-set whitelisted-mms 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.yguazu-stx-safe true)
    (try! (contract-call? .jing-core-v2 register canonical))
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
    (asserts! (not (is-eq new-operator (var-get client-admin))) ERR_SAME_ADMIN)
    (ok (var-set operator new-operator))
  )
)

(define-public (set-min-sbtc-in (amount uint))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (ok (var-set min-sbtc-in amount))
  )
)

(define-public (propose-mm-whitelist (mm principal))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (map-set pending-mms mm burn-block-height)
    (print {
      event: "rfq-mm-proposed",
      mm: mm,
      proposed-at: burn-block-height,
    })
    (ok true)
  )
)

(define-public (cancel-mm-whitelist (mm principal))
  (begin
    (asserts!
      (or
        (is-eq tx-sender (var-get operator))
        (is-eq tx-sender (var-get client-admin))
      )
      ERR_NOT_AUTHORIZED
    )
    (asserts! (is-some (map-get? pending-mms mm)) ERR_NO_PENDING_MM)
    (map-delete pending-mms mm)
    (print {
      event: "rfq-mm-canceled",
      mm: mm,
    })
    (ok true)
  )
)

(define-public (confirm-mm-whitelist (mm principal))
  (let ((proposed-at (unwrap! (map-get? pending-mms mm) ERR_NO_PENDING_MM)))
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (asserts! (>= burn-block-height (+ proposed-at MM_WHITELIST_COOLDOWN))
      ERR_MM_IN_COOLDOWN
    )
    (map-delete pending-mms mm)
    (print {
      event: "rfq-mm-whitelist",
      mm: mm,
      whitelisted: true,
    })
    (ok (map-set whitelisted-mms mm true))
  )
)

(define-public (revoke-mm-whitelist (mm principal))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (print {
      event: "rfq-mm-whitelist",
      mm: mm,
      whitelisted: false,
    })
    (ok (map-set whitelisted-mms mm false))
  )
)

(define-public (propose-client-whitelist (client principal))
  (begin
    (asserts! (is-eq tx-sender (var-get client-admin)) ERR_NOT_CLIENT_ADMIN)
    (map-set pending-clients client burn-block-height)
    (print {
      event: "rfq-client-proposed",
      client: client,
      proposed-at: burn-block-height,
    })
    (ok true)
  )
)

(define-public (cancel-client-whitelist (client principal))
  (begin
    (asserts!
      (or
        (is-eq tx-sender (var-get client-admin))
        (is-eq tx-sender (var-get operator))
      )
      ERR_NOT_CLIENT_ADMIN
    )
    (asserts! (is-some (map-get? pending-clients client)) ERR_NO_PENDING_CLIENT)
    (map-delete pending-clients client)
    (print {
      event: "rfq-client-canceled",
      client: client,
    })
    (ok true)
  )
)

(define-public (confirm-client-whitelist (client principal))
  (let ((proposed-at (unwrap! (map-get? pending-clients client) ERR_NO_PENDING_CLIENT)))
    (asserts! (is-eq tx-sender (var-get client-admin)) ERR_NOT_CLIENT_ADMIN)
    (asserts! (>= burn-block-height (+ proposed-at CLIENT_WHITELIST_COOLDOWN))
      ERR_CLIENT_IN_COOLDOWN
    )
    (map-delete pending-clients client)
    (print {
      event: "rfq-client-whitelist",
      client: client,
      whitelisted: true,
    })
    (ok (map-set whitelisted-clients client true))
  )
)

(define-public (revoke-client-whitelist (client principal))
  (begin
    (asserts! (is-eq tx-sender (var-get client-admin)) ERR_NOT_CLIENT_ADMIN)
    (print {
      event: "rfq-client-whitelist",
      client: client,
      whitelisted: false,
    })
    (ok (map-set whitelisted-clients client false))
  )
)

(define-public (set-client-admin (new-client-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get client-admin)) ERR_NOT_CLIENT_ADMIN)
    (asserts! (not (is-eq new-client-admin (var-get operator))) ERR_SAME_ADMIN)
    (print {
      event: "rfq-client-admin-set",
      client-admin: new-client-admin,
    })
    (ok (var-set client-admin new-client-admin))
  )
)

(define-public (set-band-enabled (enabled bool))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (print {
      event: "rfq-band-enabled",
      enabled: enabled,
    })
    (ok (var-set band-enabled enabled))
  )
)

(define-public (set-coinbase-ustx (ustx uint))
  (begin
    (asserts! (is-eq tx-sender (var-get operator)) ERR_NOT_AUTHORIZED)
    (asserts! (or (is-eq ustx u500000000) (is-eq ustx u1000000000))
      ERR_BAD_COINBASE
    )
    (print {
      event: "rfq-coinbase-set",
      coinbase-ustx: ustx,
    })
    (ok (var-set coinbase-ustx ustx))
  )
)

(define-read-only (get-coinbase-ustx)
  (var-get coinbase-ustx)
)

(define-read-only (get-band-enabled)
  (var-get band-enabled)
)
