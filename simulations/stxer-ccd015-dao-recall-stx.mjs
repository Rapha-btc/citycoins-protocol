// Bounty mw4761 #5: new ccd015 dao-recall-stx, DAO-only, sends the book's
// whole STX balance to ccd002-treasury-mia-mining-v3.
//   non-DAO callers (stranger, deployer, seller) -> (err u15000), nothing moves;
//   a test proposal (proposal-trait), executed by 3 real approver signals on
//   ccd001-direct-execute -> book 0, mining-v3 up by exactly that balance;
//   a second proposal on the now-empty book -> (err u15010) on the 3rd signal.
// Mainnet fork; model: stxer-ccip028-activation.mjs. Fixture: a real STX
// holder sends 250 STX to the book (sim-stx-send wraps stx-transfer? from
// tx-sender); the vault path to the book (fuel-fair-book) is covered by the
// activation cycle.
import { harness, proposal, Cl, DEP, BASE, DIRECT, APPROVERS, BOOK, MINING_TREASURY, SELLER, CALLER, STX_SEND } from './_ccip028-fork.mjs';

const h = harness(process.env.SIM_RESULTS_DIR || 'simulations/results/ccd015-dao-recall-stx');
const FUNDER = process.env.STX_FUNDER || 'SP2XXSW2KPPTY7KJDYS9RQ868D7JH58QSZKK8KXAV';
const BUDGET = 250000000n;
const P1 = 'test-recall-stx', P2 = 'test-recall-stx-empty';
const SRC = proposal(['(contract-call? .ccd015-redemption-book-mia-stx dao-recall-stx)']);
async function main() {
  await h.setup({ offset: 50, extra: [STX_SEND, [P1, SRC], [P2, SRC]] });
  h.report.fixtures.push(`${FUNDER} sends ${BUDGET} uSTX to the book.`);
  await h.call('real holder sends 250 STX to the book', FUNDER, `${DEP}.${STX_SEND[0]}`, 'send', [Cl.uint(BUDGET), Cl.principal(BOOK)]);
  const b0 = await h.stx('book STX', BOOK);
  h.check('book holds the budget', b0 >= BUDGET, true);
  for (const [who, name] of [[CALLER, 'stranger'], [DEP, 'deployer'], [SELLER, 'seller'], [APPROVERS[0], 'approver (direct call)']])
    await h.call(`${name} dao-recall-stx -> (err u15000)`, who, BOOK, 'dao-recall-stx', [], '(err u15000)');
  h.check('book STX unchanged after refused calls', (await h.stx('book STX', BOOK)).toString(), b0.toString());
  const m0 = await h.stx('mining-v3 STX before', MINING_TREASURY);
  await h.signal3('recall-stx proposal', `${DEP}.${P1}`);
  h.check('book STX = 0', (await h.stx('book STX after', BOOK)).toString(), '0');
  h.check('mining-v3 up by exactly the book balance', ((await h.stx('mining-v3 STX after', MINING_TREASURY)) - m0).toString(), b0.toString());
  // zero balance: a second proposal fails on execution
  for (const [i, who] of APPROVERS.slice(0, 2).entries())
    await h.call(`empty recall: approver signal ${i + 1}`, who, DIRECT, 'direct-execute', [Cl.principal(`${DEP}.${P2}`)], `(ok u${i + 1})`);
  await h.call('empty recall: 3rd signal executes -> (err u15010)', APPROVERS[2], DIRECT, 'direct-execute', [Cl.principal(`${DEP}.${P2}`)], '(err u15010)');
  await h.read('empty recall: not recorded as executed', BASE, `(executed-at '${DEP}.${P2})`, 'none');
  h.done();
}
main().catch(h.fail);
