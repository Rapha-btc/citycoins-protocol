// Shared mainnet-fork harness for the CCIP-028 / ccd015 / ccd016 sims (bounty mw4761).
// Same model as stxer-ccip028-activation.mjs: unsigned simulated senders, never
// broadcasts; book + vault + ccip028 deployed from exact repo bytes; CCIP-028
// enabled by 3 real approver signals on ccd001-direct-execute. No
// SetContractCode, no governance bypass, no var-set.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Cl, cvToString, deserializeCV } from '@stacks/transactions';
import { SimulationBuilder, getSimulationResult, getSimulationTip, submitSimulationSteps, callContract } from 'stxer';
import { ROUTER_V6, ROUTER_V6_ID, ROUTER_V6_FILE, ROUTER_V6_CLARITY, ROUTER_V6_LIVE, routerV6Source, routerV6LiveAt, routerV6Note } from './_router-v6.mjs';

export { ROUTER_V6_ID };

export { Cl };
export const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
export const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
export const DAO = 'SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH';
export const BASE = `${DAO}.base-dao`, DIRECT = `${DAO}.ccd001-direct-execute`;
export const TREASURY = `${DAO}.ccd002-treasury-mia-rewards-v3`;
export const MINING_TREASURY = `${DAO}.ccd002-treasury-mia-mining-v3`;
export const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
export const MIA = 'SP1H1733V5MZ3SZ9XRW9FKYGEZT0JDGEB8Y634C7R.miamicoin-token-v2';
export const MARKET = `${DEP}.markets-sbtc-stx-jing-v6-5`;
export const BOOK_NAME = 'ccd015-redemption-book-mia-stx', VAULT_NAME = 'ccd016-swap-vault-mia-v2';
export const PROPOSAL_NAME = 'ccip028-activate-mia-fair-redemption';
export const BOOK = `${DEP}.${BOOK_NAME}`, VAULT = `${DEP}.${VAULT_NAME}`, PROPOSAL = `${DEP}.${PROPOSAL_NAME}`;
export const APPROVERS = ['SP7DGES13508FHRWS1FB0J3SZA326FP6QRMB6JDE', 'SP3YYGCGX1B62CYAH4QX7PQE63YXG7RDTXD8BQHJQ',
  'SPN4Y5QPGQA8882ZXW90ADC2DHYXMSTN8VAR8C3X', 'SP2R0DQYR7XHD161SH2GK49QRP1YSV7HE9JSG7W6G', 'SP372JVX6EWE2M0XPA84MWZYRRG2M6CAC4VVC12V1'];
export const CALLER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
export const SBTC_HOLDER = 'SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2';
export const STX_HOLDER = process.env.STX_FUNDER || 'SP2XXSW2KPPTY7KJDYS9RQ868D7JH58QSZKK8KXAV';
export const SELLER = 'SP3HXJJMJQ06GNAZ8XWDN1QM48JEDC6PP6W3YZPZJ';
// Book pinned to 2440559 (bounty mw4761 fixes), vault to its router-v6 rebind (zest leg); override with BOOK_SHA256 / VAULT_SHA256 ('skip' disables).
export const PINS = {
  [BOOK_NAME]: process.env.BOOK_SHA256 || '8982d30e17db7f92cd8cdb902464d508aaa65ca389dac6bd0920a3e694c3f34a',
  [VAULT_NAME]: process.env.VAULT_SHA256 || '237e2f007825b40a1b6f62fab6aae0e154eb11f0d0ac026a53df5a7a830f8382',
};

export function harness(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const report = { status: 'running', checks: [], fixtures: [], sourceHashes: {}, receipts: [], updates: [] };
  const h = { report, sid: null };
  const save = h.save = function save() { fs.writeFileSync(`${outDir}/result.json`, JSON.stringify(report, null, 2) + '\n'); };
  const check = h.check = function check(label, actual, expected) {
    const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
    report.checks.push({ label, actual, expected: typeof expected === 'function' ? expected.toString() : expected, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: ${actual}`); save();
    if (!pass) throw new Error(`${label}: ${actual}`);
    return actual;
  };
  function decode(step) {
    const r = step?.Result ?? step;
    if (r?.Eval && 'Ok' in r.Eval) return cvToString(deserializeCV(r.Eval.Ok));
    if (r?.Transaction?.Ok && !r.Transaction.Ok.vm_error && !r.Transaction.Ok.post_condition_aborted)
      return cvToString(deserializeCV(r.Transaction.Ok.result));
    throw new Error(`Simulation engine: ${JSON.stringify(r)}`);
  }
  h.read = async function read(label, contract, code, expected) {
    const res = await submitSimulationSteps(h.sid, { steps: [{ Eval: [CALLER, '', contract, code] }] });
    report.receipts.push({ label, ...res });
    const value = decode(res.steps[0]);
    if (expected !== undefined) check(label, value, expected);
    else { console.log(`READ ${label}: ${value}`); save(); }
    return value;
  };
  h.call = async function call(label, sender, contract, functionName, functionArgs = [], expected = h.ok) {
    const result = await callContract(h.sid, { sender, contract, functionName, functionArgs, fee: 0 });
    report.receipts.push({ label, sender, contract, functionName, ...result });
    check(label, result.vmError || (result.pcAborted ? 'post-condition-aborted' : result.result), expected);
    return result;
  };
  h.ok = function ok(value) { return value.startsWith('(ok'); };
  h.uint = function uint(value) { const m = String(value).match(/u(\d+)/); if (!m) throw new Error(`Not uint: ${value}`); return BigInt(m[1]); };
  h.json = async function json(url, options) { const r = await fetch(url, options); if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`); return r.json(); };
  h.update = async function update(label) {
    // Public frontend access key; override with FAKTORY_API_KEY if rotated.
    const key = process.env.FAKTORY_API_KEY || 'jc_e4d2e10396eef95215a7afd492f42d743a3325739d29200c2a28b256f778be01';
    const { data } = await h.json('https://faktory-dao-backend.vercel.app/api/auction/pyth-lazer-update?pair=sbtc-stx', { headers: { 'x-api-key': key } });
    report.updates.push({ label, ...data }); save();
    return { hex: data.hex.replace(/^0x/, ''), cv: Cl.bufferFromHex(data.hex.replace(/^0x/, '')), seconds: BigInt(data.timestampUs) / 1000000n };
  };
  h.advance = async function advance(label, n, secs = 1) {
    const r = await submitSimulationSteps(h.sid, { steps: [{ AdvanceBlocks: { bitcoin_blocks: n, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: secs } }] });
    report.receipts.push({ label, ...r }); save();
    if (r.steps.some(function failed(s) { return s.Result?.AdvanceBlocks?.Err; })) throw new Error(JSON.stringify(r));
    return getSimulationTip(h.sid);
  };
  h.tip = function tip() { return getSimulationTip(h.sid); };
  h.bal = async function bal(label, who) { return h.uint(await h.read(label, SBTC, `(get-balance '${who})`)); };
  h.stx = async function stx(label, who) { return h.uint(await h.read(label, BOOK, `(stx-get-balance '${who})`)); };
  // real sBTC holder donates to the rewards treasury (a disclosed fixture)
  h.give = function give(label, sats) {
    return h.call(label, SBTC_HOLDER, SBTC, 'transfer', [Cl.uint(sats), Cl.principal(SBTC_HOLDER), Cl.principal(TREASURY), Cl.none()]);
  };
  h.signal3 = async function signal3(label, proposal) {
    for (const [i, who] of APPROVERS.slice(0, 3).entries())
      await h.call(`${label}: approver signal ${i + 1}`, who, DIRECT, 'direct-execute', [Cl.principal(proposal)], `(ok u${i + 1})`);
    await h.read(`${label}: executed`, BASE, `(executed-at '${proposal})`, function recorded(v) { return v.startsWith('(some u'); });
  };
  // deploy book + vault + ccip028 (+ extra contracts) and run CCIP-028
  h.setup = async function setup({ extra = [], offset = 600 } = {}) {
    const tip = (await h.json(`${NODE}/extended/v1/block?limit=1`)).results[0];
    // a parent older than real time (offset Stacks blocks) keeps live Lazer
    // updates newer than the fork clock even after synthetic burn blocks
    const height = Number(process.env.SIM_BLOCK_HEIGHT || tip.height - offset);
    report.parentHeight = height;
    report.fixtures.push('Unsigned simulated senders; nothing is broadcast.');
    const files = [[BOOK_NAME, `contracts/extensions/${BOOK_NAME}.clar`], [VAULT_NAME, `contracts/extensions/${VAULT_NAME}.clar`],
      [PROPOSAL_NAME, `contracts/proposals/${PROPOSAL_NAME}.clar`]];
    let builder = SimulationBuilder.new({ stacksNodeAPI: NODE }).useBlockHeight(height).withSender(DEP);
    // router v6 is LIVE since block 9525511: at or past it use the live router (code-equal check in
    // _router-v6.mjs); on an older parent deploy the deployed-commit bytes as its real deployer first
    const router = routerV6Source(); report.sourceHashes[ROUTER_V6_FILE] = router.sha;
    const routerLive = routerV6LiveAt(height);
    report.fixtures.push(routerV6Note(height));
    if (routerLive) report.sourceHashes[`${ROUTER_V6} (live, code-equal)`] = ROUTER_V6_LIVE.sha256;
    else builder = builder.addContractDeploy({ contract_name: ROUTER_V6, source_code: router.source, clarity_version: ROUTER_V6_CLARITY });
    for (const [name, file] of files) {
      const source = fs.readFileSync(file, 'utf8');
      const hash = createHash('sha256').update(source).digest('hex'); report.sourceHashes[file] = hash;
      if (PINS[name] && PINS[name] !== 'skip') check(`pinned ${file}`, hash, PINS[name]);
      if (name === VAULT_NAME) check('vault binds router v6', source.includes(`'${ROUTER_V6_ID})`), true);
      builder = builder.addContractDeploy({ contract_name: name, source_code: source, clarity_version: 6 });
    }
    for (const [name, source] of extra) builder = builder.addContractDeploy({ contract_name: name, source_code: source, clarity_version: 6 });
    h.sid = await builder.run(); report.simulationId = h.sid; report.url = `https://stxer.xyz/simulations/mainnet/${h.sid}`;
    (report.urls ||= []).push(report.url);
    console.log(report.url); save();
    const res = await getSimulationResult(h.sid);
    let n = 0;
    for (const step of res.steps) if (step.Result?.Transaction) check(`deploy #${n++}`, decode(step), function deployed(v) { return v === 'true' || v === '(ok true)'; });
    check(`deploy receipts (${routerLive ? '' : 'router v6 + '}book + vault + ccip028 + extra)`, n, (routerLive ? 3 : 4) + extra.length);
    await h.signal3('CCIP-028', PROPOSAL);
    await h.read('vault is an extension', BASE, `(is-extension '${VAULT})`, 'true');
    // ccip028 does not make the book an extension; its DAO calls run as tx-sender = base-dao
    await h.read('book is not an extension', BASE, `(is-extension '${BOOK})`, 'false');
  };
  h.done = function done() {
    report.status = 'passed'; save();
    const passed = report.checks.filter(function p(c) { return c.pass; }).length;
    console.log(`PASS ${passed}/${report.checks.length}: ${(report.urls || [report.url]).join(' ')}`);
  };
  h.fail = function fail(error) { report.status = 'failed'; report.error = error.stack || String(error); save(); console.error(error); process.exitCode = 1; };
  return h;
}

// fixture: lets a real holder make a plain STX transfer (tx-sender pays) from a contract-call step
export const STX_SEND = ['sim-stx-send', '(define-public (send (amount uint) (to principal)) (stx-transfer? amount tx-sender to))\n'];

// a proposal-trait contract whose execute runs `body` (Clarity expressions)
export function proposal(body) {
  return `(impl-trait '${DAO}.proposal-trait.proposal-trait)\n(define-public (execute (sender principal))\n  (begin\n${body.map(function line(l) { return `    (try! ${l})`; }).join('\n')}\n    (ok true)))\n`;
}
