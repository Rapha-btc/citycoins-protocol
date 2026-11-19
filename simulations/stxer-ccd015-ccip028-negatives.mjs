// stxer-ccd015-ccip028-negatives.mjs
// Mainnet-fork negative paths of the ccd015 book and the ccip028 proposal that
// the earlier sims never took (see TRACE-COVERAGE-ccd015-redemption-book-mia-stx.md
// and TRACE-COVERAGE-ccip028-activate-mia-fair-redemption.md). Every refused
// step expects an EXACT error code and checks that no balance, escrow, offer
// or DAO state moved.
//
// Exact repository bytes (sha256 pinned), deployed from the real deployer.
// DAO actions are test proposals signalled by three real ccd001-direct-execute
// approvers and executed by base-dao; no var-set, map-set or SetContractCode.
// Sellers are fresh addresses funded with real MIA from a real holder.
// Unsigned simulated senders; nothing is broadcast.
//
// Not reachable here (and why): update-par's ERR_PAR_CALCULATION arms (book
// L151 / L153, calculate-par's none arm L338, and the proposal's update-par
// failure L42) need an empty or dust MIA treasury. get-treasury-balance counts
// ccd002-treasury-mia-mining-v3 (0 STX) plus ccd014-pox5-staking-mia, whose
// ~10.2M STX is LOCKED in PoX until burn height 1,163,750; a DAO can neither
// withdraw locked STX nor unlock it early (pox-5 unstake ends the lock at a
// cycle boundary), and stxer cannot advance ~190k burn blocks.
//
// Ported 2026-11-18 to feat/ccd015-redemption-book. Arm labels (Lnnn) are the
// PR branch 4688508 line numbers. New on this branch: change-offer checks
// min-deposit only when MIA is added (H4), so repricing an offer under a raised
// min now passes and adding to it stays refused (u15005); dao-recall-stx (H5)
// refuses a non-DAO caller (u15000).
// Run from the repo root: node simulations/stxer-ccd015-ccip028-negatives.mjs
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Cl, cvToString, deserializeCV, getAddressFromPrivateKey } from '@stacks/transactions';
import { SimulationBuilder, getSimulationResult, submitSimulationSteps, callContract } from 'stxer';

const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const DAO = 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH';
const BASE = `${DAO}.base-dao`, DIRECT = `${DAO}.ccd001-direct-execute`;
const TREASURY = `${DAO}.ccd002-treasury-mia-rewards-v3`;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const MIA = 'SP1H1733V5MZ3SZ9XRW9FKYGEZT0JDGEB8Y634C7R.miamicoin-token-v2';
const BOOK_NAME = 'ccd015-redemption-book-mia-stx', VAULT_NAME = 'ccd016-swap-vault-mia-v2', PROPOSAL_NAME = 'ccip028-activate-mia-fair-redemption';
const BOOK = `${DEP}.${BOOK_NAME}`, VAULT = `${DEP}.${VAULT_NAME}`, PROPOSAL = `${DEP}.${PROPOSAL_NAME}`;
const SHA = {
  // feat/ccd015-redemption-book 2440559 (bounty mw4761 fixes); env-overridable
  [BOOK_NAME]: process.env.BOOK_SHA || '8982d30e17db7f92cd8cdb902464d508aaa65ca389dac6bd0920a3e694c3f34a',
  [VAULT_NAME]: process.env.VAULT_SHA || '9516a3afb21785fc4a8f9fb2a234284003b63c438d699d95a6d72750bcc49e05',
  [PROPOSAL_NAME]: process.env.PROPOSAL_SHA || '8826bc5d6abe38b7509a6693c1157b3479ecd357c646dddae733d2369dff6130',
};
const FILES = { [BOOK_NAME]: `contracts/extensions/${BOOK_NAME}.clar`, [VAULT_NAME]: `contracts/extensions/${VAULT_NAME}.clar`, [PROPOSAL_NAME]: `contracts/proposals/${PROPOSAL_NAME}.clar` };
const APPROVERS = ['SP7DGES13508FHRWS1FB0J3SZA326FP6QRMB6JDE', 'SP3YYGCGX1B62CYAH4QX7PQE63YXG7RDTXD8BQHJQ', 'SPN4Y5QPGQA8882ZXW90ADC2DHYXMSTN8VAR8C3X'];
const STRANGER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const MIA_HOLDER = 'SP3HXJJMJQ06GNAZ8XWDN1QM48JEDC6PP6W3YZPZJ'; // real MIA v2 holder (1.64B MIA)
const F1 = getAddressFromPrivateKey('a1'.repeat(32) + '01', 'mainnet'), F2 = getAddressFromPrivateKey('a2'.repeat(32) + '01', 'mainnet');
const PAR_SCALE = 100000000n, M = (n) => BigInt(n) * 1000000n;
const OUT = process.env.SIM_RESULTS_DIR || 'simulations/results/coverage-negatives';
fs.mkdirSync(OUT, { recursive: true });
const report = { name: 'ccd015-ccip028-negatives', status: 'running', checks: [], arms: [], sourceHashes: {}, notReachable: [
  { arms: 'book L151, L153, L338 (then); proposal L42', why: 'need an empty or dust MIA treasury; its STX (~10.2M) is locked in PoX in ccd014-pox5-staking-mia until burn 1,163,750 and get-treasury-balance counts locked STX' },
], fixtures: [
  'Unsigned simulated senders; nothing is broadcast.',
  'Two fresh seller addresses funded with 100,000 MIA each from a real MIA v2 holder.',
  'DAO calls: test proposals signalled by three real ccd001-direct-execute approvers, executed by base-dao.',
] };
let sid;
const save = () => { report.passed = report.checks.filter((c) => c.pass).length; report.total = report.checks.length; fs.writeFileSync(`${OUT}/ccd015-ccip028-negatives.json`, JSON.stringify(report, null, 2) + '\n'); };
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? !!expected(actual) : actual === expected;
  report.checks.push({ label, actual: String(actual), expected: typeof expected === 'function' ? expected.toString() : String(expected), pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${report.checks.length}] ${label}: ${String(actual).slice(0, 300)}`); save();
  if (!pass) throw new Error(`${label}: ${actual} expected ${expected} (https://stxer.xyz/simulations/mainnet/${sid})`);
  return actual;
}
function decode(step) {
  const r = step?.Result ?? step;
  if (r?.Eval && 'Ok' in r.Eval) return cvToString(deserializeCV(r.Eval.Ok));
  if (r?.Transaction?.Ok && !r.Transaction.Ok.vm_error && !r.Transaction.Ok.post_condition_aborted) return cvToString(deserializeCV(r.Transaction.Ok.result));
  throw new Error(`Simulation engine: ${JSON.stringify(r).slice(0, 400)}`);
}
async function read(label, contract, code, expected) {
  const res = await submitSimulationSteps(sid, { steps: [{ Eval: [STRANGER, '', contract, code] }] });
  const v = decode(res.steps[0]);
  if (expected !== undefined) check(label, v, expected);
  return v;
}
const ok = (v) => String(v).startsWith('(ok');
async function call(label, sender, contract, fn, args = [], expected = ok) {
  const r = await callContract(sid, { sender, contract, functionName: fn, functionArgs: args, fee: 0 });
  return check(label, r.vmError || (r.pcAborted ? 'post-condition-aborted' : r.result), expected);
}
const uint = (v) => { const m = String(v).match(/u(\d+)/); if (!m) throw new Error(`Not uint: ${v}`); return BigInt(m[1]); };
const P = Cl.principal, u = Cl.uint;
const miaOf = (who) => `(unwrap-panic (contract-call? '${MIA} get-balance '${who}))`;
// every balance, escrow, offer and DAO flag a refused call must leave untouched
const snapshot = () => read('', BOOK, `{ f1: ${miaOf(F1)}, f2: ${miaOf(F2)}, escrow: ${miaOf(BOOK)}, book-stx: (stx-get-balance '${BOOK}),
  offers: (get-offer-book), info: (get-info),
  vault-ext: (contract-call? '${BASE} is-extension '${VAULT}), sbtc-allowed: (contract-call? '${TREASURY} is-allowed '${SBTC}),
  executed: (contract-call? '${BASE} executed-at '${PROPOSAL}) }`);
async function refused(arm, label, run, code) {
  const before = await snapshot();
  await run(`${arm} ${label} -> ${code}`, code);
  check(`${arm} nothing moved`, await snapshot(), before);
  report.arms.push({ arm, label, code });
}
const proposalSource = (body) => `(impl-trait '${DAO}.proposal-trait.proposal-trait)
(define-public (execute (sender principal))
  (begin ${body} (ok true)))`;
async function govern(name, last = '(ok u3)') {
  for (const [i, who] of APPROVERS.entries()) await call(`approver ${i + 1} signals ${name}`, who, DIRECT, 'direct-execute', [P(`${DEP}.${name}`)], i === 2 ? last : `(ok u${i + 1})`);
  if (last !== '(ok u3)') await read(`${name} reverted: not recorded as executed`, BASE, `(executed-at '${DEP}.${name})`, 'none');
}

async function main() {
  const sources = {};
  for (const [n, f] of Object.entries(FILES)) {
    sources[n] = fs.readFileSync(f, 'utf8');
    report.sourceHashes[n] = createHash('sha256').update(sources[n]).digest('hex');
    check(`${n} source unchanged (sha256 pinned)`, report.sourceHashes[n], SHA[n]);
  }
  const tip = (await (await fetch(`${NODE}/extended/v1/block?limit=1`)).json()).results[0];
  const height = Number(process.env.SIM_BLOCK_HEIGHT || tip.height - 3);
  const statics = {
    'sim-neg-b-par-first': `(try! (contract-call? '${BOOK} update-par))`,
    'sim-neg-b-min-200k': `(try! (contract-call? '${BOOK} set-min-deposit u${M(200000)}))`,
  };
  let b = SimulationBuilder.new({ stacksNodeAPI: NODE }).useBlockHeight(height).withSender(DEP);
  for (const n of [BOOK_NAME, VAULT_NAME, PROPOSAL_NAME]) b = b.addContractDeploy({ contract_name: n, source_code: sources[n], clarity_version: 6 });
  for (const [n, body] of Object.entries(statics)) b = b.addContractDeploy({ contract_name: n, source_code: proposalSource(body), clarity_version: 6 });
  sid = await b.run();
  report.simulationId = sid; report.url = `https://stxer.xyz/simulations/mainnet/${sid}`; report.forkHeight = height;
  console.log(report.url); save();
  const names = [BOOK_NAME, VAULT_NAME, PROPOSAL_NAME, ...Object.keys(statics)];
  const steps = (await getSimulationResult(sid)).steps.filter((s) => s.Result?.Transaction);
  names.forEach((n, i) => check(`deploy ${n}`, decode(steps[i]), (v) => v === 'true' || ok(v)));
  await read('Direct Execute enabled, not sunset', DIRECT, '(< block-height (var-get sunsetBlock))', 'true');
  await read('treasury really is locked PoX STX (why L151/L153/L338/L42 are out of reach)', BOOK, `{ mining: (stx-account 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.ccd002-treasury-mia-mining-v3), staking: (stx-account 'SPN4Y5QPGQA8882ZXW90ADC2DHYXMSTN8VAR8C3X.ccd014-pox5-staking-mia) }`,
    (v) => { report.treasuryAccounts = v; return /\(staking \(tuple \(locked u[1-9]\d{12,}\)/.test(v); });

  // ---- proposal: direct calls never initialize anything ----
  for (const [who, label] of [[STRANGER, 'stranger'], [DEP, 'deployer'], [APPROVERS[0], 'real approver']])
    await refused('L15', `${label} calls ccip028 execute directly`, (l, c) => call(l, who, PROPOSAL, 'execute', [P(who)], c), '(err u28000)');
  await read('par still unset', BOOK, '(get-par-scaled)', 'u0');

  // ---- proposal: par already committed by an earlier DAO action ----
  await govern('sim-neg-b-par-first');
  const par = uint(await read('par committed by the earlier proposal', BOOK, '(get-par-scaled)', (v) => uint(v) > 0n));
  await refused('L16', 'ccip028 through base-dao after par was set', (l, c) => govern(PROPOSAL_NAME, c), '(err u28001)');
  await read('vault still not an extension (sBTC was already allowlisted on mainnet; the snapshot shows it unchanged)', BASE, `{ v: (is-extension '${VAULT}), a: (contract-call? '${TREASURY} is-allowed '${SBTC}) }`, '(tuple (a true) (v false))');

  // ---- book: offers with real MIA ----
  const AMT = M(100000), ask = (amount) => ((amount * par) / PAR_SCALE) * 90n / 100n;
  for (const f of [F1, F2]) await call(`real MIA holder funds a fresh seller with 100000 MIA`, MIA_HOLDER, MIA, 'transfer', [u(AMT), P(MIA_HOLDER), P(f), Cl.none()], '(ok true)');
  await call('F1 offers 100000 MIA at 90% of par (only offer)', F1, BOOK, 'place-offer', [u(AMT), u(ask(AMT))], '(ok true)');
  const ask2 = ask(AMT) * 95n / 100n;
  await call('L226 F1 reprices the only offer: re-appended (not placed by insert-step)', F1, BOOK, 'change-offer', [Cl.none(), u(ask2)], '(ok true)');
  await read('L226 book = the one repriced F1 record', BOOK, '(get-offer-book)', `(list (tuple (amount u${AMT}) (owner ${F1}) (ustx u${ask2})))`);
  report.arms.push({ arm: 'L226', label: 'change-offer on the only offer (else arm: push-rec)', code: '(ok true)' });
  await refused('L223', 'F1 adds 1 micro-MIA it does not hold', (l, c) => call(l, F1, BOOK, 'change-offer', [Cl.some(u(1)), u(ask2)], c), '(err u1)');
  await refused('L179', 'F2 offers 150000 MIA holding 100000', (l, c) => call(l, F2, BOOK, 'place-offer', [u(M(150000)), u(ask(M(150000)))], c), '(err u1)');
  await govern('sim-neg-b-min-200k');
  await read('min-deposit raised to 200000 MIA', BOOK, '(get min-deposit (get-info))', `u${M(200000)}`);
  await call('H4 F1 reprices its 100000 MIA offer under the raised min (adds nothing): allowed', F1, BOOK, 'change-offer', [Cl.none(), u(ask(AMT))], '(ok true)');
  await read('H4 book = F1 at the new ask, amount unchanged', BOOK, '(get-offer-book)', `(list (tuple (amount u${AMT}) (owner ${F1}) (ustx u${ask(AMT)})))`);
  await refused('L219', 'F1 adds 1 micro-MIA, total still under the raised min', (l, c) => call(l, F1, BOOK, 'change-offer', [Cl.some(u(1)), u(ask(AMT))], c), '(err u15005)');
  for (const [who, label] of [[STRANGER, 'stranger'], [DEP, 'deployer'], [F1, 'seller']])
    await refused('H5', `${label} calls dao-recall-stx directly`, (l, c) => call(l, who, BOOK, 'dao-recall-stx', [], c), '(err u15000)');
  await call('F1 cancels and is refunded', F1, BOOK, 'cancel-offer', [], '(ok true)');
  await read('F1 holds its 100000 MIA again, book escrow empty', BOOK, `{ f1: ${miaOf(F1)}, escrow: ${miaOf(BOOK)} }`, `(tuple (escrow u0) (f1 u${AMT}))`);
  report.status = 'passed'; save();
  console.log(`PASS ${report.passed}/${report.total}: ${report.url}`);
}
main().catch((e) => { report.status = 'failed'; report.error = e.stack || String(e); save(); console.error(e); process.exitCode = 1; });
