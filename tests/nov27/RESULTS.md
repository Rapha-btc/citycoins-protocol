# November 26–27 validation and coverage

All listed tests passed with Clarinet CLI/SDK 3.23.2 and Vitest 3.2.4. Sources and SHA-256 hashes are recorded in [latest.json](reports/latest.json).

| Test file | Result | Passed |
|---|---|---:|
| [ccd016-swap-vault-mia-v2.test.ts](ccd016-swap-vault-mia-v2.test.ts) | PASS | 19 |
| [rendezvous.test.ts](rendezvous.test.ts) | PASS | 6 |
| [vault-lifecycle.test.ts](vault-lifecycle.test.ts) | PASS | 15 |

## Whole-contract Clarity coverage

SDK LCOV is merged across fresh simnets. Mock/dependency contracts are excluded from these totals. Function denominators include uncalled functions. Branch coverage is not emitted by this SDK; no branch-coverage percentage is claimed.

| Production source | Baseline lines | Current lines | Functions reached |
|---|---:|---:|---:|
| `contracts/extensions/ccd016-swap-vault-mia-v2.clar` | 57.69% | 91.65% (483/527) | 48/49 |

## Reproducible fuzzing

Rendezvous 1.0.3 generates ABI-typed inputs; fast-check shrinks failures. Seeds: `20261126`, `20261127`; **500 cases per property**, **3,000 generated cases** in this repository. Assertions run against production contract bodies with local external mocks. There are no discards or skipped properties. These are Rendezvous SDK tests inside Vitest, not runs of the legacy RV CLI suites.

```sh
npm ci --prefix tests/nov27
npm --prefix tests/nov27 test
# Larger campaign; seed values stay fixed for reproducibility:
RV_RUNS=2000 npm --prefix tests/nov27 test
```

The original 88-test baseline is preserved in [baseline.json](reports/baseline.json). Current results, complete uncovered line/function lists and source hashes are in [latest.json](reports/latest.json). Raw LCOV and Vitest JSON remain under `.build/`.

## Scope and next coverage work

Passing mocks do not validate mainnet liquidity, external oracle availability, or node-level PoX locking. Increasing whole-contract coverage requires exercising the remaining production paths, not counting mocks or removing defensive guards.
- `vault`: uncalled functions: `callback`.
