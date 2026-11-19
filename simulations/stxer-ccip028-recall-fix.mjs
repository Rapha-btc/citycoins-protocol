// Bounty mw4761 #1: a DAO recall only sticks when the proposal first switches
// the vault off as an extension (base-dao set-extension ccd016 false), then
// runs dao-recall-sbtc. Ported from citycoins-protocol-ccip028-pr (33/33) to
// this branch's code. Mainnet fork; model: stxer-ccip028-activation.mjs.
// Fixture: a real sBTC holder tops the rewards treasury up to 100k sats.
import { harness, proposal, Cl, DEP, BASE, TREASURY, VAULT, CALLER } from './_ccip028-fork.mjs';

const h = harness(process.env.SIM_RESULTS_DIR || 'simulations/results/ccip028-recall-fix');
const PLAIN = 'test-recall-plain', FIXED = 'test-recall-fixed';
const SRC_PLAIN = proposal(['(contract-call? .ccd016-swap-vault-mia-v2 dao-recall-sbtc)']);
const SRC_FIXED = proposal([`(contract-call? '${BASE} set-extension .ccd016-swap-vault-mia-v2 false)`,
  '(contract-call? .ccd016-swap-vault-mia-v2 dao-recall-sbtc)']);
async function main() {
  await h.setup({ extra: [[PLAIN, SRC_PLAIN], [FIXED, SRC_FIXED]], offset: 50 });
  const t0 = await h.bal('treasury sBTC', TREASURY);
  if (t0 < 100000n) await h.give('top up treasury', 100000n - t0);
  const F = await h.bal('treasury sBTC before fund', TREASURY);

  // control: recall WITHOUT switching the vault off (bug reproduced)
  await h.call('fund-from-treasury #1', CALLER, VAULT, 'fund-from-treasury');
  h.check('vault got the whole treasury', (await h.bal('vault sBTC', VAULT)).toString(), F.toString());
  await h.signal3('plain recall', `${DEP}.${PLAIN}`);
  h.check('plain recall: vault 0', (await h.bal('vault sBTC', VAULT)).toString(), '0');
  h.check('plain recall: treasury back to F', (await h.bal('treasury sBTC', TREASURY)).toString(), F.toString());
  await h.read('plain recall: clock cleared', VAULT, '(get batch-start (get-clock))', 'none');
  await h.call('BUG: stranger fund-from-treasury right after plain recall succeeds', CALLER, VAULT, 'fund-from-treasury', [],
    function reopened(v) { return v.startsWith('(ok') && v.includes('(opened true)'); });
  h.check('BUG: vault holds everything again', (await h.bal('vault sBTC', VAULT)).toString(), F.toString());
  await h.read('BUG: window re-opened', VAULT, '(window-open)', 'true');

  // fix (a): set-extension false, then recall, in one proposal
  await h.signal3('fixed recall', `${DEP}.${FIXED}`);
  await h.read('fixed recall: vault no longer an extension', BASE, `(is-extension '${VAULT})`, 'false');
  h.check('fixed recall: vault 0', (await h.bal('vault sBTC', VAULT)).toString(), '0');
  h.check('fixed recall: treasury back to F', (await h.bal('treasury sBTC', TREASURY)).toString(), F.toString());
  await h.call('FIX: stranger fund-from-treasury after fixed recall -> (err u2000)', CALLER, VAULT, 'fund-from-treasury', [], '(err u2000)');
  h.check('FIX: treasury keeps F', (await h.bal('treasury sBTC', TREASURY)).toString(), F.toString());
  h.check('FIX: vault stays 0', (await h.bal('vault sBTC', VAULT)).toString(), '0');
  await h.read('FIX: no window', VAULT, '(window-open)', 'false');
  h.done();
}
main().catch(h.fail);
