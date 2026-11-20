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
    'ccd016-swap-vault-mia-v2': '237e2f007825b40a1b6f62fab6aae0e154eb11f0d0ac026a53df5a7a830f8382',
}
hashes = json.loads((OUT / 'source-hashes.json').read_text())
for name, expected in EXPECTED.items():
    if hashes[name] != expected:
        raise SystemExit(f'Unexpected {name} sha256: {hashes[name]}; expected {expected}')
market = OUT / 'contracts/v6-market.clar'
source = market.read_text()
# build.py now adds the rebate getter shim itself (same definition: empty
# update = base 20 bps, else the update's bytes encode the rebate), so the
# plain `--rv` build compiles; only the pending-bucket helper is added here.
assert '(define-read-only (get-taker-rebate-bps-for (update (buff 8192)))' in source
market.write_text(source + '''
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
