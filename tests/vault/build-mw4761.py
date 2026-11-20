"""Extend generated SDK dependencies for mw4761; never rewrite source .clar files.

Keep build.py's existing local changes intact. The old market fixture has no
rebate getter: these tests encode the getter's return value in a short update
buffer (empty = base 20 bps). This tests the vault's boundary/authorization,
not the real Lazer decoder, signatures, or age-to-rebate calculation.
"""
from pathlib import Path
import json
import subprocess
import sys

HERE = Path(__file__).resolve().parent
subprocess.run([sys.executable, str(HERE / 'build.py'), *sys.argv[1:]], check=True)
OUT = Path(sys.argv[sys.argv.index('--output') + 1]).resolve() if '--output' in sys.argv else HERE / '.build'
EXPECTED = {
    'ccd015-redemption-book-mia-stx': '8982d30e17db7f92cd8cdb902464d508aaa65ca389dac6bd0920a3e694c3f34a',
    'ccd016-swap-vault-mia-v2': '67cc859e005b8920c65183c5a346624fa3f2b159c2f5e8bb8b1d7d7793595935',
}
hashes = json.loads((OUT / 'source-hashes.json').read_text())
for name, expected in EXPECTED.items():
    if hashes[name] != expected:
        raise SystemExit(f'Unexpected {name} sha256: {hashes[name]}; expected {expected}')
market = OUT / 'contracts/v6-market.clar'
source = market.read_text()
assert '(define-read-only (get-taker-rebate-bps-for ' not in source
market.write_text(source + '''
;; SDK fixture only: update carries the rebate getter result, not a signed price.
(define-read-only (get-taker-rebate-bps-for (update (buff 8192)))
  (if (is-eq (len update) u0) u20
    (buff-to-uint-be (unwrap-panic (as-max-len? update u16)))))
;; Fund the pending bucket with a real token transfer. The older market fixture
;; has a pending getter but no deposit path that populates it.
(define-public (test-fund-pending (who principal) (amount uint))
  (begin
    (try! (contract-call? .mock-ft transfer amount tx-sender current-contract none))
    (ok (map-set token-x-pending-deposits who {
      amount: amount, limit: u32000000000000, spread-bps: none,
      submitted-at: stacks-block-time }))))
''')
print('Pinned mw4761 source hashes:', json.dumps(EXPECTED, sort_keys=True))
