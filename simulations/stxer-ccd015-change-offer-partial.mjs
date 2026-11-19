// Bounty mw4761 #4: ccd015 change-offer checks min-deposit only when MIA is
// added, so a partly filled offer under 100k MIA can still reprice.
// Seller places 100k MIA for 100 STX; a partial cross-book leaves < 100k;
// change-offer none <lower ask> -> ok (book shows it); change-offer (some x)
// keeping total < 100k -> (err u15005); cancel-offer refunds the rest.
// Mainnet fork; model: stxer-ccip028-activation.mjs. Fixture: a real STX
// holder sends 40 STX straight to the book as its budget (any principal can
// transfer STX to it; sim-stx-send only wraps stx-transfer? from tx-sender).
import { harness, Cl, DEP, BOOK, MIA, SELLER, CALLER, STX_SEND } from './_ccip028-fork.mjs';

const h = harness(process.env.SIM_RESULTS_DIR || 'simulations/results/ccd015-change-offer-partial');
const FUNDER = process.env.STX_FUNDER || 'SP2XXSW2KPPTY7KJDYS9RQ868D7JH58QSZKK8KXAV';
const MIA_IN = 100000000000n, ASK = 100000000n, BUDGET = 40000000n;
const TAKEN = MIA_IN * BUDGET / ASK, LEFT = MIA_IN - TAKEN, LEFT_ASK = ASK - BUDGET, NEW_ASK = 50000000n;
const mia = async function mia(label, who) { return h.uint(await h.read(label, MIA, `(get-balance '${who})`)); };
async function main() {
  await h.setup({ offset: 50, extra: [STX_SEND] });
  await h.read('min-deposit 100k MIA', BOOK, '(get min-deposit (get-info))', `u${MIA_IN}`);
  const m0 = await mia('seller MIA before', SELLER);
  await h.call('seller places 100k MIA for 100 STX', SELLER, BOOK, 'place-offer', [Cl.uint(MIA_IN), Cl.uint(ASK)]);
  h.report.fixtures.push(`${FUNDER} sends ${BUDGET} uSTX to the book.`);
  await h.call('real holder sends 40 STX to the book', FUNDER, `${DEP}.${STX_SEND[0]}`, 'send', [Cl.uint(BUDGET), Cl.principal(BOOK)]);
  await h.call('partial cross-book', CALLER, BOOK, 'cross-book', [], `(ok (tuple (acquired u${TAKEN}) (spent u${BUDGET})))`);
  await h.read('offer left under min-deposit', BOOK, `(get-offer '${SELLER})`,
    function left(v) { return v.includes(`(amount u${LEFT})`) && v.includes(`(ustx u${LEFT_ASK})`); });
  h.check('leftover < 100k MIA', LEFT < MIA_IN, true);
  await h.call('change-offer none <lower ask> -> ok', SELLER, BOOK, 'change-offer', [Cl.none(), Cl.uint(NEW_ASK)], '(ok true)');
  await h.read('book shows the lower ask', BOOK, '(get-offer-book)',
    `(list (tuple (amount u${LEFT}) (owner ${SELLER}) (ustx u${NEW_ASK})))`);
  const ADD = 10000000000n; // 10k MIA: total 70k < 100k
  await h.call('change-offer (some 10k MIA) total < 100k -> (err u15005)', SELLER, BOOK, 'change-offer', [Cl.some(Cl.uint(ADD)), Cl.uint(NEW_ASK)], '(err u15005)');
  await h.read('book unchanged after the refused add', BOOK, '(get-offer-book)',
    `(list (tuple (amount u${LEFT}) (owner ${SELLER}) (ustx u${NEW_ASK})))`);
  const before = await mia('seller MIA before cancel', SELLER);
  h.check('seller MIA = start - 100k placed', before.toString(), (m0 - MIA_IN).toString());
  await h.call('cancel-offer', SELLER, BOOK, 'cancel-offer', [], '(ok true)');
  h.check('cancel refunds the rest', (await mia('seller MIA after cancel', SELLER) - before).toString(), LEFT.toString());
  await h.read('book empty', BOOK, '(get-offer-count)', 'u0');
  h.check('book holds no MIA', (await mia('book MIA', BOOK)).toString(), '0');
  h.done();
}
main().catch(h.fail);
