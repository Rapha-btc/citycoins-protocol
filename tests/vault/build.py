#!/usr/bin/env python3
"""Compile current vault/book against self-contained test dependencies; production untouched."""
from pathlib import Path
import sys,shutil,json,hashlib
here=Path(__file__).resolve().parent;root=here.parents[1];rv='--rv' in sys.argv
out=here/('.build-rv' if rv else '.build');(out/'contracts').mkdir(parents=True,exist_ok=True);(out/'settings').mkdir(exist_ok=True)
replacements={
# the -v6-3 / -v5-3 ids first: the bare -v6 / -v5 prefixes below would otherwise leave a stray "-3"
"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3":'.v6-market',
"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jing-v5-3":'.mock-router',
"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6":'.v6-market',
"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jing-v5":'.mock-router',
"'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3":'.mock-native',
"'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token":'.mock-ft',
"'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2":'.mock-ft',
"'SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle":'.mock-dia',
"'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.base-dao":'.mock-base-dao',
"'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.extension-trait":'.extension-trait',
"'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-rewards-v3":'.mock-treasury',
"'SP1H1733V5MZ3SZ9XRW9FKYGEZT0JDGEB8Y634C7R.miamicoin-token-v2":'.mock-mia',
"'SP466FNC0P7JWTNM2R9T199QRZN1MYEDTAR0KP27.miamicoin-token":'.mock-mia-v1',
"'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-mining-v3":"'ST3NBRSFKX28FQ2ZJ1MAKX58HKHSDGNV5N7R21XCP",
"'SPN4Y5QPGQA8882ZXW90ADC2DHYXMSTN8VAR8C3X.ccd014-pox5-staking-mia":"'STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6",
'"sbtc-token"':'"mock-ft"'}
files={p.stem:p.read_text() for p in (here/'fixtures').glob('*.clar')};hashes={}
for n in ['ccd016-swap-vault-mia-v2','ccd015-redemption-book-mia-stx']:
 s=(root/f'contracts/extensions/{n}.clar').read_text();hashes[n]=hashlib.sha256(s.encode()).hexdigest();files[n]=s
for n,s in files.items():
 for a,b in replacements.items():s=s.replace(a,b)
 if n=='v6-market':
  s+='\n(define-public (test-park (who principal)) (park-token-x (var-get current-cycle) (contract-call? .mock-lazer-oracle get-mid) who (get-token-x-depositors (var-get current-cycle))))\n'
  start=s.index('(define-public (refresh-mid');depth=0
  for i in range(start,len(s)):
   if s[i]=='(':depth+=1
   elif s[i]==')':
    depth-=1
    if depth==0:end=i+1;break
  original=s[start:end];first=original.index('\n')+1;body=original[first:].rsplit(')',1)[0]
  s=s[:start]+original[:first]+' (if (var-get test-zero-mid) (ok u0) '+body+'))'+s[end:]
  s='(define-data-var test-zero-mid bool false)\n(define-public (test-zero-price (b bool)) (ok (var-set test-zero-mid b)))\n'+s
 if rv and n=='ccd016-swap-vault-mia-v2':
  start=s.index('(define-public (is-dao-or-extension)');depth=0
  for i in range(start,len(s)):
   if s[i]=='(':depth+=1
   elif s[i]==')':
    depth-=1
    if depth==0:end=i+1;break
  s=s[:start]+"(define-public (is-dao-or-extension) (ok (asserts! (is-eq tx-sender 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM) ERR_UNAUTHORIZED)))"+s[end:]
  s+='\n'+(here/'rv.invariants.clar').read_text()
 (out/f'contracts/{n}.clar').write_text(s)
manifest='[project]\nname = "citycoins-vault-runtime"\ntelemetry = false\ncache_dir = "./.cache"\n[repl.analysis]\npasses = []\n'
for n in files:manifest+=f'\n[contracts.{n}]\npath = "contracts/{n}.clar"\nclarity_version = 6\nepoch = "4.0"\n'
(out/'Clarinet.toml').write_text(manifest);shutil.copy(root/'settings/Devnet.toml',out/'settings/Devnet.toml');(out/'source-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n');print('Built',out)
