// Bounty mw4761 #3: router-swap rejects a Lazer update whose market taker
// rebate (markets-sbtc-stx-jing-v6-5 get-taker-rebate-bps-for) is above
// JING_BASE_REBATE_BPS u20, i.e. older than 30 s: (err u16048) ERR_STALE_UPDATE.
// After the window elapsed: fetch an update, move the fork clock to ~50 s
// after its publish time (under the market's 80 s max-staleness), router-swap
// -> (err u16048), vault unchanged; then a fresh update -> ok. Reports cost.
// Mainnet fork; model: stxer-ccip028-activation.mjs. Fixtures: a real sBTC
// holder funds the treasury; one synthetic burn block whose interval puts the
// fork clock 50 s past the signed update (no contract state is touched).
import { harness, Cl, VAULT, CALLER, MARKET, TREASURY } from './_ccip028-fork.mjs';

const h = harness(process.env.SIM_RESULTS_DIR || 'simulations/results/ccd016-router-stale');
const AGE = BigInt(process.env.STALE_AGE || 50);
const LIMITS = { runtime: 5e9, read_count: 15000, read_length: 1e8, write_count: 15000, write_length: 1.5e7 };
const now = async function now(label) { return h.uint(await h.read(label, VAULT, 'stacks-block-time')); };
const rebate = function rebate(label, u, expected) { return h.read(label, MARKET, `(get-taker-rebate-bps-for 0x${u.hex})`, expected); };
async function main() {
  // ~80 Stacks blocks (~15 min) back: the fork clock lags real time by more than
  // the 289 s window, yet the jump to real time keeps DIA under MAX_DIA_AGE 7200 s
  await h.setup({ offset: Number(process.env.FORK_OFFSET || 80) });
  const t0 = await h.bal('treasury sBTC', TREASURY);
  if (t0 < 100000n) await h.give('top up treasury to 100k', 100000n - t0);
  await h.call('fund-from-treasury', CALLER, VAULT, 'fund-from-treasury', [], function o(v) { return v.includes('(opened true)'); });
  await h.advance('advance 289 burn blocks (window passes)', 289);
  await h.read('window elapsed', VAULT, '(window-elapsed)', 'true');
  const sats = await h.bal('vault sBTC before', VAULT);
  const last = await h.read('last-router-swap before', VAULT, '(get last-router-swap (get-config))');
  const max = await h.read('market max-staleness', MARKET, '(var-get max-staleness)').catch(function none() { return 'unreadable'; });
  h.report.marketMaxStaleness = max;

  // --- stale: clock moved to publish + AGE s
  const stale = await h.update('stale');
  const c0 = await now('fork clock before the jump');
  h.check('signed update newer than the fork clock', stale.seconds > c0, true);
  await h.advance(`one burn block, interval ${stale.seconds + AGE - c0} s`, 1, Number(stale.seconds + AGE - c0));
  const c1 = await now('fork clock after the jump');
  h.check(`update age ${AGE - 10n}..${AGE + 10n} s (< 80 s max-staleness)`, Number(c1 - stale.seconds), function aged(a) { return a > 30 && a < 80 && Math.abs(a - Number(AGE)) <= 10; });
  await rebate('market rebate for the stale update > 20 bps', stale, function above(v) { return h.uint(v) > 20n; });
  await h.read('vault DIA price still fresh at the jumped clock', VAULT, '(is-ok (get-dia-price))', 'true');
  await h.call('STALE: router-swap -> (err u16048)', CALLER, VAULT, 'router-swap', [stale.cv], '(err u16048)');
  h.check('STALE: vault sBTC unchanged', (await h.bal('vault sBTC after stale', VAULT)).toString(), sats.toString());
  await h.read('STALE: cooldown untouched', VAULT, '(get last-router-swap (get-config))', last);

  // --- fresh: wait for a signed update within a few seconds of the fork clock
  let fresh;
  for (let i = 0; i < 40; i++) {
    fresh = await h.update(`fresh try ${i}`);
    const clock = await now(`fork clock (fresh try ${i})`);
    if (fresh.seconds + 10n >= clock) break;
    await new Promise(function wait(r) { setTimeout(r, 3000); });
  }
  await rebate('market rebate for the fresh update = 20 bps', fresh, 'u20');
  const res = await h.call('FRESH: router-swap -> ok', CALLER, VAULT, 'router-swap', [fresh.cv]);
  const cost = res.receipt?.execution_cost;
  h.report.routerSwapCost = cost;
  if (cost) {
    h.report.routerSwapCostPctOfBlock = Object.fromEntries(Object.entries(LIMITS).map(function pct([k, lim]) { return [k, +(100 * cost[k] / lim).toFixed(3)]; }));
    console.log('router-swap execution cost', JSON.stringify(cost), '% of block', JSON.stringify(h.report.routerSwapCostPctOfBlock));
  }
  h.check('FRESH: vault sold (sBTC <= 8 sats left)', await h.bal('vault sBTC after fresh', VAULT) <= 8n, true);
  h.check('FRESH: vault holds STX proceeds', h.uint(await h.read('vault STX', VAULT, `(stx-get-balance '${VAULT})`)) > 0n, true);
  h.done();
}
main().catch(h.fail);
