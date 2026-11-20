import { test, expect } from 'vitest';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const VAULT = 'ccd016-swap-vault-mia-v2';
const UPDATE = Cl.buffer(new Uint8Array());
const MID = 32_000_000_000_000n;

function ok(receipt: any) {
  expect(cvToString(receipt.result)).toMatch(/^\(ok /);
  return receipt.result.value;
}

async function setup() {
  const sim = await initSimnet('tests/vault/.build/Clarinet.toml', true);
  const accounts = sim.getAccounts();
  const dao = accounts.get('deployer')!;
  const caller = accounts.get('wallet_1')!;
  const maker = accounts.get('wallet_2')!;
  function cp(name: string) { return Cl.contractPrincipal(dao, name); }
  function principal(name: string) { return `${dao}.${name}`; }
  function call(name: string, fn: string, args: any[] = [], sender = caller) {
    return sim.callPublicFn(name, fn, args, sender);
  }
  function vault(fn: string, args: any[] = [], sender = caller) { return call(VAULT, fn, args, sender); }
  function read(name: string, fn: string, args: any[] = []) {
    return sim.callReadOnlyFn(name, fn, args, caller).result as any;
  }
  function clock() { return read(VAULT, 'get-clock').value; }
  function status() { return read(VAULT, 'get-status').value; }
  function fund(amount: bigint) {
    ok(call('mock-ft', 'mint', [Cl.uint(amount), cp('mock-treasury')]));
    return vault('fund-from-treasury');
  }
  function ft(name: string) { return read('mock-ft', 'get-balance', [cp(name)]).value.value; }
  function stx(name: string) { return sim.getAssetsMap().get('STX')?.get(principal(name)) ?? 0n; }
  function snapshot() {
    return {
      status: read(VAULT, 'get-status'), clock: read(VAULT, 'get-clock'), config: read(VAULT, 'get-config'),
      routerSbtc: ft('mock-router'), routerStx: stx('mock-router'), callerStx: sim.getAssetsMap().get('STX')?.get(caller),
    };
  }
  ok(call('mock-base-dao', 'set-extension', [Cl.principal(dao), Cl.bool(true)], dao));
  return { sim, dao, caller, maker, cp, principal, call, vault, read, clock, status, fund, ft, stx, snapshot };
}

type World = Awaited<ReturnType<typeof setup>>;

function expectFunding(w: World, receipt: any, amount: bigint, opened: boolean) {
  const value = ok(receipt);
  expect(value.value.notification).toEqual(Cl.stringAscii('fund-from-treasury'));
  expect(value.value.payload.value.amount).toEqual(Cl.uint(amount));
  expect(value.value.payload.value.opened).toEqual(Cl.bool(opened));
  expect(value.value.payload.value).not.toHaveProperty('can-open-window');
  expect(w.ft('mock-treasury')).toBe(0n);
  // The public print retains `opened`; the private flag rename is not an API change.
  const event = receipt.events.find(function fundingPrint(event: any) {
    return event.event === 'print_event' && event.data.contract_identifier === w.principal(VAULT);
  });
  expect(event?.data.value).toEqual(value);
}

function expectRestart(w: World, previous: bigint) {
  const clock = w.clock();
  const start = clock['batch-start'].value.value;
  expect(start).toBeGreaterThan(previous);
  expect(clock['batch-start']).toEqual(Cl.some(clock['burn-height']));
  expect(clock['window-ends']).toEqual(Cl.some(Cl.uint(start + 288n)));
  expect(clock['window-open']).toEqual(Cl.bool(true));
  expect(clock['window-elapsed']).toEqual(Cl.bool(false));
}

for (const elapsed of [false, true]) {
  test(`mw4761 dust seed then 10M restarts the ${elapsed ? 'passed' : 'open'} window`, async function () {
    // Arrange: 500 sats is over router dust and cannot sell through the normal minimum.
    const w = await setup();
    expectFunding(w, w.fund(500n), 500n, true);
    const previous = w.clock()['batch-start'].value.value;
    w.sim.mineEmptyBurnBlocks(elapsed ? 289 : 100);
    expect(w.clock()['window-elapsed']).toEqual(Cl.bool(elapsed));
    expect(w.ft(VAULT)).toBe(500n);

    // Act.
    const receipt = w.fund(10_000_000n);

    // Assert: a full new 288-block patience period, with no seed sold or lost.
    expectFunding(w, receipt, 10_000_000n, true);
    expectRestart(w, previous);
    expect(w.ft(VAULT)).toBe(10_000_500n);
    expect(cvToString(w.vault('router-swap', [UPDATE]).result)).toBe('(err u16031)');
  });
}

for (const location of ['wallet', 'resting', 'parked']) {
  test(`mw4761 600k cannot restart 1M held in ${location}`, async function () {
    // Arrange: the restart compares against wallet plus all market holdings.
    const w = await setup();
    expectFunding(w, w.fund(1_000_000n), 1_000_000n, true);
    if (location !== 'wallet') ok(w.vault('jing-place', [UPDATE]));
    if (location === 'parked') ok(w.call('v6-market', 'test-park', [w.cp(VAULT)]));
    const field = location === 'wallet' ? 'sbtc-balance' : location === 'resting' ? 'jing-resting' : 'jing-parked';
    expect(w.status()[field]).toEqual(Cl.uint(1_000_000n));
    const previous = w.clock()['batch-start'];
    w.sim.mineEmptyBurnBlocks(100);

    // Act.
    const receipt = w.fund(600_000n);

    // Assert.
    expectFunding(w, receipt, 600_000n, false);
    expect(w.clock()['batch-start']).toEqual(previous);
    expect(w.clock()['window-open']).toEqual(Cl.bool(true));
    expect(w.ft(VAULT)).toBe(location === 'wallet' ? 1_600_000n : 600_000n);
    if (location !== 'wallet') expect(w.status()[field]).toEqual(Cl.uint(1_000_000n));
  });
}

test('mw4761 restart threshold includes the sum of liquid and market funds', async function () {
  // Arrange: 1M incoming exceeds each location, but not the 1.1M total.
  const w = await setup();
  ok(w.fund(1_000_000n));
  ok(w.vault('jing-place', [UPDATE]));
  ok(w.call('mock-ft', 'mint', [Cl.uint(100_000), w.cp(VAULT)]));
  const previous = w.clock()['batch-start'];
  w.sim.mineEmptyBurnBlocks(289);
  expect(w.status()['jing-resting']).toEqual(Cl.uint(1_000_000));

  // Act.
  const receipt = w.fund(1_000_000n);

  // Assert: even a passed window does not restart when the total-held test fails.
  expectFunding(w, receipt, 1_000_000n, false);
  expect(w.clock()['batch-start']).toEqual(previous);
  expect(w.clock()['window-elapsed']).toEqual(Cl.bool(true));
  expect(w.ft(VAULT)).toBe(1_100_000n);
});

test('mw4761 pending escrow counts toward held, including at the equality boundary', async function () {
  // Arrange: actual tokens back both the wallet and the pending-escrow record.
  const w = await setup();
  ok(w.fund(100_000n));
  ok(w.call('mock-ft', 'mint', [Cl.uint(1_000_000), Cl.principal(w.dao)]));
  ok(w.call('v6-market', 'test-fund-pending', [w.cp(VAULT), Cl.uint(1_000_000)], w.dao));
  expect(w.status()['jing-escrowed']).toEqual(Cl.uint(1_000_000));
  expect(w.ft('v6-market')).toBe(1_000_000n);
  const previous = w.clock()['batch-start'].value.value;
  w.sim.mineEmptyBurnBlocks(289);

  // Act / assert: 1M beats the liquid balance but not the 1.1M combined holdings.
  expectFunding(w, w.fund(1_000_000n), 1_000_000n, false);
  expect(w.clock()['batch-start']).toEqual(Cl.some(Cl.uint(previous)));
  expect(w.clock()['window-elapsed']).toEqual(Cl.bool(true));
  expect(w.ft(VAULT)).toBe(1_100_000n);
  // Matching the new 2.1M total does restart, without moving escrow into the wallet.
  expectFunding(w, w.fund(2_100_000n), 2_100_000n, true);
  expectRestart(w, previous);
  expect(w.ft(VAULT)).toBe(3_200_000n);
  expect(w.status()['jing-escrowed']).toEqual(Cl.uint(1_000_000));
});

for (const elapsed of [false, true]) {
  for (const amount of [1n, 200_000n, 499_999n]) {
    test(`mw4761 ${amount} does not restart a ${elapsed ? 'passed' : 'open'} window with real leftovers`, async function () {
      // Arrange: no empty-vault, absent-clock, or <=8-sat elapsed exception applies.
      const w = await setup();
      ok(w.fund(500n));
      const previous = w.clock()['batch-start'];
      w.sim.mineEmptyBurnBlocks(elapsed ? 289 : 100);

      // Act.
      const receipt = w.fund(amount);

      // Assert: the funding itself succeeds; only re-arming is refused.
      expectFunding(w, receipt, amount, false);
      expect(w.ft(VAULT)).toBe(500n + amount);
      expect(w.clock()['batch-start']).toEqual(previous);
      expect(w.clock()['window-elapsed']).toEqual(Cl.bool(elapsed));
    });
  }
  test(`mw4761 exactly 500k matching held restarts the ${elapsed ? 'passed' : 'open'} window`, async function () {
    // Arrange.
    const w = await setup();
    ok(w.fund(500_000n));
    const previous = w.clock()['batch-start'].value.value;
    w.sim.mineEmptyBurnBlocks(elapsed ? 289 : 100);

    // Act.
    const receipt = w.fund(500_000n);

    // Assert: both >= comparisons are inclusive.
    expectFunding(w, receipt, 500_000n, true);
    expectRestart(w, previous);
    expect(w.ft(VAULT)).toBe(1_000_000n);
  });
}

for (const remaining of [8n, 9n]) {
  test(`mw4761 elapsed legacy dust boundary with ${remaining} sats and a 1-sat top-up`, async function () {
    // Arrange.
    const w = await setup();
    ok(w.fund(remaining));
    const previous = w.clock()['batch-start'].value.value;
    w.sim.mineEmptyBurnBlocks(289);

    // Act.
    const receipt = w.fund(1n);

    // Assert: legacy <=8 rule still opens; 9 sats cannot be re-armed for 1 sat.
    expectFunding(w, receipt, 1n, remaining === 8n);
    expect(w.ft(VAULT)).toBe(remaining + 1n);
    if (remaining === 8n) expectRestart(w, previous);
    else {
      expect(w.clock()['batch-start']).toEqual(Cl.some(Cl.uint(previous)));
      expect(w.clock()['window-elapsed']).toEqual(Cl.bool(true));
    }
  });
}

for (const rebate of [21, 69, 70]) {
  test(`mw4761 router-swap rejects getter rebate ${rebate}, then accepts base 20`, async function () {
    // Arrange: the generated fixture encodes the getter result, not a signed Lazer payload.
    const w = await setup();
    ok(w.fund(100_000n));
    ok(w.sim.transferSTX(1_000_000_000n, w.principal('mock-router'), w.dao));
    w.sim.mineEmptyBurnBlocks(289);
    const stale = Cl.buffer(Uint8Array.of(rebate)), fresh = Cl.buffer(Uint8Array.of(20));
    expect(w.read('v6-market', 'get-taker-rebate-bps-for', [stale])).toEqual(Cl.uint(rebate));
    const before = w.snapshot();

    // Act.
    const refused = w.vault('router-swap', [stale]);

    // Assert: price refresh, tokens, and cooldown all roll back with the refusal.
    expect(cvToString(refused.result)).toBe('(err u16048)');
    expect(w.snapshot()).toEqual(before);
    expect(w.read('v6-market', 'get-taker-rebate-bps-for', [fresh])).toEqual(Cl.uint(20));
    ok(w.vault('router-swap', [fresh]));
    expect(w.ft(VAULT)).toBe(0n);
    expect(w.ft('mock-router')).toBe(100_000n);
    expect(w.stx(VAULT)).toBeGreaterThan(0n);
    expect(w.read(VAULT, 'get-config').value['last-router-swap']).not.toEqual(before.config.value['last-router-swap']);
  });
}

test('mw4761 DAO-only router-swap-split and jing-take still accept higher rebate updates', async function () {
  // Arrange: an executable market bid and router liquidity after the window.
  const w = await setup();
  ok(w.fund(100_000n));
  ok(w.sim.transferSTX(1_000_000_000n, w.principal('mock-router'), w.dao));
  ok(w.call('v6-market', 'deposit-token-y', [Cl.uint(500_000_000), Cl.uint(MID), Cl.none(), UPDATE, w.cp('mock-ft'), Cl.stringAscii('mock-ft')], w.maker));
  w.sim.mineEmptyBurnBlocks(289);
  const stale = Cl.buffer(Uint8Array.of(69));
  expect(w.read('v6-market', 'get-taker-rebate-bps-for', [stale])).toEqual(Cl.uint(69));
  const split = [Cl.uint(10_000), Cl.uint(0), Cl.uint(0), Cl.list([]), Cl.uint(10_000), Cl.uint(0), Cl.uint(0), stale];
  const take = [Cl.uint(10_000), stale];
  const before = w.snapshot();

  // Act / assert: ordinary callers stay unauthorized; governance retains its paths.
  expect(cvToString(w.vault('router-swap-split', split).result)).toBe('(err u16000)');
  expect(cvToString(w.vault('jing-take', take).result)).toBe('(err u16000)');
  expect(w.snapshot()).toEqual(before);
  ok(w.vault('router-swap-split', split, w.dao));
  expect(w.ft(VAULT)).toBe(90_000n);
  const stxBefore = w.stx(VAULT);
  const taken = ok(w.vault('jing-take', take, w.dao));
  // Existing sweep-amount behavior takes the entire balance below max-chunk.
  expect(taken.value.payload.value.amount).toEqual(Cl.uint(90_000));
  expect(w.ft(VAULT)).toBe(0n);
  expect(w.stx(VAULT)).toBeGreaterThan(stxBefore);
});

// Router v6 Zest leg: both splits forward `zest` in amm-amounts, its floor in
// amm-mins (floor-out of the same limit as dlmm / xyk), zest inside min-out,
// and the ticks as zest-route with price u0. The mock router records the call.
const LIMIT = (MID * 9_900n) / 10_000n; // floor-of: slippage-bps u100
const DIA_LIMIT = 28_800_000_000_000n; // get-no-pyth-price limit (no-pyth slippage u1000)
function floorOut(amount: bigint, limit: bigint) { return (amount * limit) / 10_000_000_000n; }
const TICKS = [Cl.int(-12), Cl.int(-13), Cl.int(-14)];

async function splitWorld() {
  const w = await setup();
  ok(w.fund(100_000n));
  ok(w.sim.transferSTX(1_000_000_000n, w.principal('mock-router'), w.dao));
  w.sim.mineEmptyBurnBlocks(289);
  return w;
}

function lastSplit(w: World) {
  const v = w.read('mock-router', 'get-last-split');
  expect(v.type).toBe('some');
  return v.value.value;
}

function expectForwarded(w: World, leg: Record<string, bigint>, mins: Record<string, bigint>, minOut: bigint, ticks: any[]) {
  const last = lastSplit(w);
  for (const k of ['zest', 'dlmm', 'xyk', 'velar']) {
    expect(last.amounts.value[k]).toEqual(Cl.uint(leg[k]));
    expect(last.mins.value[k]).toEqual(Cl.uint(mins[k]));
  }
  expect(last['min-out']).toEqual(Cl.uint(minOut));
  expect(last.route.value.ticks).toEqual(Cl.list(ticks));
  expect(last.route.value.price).toEqual(Cl.uint(0));
}

test('zest router-swap-split with zest u0 + empty ticks skips the leg', async function () {
  // Arrange.
  const w = await splitWorld();
  const args = [Cl.uint(10_000), Cl.uint(0), Cl.uint(0), Cl.list([]), Cl.uint(6_000), Cl.uint(4_000), Cl.uint(0), UPDATE];

  // Act.
  const value = ok(w.vault('router-swap-split', args, w.dao));

  // Assert.
  expect(value.value.payload.value.zest).toEqual(Cl.uint(0));
  expectForwarded(w, { zest: 0n, dlmm: 6_000n, xyk: 4_000n, velar: 0n },
    { zest: 0n, dlmm: floorOut(6_000n, LIMIT), xyk: floorOut(4_000n, LIMIT), velar: 0n },
    floorOut(10_000n, LIMIT), []);
  expect(w.ft(VAULT)).toBe(90_000n);
});

test('zest router-swap-split forwards a zest slice, its floor and the ticks', async function () {
  // Arrange.
  const w = await splitWorld();
  const args = [Cl.uint(10_000), Cl.uint(0), Cl.uint(4_000), Cl.list(TICKS), Cl.uint(3_000), Cl.uint(2_000), Cl.uint(1_000), UPDATE];
  const velarLimit = (MID * (10_000n - 60n)) / 10_000n;

  // Act.
  const value = ok(w.vault('router-swap-split', args, w.dao));

  // Assert: zest counts toward the sum and the Jing/AMM part of min-out.
  expect(value.value.payload.value.zest).toEqual(Cl.uint(4_000));
  expectForwarded(w, { zest: 4_000n, dlmm: 3_000n, xyk: 2_000n, velar: 1_000n },
    { zest: floorOut(4_000n, LIMIT), dlmm: floorOut(3_000n, LIMIT), xyk: floorOut(2_000n, LIMIT), velar: floorOut(1_000n, velarLimit) },
    floorOut(9_000n, LIMIT) + floorOut(1_000n, velarLimit), TICKS);
  expect(w.ft(VAULT)).toBe(90_000n);
});

test('zest router-swap-split counts zest in the split sum', async function () {
  // Arrange.
  const w = await splitWorld();
  const before = w.snapshot();

  // Act / assert: zest left out of amount, then zest alone over amount.
  expect(cvToString(w.vault('router-swap-split', [Cl.uint(10_000), Cl.uint(0), Cl.uint(1), Cl.list([]), Cl.uint(10_000), Cl.uint(0), Cl.uint(0), UPDATE], w.dao).result)).toBe('(err u16040)');
  expect(cvToString(w.vault('router-swap-split', [Cl.uint(10_000), Cl.uint(0), Cl.uint(10_001), Cl.list(TICKS), Cl.uint(0), Cl.uint(0), Cl.uint(0), UPDATE], w.dao).result)).toBe('(err u16040)');
  expect(cvToString(w.vault('router-swap-split', [Cl.uint(10_000), Cl.uint(0), Cl.uint(10_000), Cl.list(TICKS), Cl.uint(0), Cl.uint(0), Cl.uint(0), UPDATE]).result)).toBe('(err u16000)');
  expect(w.snapshot()).toEqual(before);
  ok(w.vault('router-swap-split', [Cl.uint(10_000), Cl.uint(0), Cl.uint(10_000), Cl.list(TICKS), Cl.uint(0), Cl.uint(0), Cl.uint(0), UPDATE], w.dao));
  expectForwarded(w, { zest: 10_000n, dlmm: 0n, xyk: 0n, velar: 0n },
    { zest: floorOut(10_000n, LIMIT), dlmm: 0n, xyk: 0n, velar: 0n }, floorOut(10_000n, LIMIT), TICKS);
});

test('zest router-swap-split-dia with zest u0 + empty ticks skips the leg', async function () {
  // Arrange.
  const w = await splitWorld();

  // Act.
  const value = ok(w.vault('router-swap-split-dia', [Cl.uint(10_000), Cl.uint(0), Cl.list([]), Cl.uint(10_000), Cl.uint(0), Cl.uint(0)], w.dao));

  // Assert.
  expect(value.value.payload.value.zest).toEqual(Cl.uint(0));
  expectForwarded(w, { zest: 0n, dlmm: 10_000n, xyk: 0n, velar: 0n },
    { zest: 0n, dlmm: floorOut(10_000n, DIA_LIMIT), xyk: 0n, velar: 0n }, floorOut(10_000n, DIA_LIMIT), []);
  expect(lastSplit(w).jing).toEqual(Cl.uint(0));
});

test('zest router-swap-split-dia forwards a zest slice, its floor and the ticks', async function () {
  // Arrange.
  const w = await splitWorld();
  const before = w.snapshot();

  // Act / assert: sum check includes zest.
  expect(cvToString(w.vault('router-swap-split-dia', [Cl.uint(10_000), Cl.uint(4_000), Cl.list(TICKS), Cl.uint(6_000), Cl.uint(1), Cl.uint(0)], w.dao).result)).toBe('(err u16040)');
  expect(cvToString(w.vault('router-swap-split-dia', [Cl.uint(10_000), Cl.uint(4_000), Cl.list(TICKS), Cl.uint(6_000), Cl.uint(0), Cl.uint(0)]).result)).toBe('(err u16000)');
  expect(w.snapshot()).toEqual(before);
  const value = ok(w.vault('router-swap-split-dia', [Cl.uint(10_000), Cl.uint(4_000), Cl.list(TICKS), Cl.uint(3_000), Cl.uint(2_000), Cl.uint(1_000)], w.dao));

  // Assert.
  expect(value.value.payload.value.zest).toEqual(Cl.uint(4_000));
  expectForwarded(w, { zest: 4_000n, dlmm: 3_000n, xyk: 2_000n, velar: 1_000n },
    { zest: floorOut(4_000n, DIA_LIMIT), dlmm: floorOut(3_000n, DIA_LIMIT), xyk: floorOut(2_000n, DIA_LIMIT), velar: floorOut(1_000n, DIA_LIMIT) },
    floorOut(10_000n, DIA_LIMIT), TICKS);
  expect(w.ft(VAULT)).toBe(90_000n);
});
