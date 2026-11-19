// Bounty mw4761 #2: fund-from-treasury restarts the window, open OR already
// passed, when amount >= held (wallet + market-total) AND >= MIN_RESTART_SATS
// (u500000); the flag is can-open-window, the printed field stays `opened`.
// Mainnet fork, one fresh fork per scenario; model: stxer-ccip028-activation.mjs.
// Fixture: a real sBTC holder transfers each amount into the rewards treasury.
//   A. open window (ported from citycoins-protocol-ccip028-pr, 21/21): a 500-sat
//      seed opens it; 50k does not restart; a 10M batch one block before the end
//      restarts it; 200k into the 10M vault does not.
//   B. passed window: the 500-sat seed's window elapses with the seed still
//      there; a 10M batch restarts the clock (fresh batch-start, open 2 blocks on).
//   C. re-arm guard: a 100k batch's window passes with 100k left; 400k (>= held,
//      < 500k) and 1 sat do not restart; 600k (>= 500k, >= held) does.
//   D. 1M-sat vault: a 600k donation (>= 500k, < held) does not restart.
import { harness, TREASURY, VAULT, CALLER } from './_ccip028-fork.mjs';

const h = harness(process.env.SIM_RESULTS_DIR || 'simulations/results/ccd016-window-restart');
const opened = function opened(want) { return function o(v) { return v.startsWith('(ok') && v.includes(`(opened ${want})`); }; };
const start = async function start(label) { return h.read(label, VAULT, '(get batch-start (get-clock))'); };
async function fresh(name) {
  console.log(`--- scenario ${name}`);
  await h.setup({ offset: 50 });
  h.check(`${name}: treasury empty at activation`, (await h.bal(`${name}: treasury sBTC`, TREASURY)).toString(), '0');
}
async function fund(label, sats, want) {
  await h.give(`${label}: ${sats} sats land in the treasury`, sats);
  return h.call(`${label}: fund-from-treasury opened ${want}`, CALLER, VAULT, 'fund-from-treasury', [], opened(want));
}
async function scenarioA() {
  await fresh('A');
  await fund('A seed', 500n, true);
  const h0 = await start('A batch-start H0');
  await h.advance('A +10', 10);
  await fund('A dust', 50000n, false);
  await h.read('A 50k did not move the clock', VAULT, '(get batch-start (get-clock))', h0);
  await h.advance('A +277', 277);
  await h.read('A window still open at H0+287', VAULT, '(window-open)', 'true');
  await fund('A real batch', 10000000n, true);
  const h1 = await start('A batch-start after the 10M batch');
  h.check('A clock restarted at the batch', h.uint(h1) > h.uint(h0), true);
  await h.advance('A +2', 2);
  await h.read('A 2 blocks later still in patience', VAULT, '(window-elapsed)', 'false');
  await fund('A prolong', 200000n, false);
  await h.read('A 200k did not move the clock', VAULT, '(get batch-start (get-clock))', h1);
}
async function scenarioB() {
  await fresh('B');
  await fund('B seed', 500n, true);
  const h0 = await start('B batch-start H0');
  const t = await h.advance('B +289 (window passes)', 289);
  await h.read('B window elapsed', VAULT, '(window-elapsed)', 'true');
  h.check('B seed still there (> 8 sats slack)', (await h.bal('B vault sBTC', VAULT)).toString(), '500');
  await fund('B real batch', 10000000n, true);
  const h1 = await start('B batch-start after the 10M batch');
  h.check('B fresh batch-start (later than H0)', h.uint(h1) > h.uint(h0), true);
  h.check('B batch-start >= burn height at the batch', h.uint(h1) >= BigInt(t.burn_height), true);
  await h.advance('B +2', 2);
  await h.read('B window open 2 blocks later', VAULT, '(window-open)', 'true');
  await h.read('B window not elapsed', VAULT, '(window-elapsed)', 'false');
}
async function scenarioC() {
  await fresh('C');
  await fund('C batch', 100000n, true);
  const h0 = await start('C batch-start H0');
  await h.advance('C +289 (window passes)', 289);
  await h.read('C window elapsed', VAULT, '(window-elapsed)', 'true');
  h.check('C real leftover 100k (> 8 sats)', (await h.bal('C vault sBTC', VAULT)).toString(), '100000');
  await fund('C 400k (>= held, < 500k)', 400000n, false);
  await h.read('C 400k did not move the clock', VAULT, '(get batch-start (get-clock))', h0);
  await h.read('C window still elapsed', VAULT, '(window-elapsed)', 'true');
  await fund('C 1 sat', 1n, false);
  await h.read('C 1 sat did not move the clock', VAULT, '(get batch-start (get-clock))', h0);
  await fund('C 600k (>= 500k, >= held 500001)', 600000n, true);
  const h1 = await start('C batch-start after 600k');
  h.check('C 600k restarted the clock', h.uint(h1) > h.uint(h0), true);
  await h.read('C window open again', VAULT, '(window-open)', 'true');
}
async function scenarioD() {
  await fresh('D');
  await fund('D 1M batch', 1000000n, true);
  const h0 = await start('D batch-start H0');
  await h.advance('D +10', 10);
  await fund('D 600k (>= 500k, < held 1M)', 600000n, false);
  await h.read('D 600k did not move the clock', VAULT, '(get batch-start (get-clock))', h0);
  h.check('D vault holds 1.6M', (await h.bal('D vault sBTC', VAULT)).toString(), '1600000');
}
async function main() {
  const only = process.env.SCENARIOS || 'ABCD';
  for (const [k, fn] of Object.entries({ A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD })) if (only.includes(k)) await fn();
  h.done();
}
main().catch(h.fail);
