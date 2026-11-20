// stxer-ccd016-v2-negatives.mjs
// Mainnet-fork negative paths of the ccd016 vault that the earlier sims never
// took (see TRACE-COVERAGE-ccd016-swap-vault-mia-v2.md): every step expects an
// EXACT error code and checks that no balance or position moved.
//
// Exact repository bytes (sha256 pinned in _jing-live-v6-5.mjs), deployed with
// the book and the ccip028 proposal from the real deployer. LIVE Jing market
// v6-5, unchanged; router v6 LIVE since block 9525511 (used as-is when the fork has it, code-equal to the jing
// repo bytes modulo comments; older forks deploy those bytes). DAO actions are test proposals signalled by
// three real ccd001-direct-execute approvers and executed by base-dao; no
// var-set, map-set or SetContractCode anywhere. Real sBTC holder transfers are
// the only funding fixture. Unsigned simulated senders; nothing is broadcast.
//
// A "bad" Lazer update is the real signed update truncated by 10 bytes: the
// oracle refuses the malformed payload cleanly with (err u2101). (A flipped
// signature byte also fails cleanly, but as u2104 or u2105 depending on the
// byte the recovery hits, so it is not a fixed expectation.)
// Proposals that pass a signed update are deployed mid-run with a fresh one.
//
// Ported 2026-11-18 to feat/ccd015-redemption-book (bounty mw4761 fixes; live
// v6-5 / v5-6). Arm labels (Lnnn) are the line numbers of the PR branch's
// 4688508 vault, kept for traceability with its TRACE-COVERAGE file. Under the
// new rules: the 100,000-sat top-up into a 500-sat open window is under
// MIN_RESTART_SATS (u500000), so it still joins (opened false); every
// router-swap gets a fresh update (age 0 on this lagging fork clock), so the
// u16048 stale gate never fires before the asserted error.
// Run from the repo root: node simulations/stxer-ccd016-v2-negatives.mjs
import fs from 'node:fs';
import { Cl, ClarityVersion, cvToString, deserializeCV, makeUnsignedContractDeploy, PostConditionMode } from '@stacks/transactions';
import { SimulationBuilder, getSimulationResult, getSimulationTip, submitSimulationSteps, callContract, getNonce, setSender } from 'stxer';
import { exactSources, liveJingHashes, routerDeploy, routerV6Note, VAULT_SHA, BOOK_SHA, lazerFeedTimes, SBTC_HOLDER } from './_jing-live-v6-5.mjs';
import { fetchLazerUpdateAny } from './_vault-lazer.mjs';
import { createHash } from 'node:crypto';

const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const DAO = 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH';
const BASE = `${DAO}.base-dao`, DIRECT = `${DAO}.ccd001-direct-execute`;
const TREASURY = `${DAO}.ccd002-treasury-mia-rewards-v3`;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const MARKET = `${DEP}.markets-sbtc-stx-jing-v6-5`;
const BOOK_NAME = 'ccd015-redemption-book-mia-stx', VAULT_NAME = 'ccd016-swap-vault-mia-v2', PROPOSAL_NAME = 'ccip028-activate-mia-fair-redemption';
const BOOK = `${DEP}.${BOOK_NAME}`, VAULT = `${DEP}.${VAULT_NAME}`, PROPOSAL = `${DEP}.${PROPOSAL_NAME}`;
const PROPOSAL_SHA = '8826bc5d6abe38b7509a6693c1157b3479ecd357c646dddae733d2369dff6130';
const APPROVERS = ['SP7DGES13508FHRWS1FB0J3SZA326FP6QRMB6JDE', 'SP3YYGCGX1B62CYAH4QX7PQE63YXG7RDTXD8BQHJQ', 'SPN4Y5QPGQA8882ZXW90ADC2DHYXMSTN8VAR8C3X'];
const STRANGER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const OUT = process.env.SIM_RESULTS_DIR || 'simulations/results/coverage-negatives';
fs.mkdirSync(OUT, { recursive: true });
const report = { name: 'ccd016-v2-negatives', status: 'running', checks: [], arms: [], sourceHashes: {}, fixtures: [
  'Unsigned simulated senders; nothing is broadcast.',
  'Real sBTC holder transfers into the rewards treasury and (once) straight into the vault.',
  'DAO calls: test proposals signalled by three real ccd001-direct-execute approvers, executed by base-dao.',
  'Bad Lazer update: the real signed update truncated by 10 bytes (oracle (err u2101)).',
  '289 synthetic one-second burn blocks to elapse the 288-block window (as stxer-ccip028-activation.mjs).',
] };
let sid;
const save = () => { report.passed = report.checks.filter((c) => c.pass).length; report.total = report.checks.length; fs.writeFileSync(`${OUT}/ccd016-v2-negatives.json`, JSON.stringify(report, null, 2) + '\n'); };
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
const sbtcOf = (who) => `(unwrap-panic (contract-call? '${SBTC} get-balance '${who}))`;
// every balance and position a refused call must leave untouched
async function snapshot() {
  return read('', VAULT, `{ vault-sbtc: ${sbtcOf(VAULT)}, vault-stx: (stx-get-balance '${VAULT}), treasury-sbtc: ${sbtcOf(TREASURY)},
    book-stx: (stx-get-balance '${BOOK}), market-sbtc: ${sbtcOf(MARKET)},
    resting: (contract-call? '${MARKET} get-token-x-deposit (contract-call? '${MARKET} get-current-cycle) '${VAULT}),
    parked: (contract-call? '${MARKET} get-token-x-parked '${VAULT}),
    pending: (contract-call? '${MARKET} get-token-x-pending-deposit '${VAULT}),
    batch-start: (get batch-start (get-clock)), last-router-swap: (get last-router-swap (get-config)) }`);
}
// one refused call: exact error code, then nothing moved
async function refused(arm, label, run, code) {
  const before = await snapshot();
  await run(`${arm} ${label} -> ${code}`, code);
  check(`${arm} nothing moved`, await snapshot(), before);
  report.arms.push({ arm, label, code });
}
const truncate = (hex) => hex.slice(0, hex.length - 20);
async function fresh() {
  const stamp = Number(uint(await read('', MARKET, 'stacks-block-time')));
  for (let i = 0; i < 30; i++) {
    const p = await fetchLazerUpdateAny();
    if ((await lazerFeedTimes(p.hex)).at > stamp) return p.hex.replace(/^0x/, '');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('No signed price newer than the fork clock');
}
const proposalSource = (body) => `(impl-trait '${DAO}.proposal-trait.proposal-trait)
(define-public (execute (sender principal))
  (begin ${body} (ok true)))`;
async function deploy(name, source) {
  report.sourceHashes[name] = createHash('sha256').update(source).digest('hex');
  const raw = await makeUnsignedContractDeploy({ contractName: name, codeBody: source, clarityVersion: ClarityVersion.Clarity6, nonce: await getNonce(sid, DEP), network: 'mainnet', publicKey: '', fee: 0, postConditionMode: PostConditionMode.Allow });
  setSender(raw, DEP);
  const r = await submitSimulationSteps(sid, { steps: [{ Transaction: raw.serialize() }] });
  check(`deploy ${name}`, decode(r.steps[0]), (v) => v === 'true' || ok(v));
}
// three real approvers; the third signal executes (or reverts) the proposal
async function govern(name, last = '(ok u3)') {
  for (const [i, who] of APPROVERS.entries()) await call(`approver ${i + 1} signals ${name}`, who, DIRECT, 'direct-execute', [P(`${DEP}.${name}`)], i === 2 ? last : `(ok u${i + 1})`);
  if (last !== '(ok u3)') await read(`${name} reverted: not recorded as executed`, BASE, `(executed-at '${DEP}.${name})`, 'none');
}
let nProp = 0;
async function governFresh(body, last) { const name = `sim-neg-v-${++nProp}`; await deploy(name, proposalSource(body)); await govern(name, last); }

async function main() {
  const { vault, book } = exactSources();
  const proposalSrc = fs.readFileSync(`contracts/proposals/${PROPOSAL_NAME}.clar`, 'utf8');
  report.sourceHashes = { [VAULT_NAME]: VAULT_SHA, [BOOK_NAME]: BOOK_SHA, [PROPOSAL_NAME]: createHash('sha256').update(proposalSrc).digest('hex'), ...(await liveJingHashes(NODE)) };
  check('proposal source unchanged (sha256 pinned)', report.sourceHashes[PROPOSAL_NAME], PROPOSAL_SHA);
  const tip = (await (await fetch(`${NODE}/extended/v1/block?limit=1`)).json()).results[0];
  // as stxer-ccip028-activation.mjs: a parent 600 blocks back leaves room for
  // 289 one-second burn blocks without needing future signed prices
  const height = Number(process.env.SIM_BLOCK_HEIGHT || tip.height - 600);
  const statics = {
    'sim-neg-v-spread-51': `(try! (contract-call? '${VAULT} set-maker-spread-bps u51))`,
    'sim-neg-v-recall-empty': `(try! (contract-call? '${VAULT} dao-recall-sbtc))`,
    'sim-neg-v-trim-500': `(try! (contract-call? '${TREASURY} withdraw-ft '${SBTC} (- ${sbtcOf(TREASURY)} u500) '${SBTC_HOLDER}))`,
    'sim-neg-v-slippage-0': `(try! (contract-call? '${VAULT} set-slippage-bps u0)) (try! (contract-call? '${VAULT} set-no-pyth-slippage-bps u0))`,
    'sim-neg-v-dia-split': `(try! (contract-call? '${VAULT} router-swap-split-dia u1000000 u0 (list) u0 u1000000 u0 none))`,
    'sim-neg-v-band-1': `(try! (contract-call? '${VAULT} set-dia-band-bps u1))`,
  };
  // router v6 is LIVE from block 9525511: used as-is when the fork has it, else deployed first from the jing repo bytes as DEP
  const routerTx = routerDeploy(height);
  report.fixtures.push(routerV6Note(height)); console.log(`router: ${routerV6Note(height)}`);
  let b = SimulationBuilder.new({ stacksNodeAPI: NODE }).useBlockHeight(height).withSender(DEP);
  if (routerTx) b = b.addContractDeploy(routerTx);
  b = b
    .addContractDeploy({ contract_name: BOOK_NAME, source_code: book, clarity_version: 6 })
    .addContractDeploy({ contract_name: VAULT_NAME, source_code: vault, clarity_version: 6 })
    .addContractDeploy({ contract_name: PROPOSAL_NAME, source_code: proposalSrc, clarity_version: 6 });
  for (const [n, body] of Object.entries(statics)) b = b.addContractDeploy({ contract_name: n, source_code: proposalSource(body), clarity_version: 6 });
  sid = await b.run();
  report.simulationId = sid; report.url = `https://stxer.xyz/simulations/mainnet/${sid}`; report.forkHeight = height;
  console.log(report.url); save();
  const names = [...(routerTx ? ['swap-router-sbtc-stx-jing-v6'] : []), BOOK_NAME, VAULT_NAME, PROPOSAL_NAME, ...Object.keys(statics)];
  const steps = (await getSimulationResult(sid)).steps.filter((s) => s.Result?.Transaction);
  names.forEach((n, i) => check(`deploy ${n}`, decode(steps[i]), (v) => v === 'true' || ok(v)));
  report.initialTip = await getSimulationTip(sid);

  // ---- before activation ----
  const t0 = uint(await read('', VAULT, sbtcOf(TREASURY)));
  if (t0 < 1000n) await call('real sBTC holder tops the rewards treasury up to 1000 sats', SBTC_HOLDER, SBTC, 'transfer', [u(1000n - t0), P(SBTC_HOLDER), P(TREASURY), Cl.none()], '(ok true)');
  await read('vault not yet an extension', BASE, `(is-extension '${VAULT})`, 'false');
  await refused('L400', 'fund-from-treasury before activation: ccd002 withdraw-ft refuses a non-extension', (l, c) => call(l, STRANGER, VAULT, 'fund-from-treasury', [], c), '(err u2000)');
  const cfg0 = await read('', VAULT, '(get-config)');
  for (const [arm, fn, v] of [['L261', 'set-no-pyth-slippage-bps', 1], ['L287', 'set-maker-spread-bps', 1], ['L316', 'set-slippage-bps', 1], ['L324', 'set-max-chunk-sats', 1]])
    await refused(arm, `stranger ${fn}`, (l, c) => call(l, STRANGER, VAULT, fn, [u(v)], c), '(err u16000)');
  await read('setters by a stranger changed no config', VAULT, '(get-config)', cfg0);

  // ---- activation through the real Direct Execute path ----
  await govern(PROPOSAL_NAME);
  await read('vault enabled', BASE, `(is-extension '${VAULT})`, 'true');
  const cfg1 = await read('', VAULT, '(get-config)');
  await refused('L288', 'DAO set-maker-spread-bps u51 (MAX u50)', (l, c) => govern('sim-neg-v-spread-51', c), '(err u16033)');
  await read('maker spread unchanged at u1', VAULT, '(get maker-spread-bps (get-config))', 'u1');
  await read('vault empty', VAULT, '(is-empty)', 'true');
  await refused('L353', 'DAO dao-recall-sbtc on an empty vault', (l, c) => govern('sim-neg-v-recall-empty', c), '(err u16006)');

  // ---- a 500-sat batch: below the market's 1000-sat minimum ----
  if (uint(await read('', VAULT, sbtcOf(TREASURY))) > 500n) await govern('sim-neg-v-trim-500');
  await read('rewards treasury holds 500 sats', VAULT, sbtcOf(TREASURY), 'u500');
  await call('permissionless fund-from-treasury (500 sats)', STRANGER, VAULT, 'fund-from-treasury', [], ok);
  await read('vault 500 sats, window open', VAULT, `{ b: ${sbtcOf(VAULT)}, w: (window-open) }`, '(tuple (b u500) (w true))');
  const batchStart = await read('', VAULT, '(get batch-start (get-clock))');
  let hex = await fresh();
  await refused('L508', 'jing-place 500 sats: market min-token-x-deposit 1000', (l, c) => call(l, STRANGER, VAULT, 'jing-place', [Cl.bufferFromHex(hex)], c), '(err u1001)');
  await refused('L399', 'fund-from-treasury with an empty rewards treasury', (l, c) => call(l, STRANGER, VAULT, 'fund-from-treasury', [], c), '(err u16010)');
  await call('real sBTC holder sends 100000 sats to the rewards treasury', SBTC_HOLDER, SBTC, 'transfer', [u(100000), P(SBTC_HOLDER), P(TREASURY), Cl.none()], '(ok true)');
  await call('fund-from-treasury 100000 (< MIN_RESTART_SATS) joins the open batch', STRANGER, VAULT, 'fund-from-treasury', [], (v) => ok(v) && v.includes('(opened false)'));
  await read('vault 100500 sats, same batch clock', VAULT, `{ b: ${sbtcOf(VAULT)}, s: (get batch-start (get-clock)) }`, `(tuple (b u100500) (s ${batchStart}))`);

  // ---- bad signed update at each entry that prices before anything else ----
  hex = await fresh();
  const bad = Cl.bufferFromHex(truncate(hex));
  await refused('L501', 'jing-place with a tampered update', (l, c) => call(l, STRANGER, VAULT, 'jing-place', [bad], c), '(err u2101)');
  await refused('L534', 'jing-refloor with a tampered update', (l, c) => call(l, STRANGER, VAULT, 'jing-refloor', [bad], c), '(err u2101)');
  await refused('L682', 'router-swap-split with a tampered update', (l, c) => call(l, STRANGER, VAULT, 'router-swap-split', [u(100500), u(100500), u(0), Cl.list([]), u(0), u(0), u(0), bad, Cl.none()], c), '(err u2101)');
  await refused('L541', 'DAO jing-refloor with nothing resting', (l, c) => governFresh(`(try! (contract-call? '${VAULT} jing-refloor 0x${hex}))`, c), '(err u16034)');
  await refused('L694', 'DAO router-swap-split while the window is open', (l, c) => governFresh(`(try! (contract-call? '${VAULT} router-swap-split u1000 u1000 u0 (list) u0 u0 u0 0x${hex} none))`, c), '(err u16031)');

  // ---- place everything, elapse the window ----
  hex = await fresh();
  await call('permissionless jing-place (whole balance)', STRANGER, VAULT, 'jing-place', [Cl.bufferFromHex(hex)], ok);
  if (await read('', MARKET, `(is-some (get-token-x-pending-deposit '${VAULT}))`) === 'true')
    await call('keeper settles the vault deposit', DEP, MARKET, 'settle-token-x-deposit', [P(VAULT), Cl.bufferFromHex(hex), P(SBTC), Cl.stringAscii('sbtc-token')], ok);
  await read('vault wallet empty, 100500 resting', VAULT, `{ w: ${sbtcOf(VAULT)}, r: (get jing-resting (get-status)) }`, '(tuple (r u100500) (w u0))');
  const adv = await submitSimulationSteps(sid, { steps: [{ AdvanceBlocks: { bitcoin_blocks: 289, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: 1 } }] });
  if (adv.steps.some((s) => s.Result?.AdvanceBlocks?.Err)) throw new Error(JSON.stringify(adv));
  await read('window elapsed', VAULT, '(window-elapsed)', 'true');
  hex = await fresh();
  await refused('L623', 'router-swap with the wallet empty (all resting in Jing)', (l, c) => call(l, STRANGER, VAULT, 'router-swap', [Cl.bufferFromHex(hex)], c), '(err u16006)');
  await refused('L573', 'DAO jing-take with the wallet empty', (l, c) => governFresh(`(try! (contract-call? '${VAULT} jing-take u1000 0x${hex}))`, c), '(err u16006)');
  await call('real sBTC holder sends 30000 sats straight to the vault', SBTC_HOLDER, SBTC, 'transfer', [u(30000), P(SBTC_HOLDER), P(VAULT), Cl.none()], '(ok true)');
  hex = await fresh();
  await refused('L577', 'DAO jing-take while the vault rests in the market (u1018)', (l, c) => governFresh(`(try! (contract-call? '${VAULT} jing-take u30000 0x${hex}))`, c), '(err u1018)');
  await refused('L695', 'DAO router-swap-split above max-chunk-sats (1000000)', (l, c) => governFresh(`(try! (contract-call? '${VAULT} router-swap-split u1000001 u1000001 u0 (list) u0 u0 u0 0x${hex} none))`, c), '(err u16039)');
  await refused('L696', 'DAO router-swap-split above the wallet balance', (l, c) => governFresh(`(try! (contract-call? '${VAULT} router-swap-split u30001 u30001 u0 (list) u0 u0 u0 0x${hex} none))`, c), '(err u16006)');

  // ---- router legs that cannot meet a zero-slippage floor ----
  // One full chunk (1,000,000 sats, the launch max-chunk-sats) on the XYK leg
  // at a floor equal to the mid: the pool's price impact on that size puts the
  // leg under its min-out (probed on this fork: DLMM u2003, XYK u1020, Velar
  // u107 at that size, all at the mid and at the DIA mid; 30,000 sats still
  // clear above the mid). Slippage 0 is inside the setters' range.
  await govern('sim-neg-v-slippage-0');
  await read('slippage 0 and no-Pyth slippage 0', VAULT, '{ s: (get slippage-bps (get-config)), n: (get no-pyth-slippage-bps (get-config)) }', '(tuple (n u0) (s u0))');
  await call('real sBTC holder sends 970000 sats straight to the vault', SBTC_HOLDER, SBTC, 'transfer', [u(970000), P(SBTC_HOLDER), P(VAULT), Cl.none()], '(ok true)');
  await read('vault wallet = one full chunk', VAULT, sbtcOf(VAULT), 'u1000000');
  hex = await fresh();
  await refused('L702', 'DAO router-swap-split, one full chunk on XYK at the exact mid', (l, c) => governFresh(`(try! (contract-call? '${VAULT} router-swap-split u1000000 u0 u0 (list) u0 u1000000 u0 0x${hex} none))`, c), '(err u1020)');
  await refused('L756', 'DAO router-swap-split-dia, one full chunk on XYK at the exact DIA mid', (l, c) => govern('sim-neg-v-dia-split', c), '(err u1020)');

  // ---- DIA band 1 bp: the live Lazer mid sits outside it ----
  await govern('sim-neg-v-band-1');
  hex = await fresh();
  const dia = uint(await read('DIA mid', VAULT, '(unwrap-panic (get-dia-price))'));
  const lazer = uint(await read('Lazer mid (market verifies the same update)', MARKET, `(unwrap-panic (contract-call? '${MARKET} refresh-mid 0x${hex}))`));
  const arm = lazer < dia ? 'L1038' : 'L1041';
  report.diaSide = { dia: String(dia), lazer: String(lazer), arm };
  await refused(arm, `router-swap with the band at 1 bp (Lazer ${lazer < dia ? 'below' : 'above'} DIA)`, (l, c) => call(l, STRANGER, VAULT, 'router-swap', [Cl.bufferFromHex(hex)], c), '(err u16037)');
  await read('final vault status', VAULT, '(get-status)');
  report.status = 'passed'; save();
  console.log(`PASS ${report.passed}/${report.total}: ${report.url}`);
}
main().catch((e) => { report.status = 'failed'; report.error = e.stack || String(e); save(); console.error(e); process.exitCode = 1; });
