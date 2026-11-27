import {it,expect} from 'vitest';
import {boot,Cl,u,ok} from './lab';
const settings=[['set-window-blocks', 'window-blocks', 1008], ['set-leeway-bps', 'leeway-bps', 1000], ['set-slippage-bps', 'slippage-bps', 1000], ['set-max-chunk-sats', 'max-chunk-sats', 100000000], ['set-dia-band-bps', 'dia-band-bps', 5000], ['set-router-cooldown', 'router-cooldown-blocks', 144], ['set-pyth-fee-budget', 'pyth-fee-budget', 10000000], ['set-maker-spread-bps', 'maker-spread-bps', 50], ['set-no-pyth-slippage-bps', 'no-pyth-slippage-bps', 5000]] as const;
it.each(settings)('%s checks authority and upper bound',async(fn,key,cap)=>{
 // Arrange
 const {call,read,cp,outsider,admin}=await boot();
 const authority=admin;
 // Act
 const denied=call('vault',fn,[u(cap)],outsider);
 const accepted=call('vault',fn,[u(cap)],authority);
 const rejected=call('vault',fn,[u(cap+1)],authority);
 // Assert
 expect(denied.result).toEqual(Cl.error(u(16000)));
 ok(accepted); expect(rejected.result).toEqual(Cl.error(u(16033)));
 expect((read('vault','get-config') as any).value[key]).toEqual(u(cap));
});
it('patience phase refuses router sales; elapsed phase allows reclaim and sale',async()=>{
 // Arrange
 const {call,read,cp,fund,elapsed,balance,admin}=await boot();
 const authority=admin;
 fund(10000);
 // Act
 const early=call('vault','router-swap',[Cl.bufferFromHex('')]);
 const placed=call('vault','jing-place',[Cl.bufferFromHex('')]);
 const refloor=call('vault','jing-refloor',[Cl.bufferFromHex('')],authority);
 elapsed();
 const reclaimed=call('vault','jing-reclaim',[Cl.none()]);
 const sold=call('vault','router-swap',[Cl.bufferFromHex('')]);
 // Assert
 expect(early.result).toEqual(Cl.error(u(16031)));
 ok(placed);ok(refloor);ok(reclaimed);ok(sold);
 expect(balance(cp('vault'))).toBe(0n);
 expect(read('vault','is-empty')).toEqual(Cl.bool(true));
});
it('DIA failure uses the native fallback with half-price floor',async()=>{
 // Arrange
 const {call,read}=await boot();
 ok(call('oracle','set-failed',[Cl.bool(true)]));
 // Act
 const result=read('vault','get-no-pyth-price');
 // Assert
 expect(result).toEqual(Cl.ok(Cl.tuple({mid:u(10000000000),limit:u(5000000000),source:Cl.stringAscii('native'),'dia-error':Cl.some(u(16035))})));
});
it('fuel-fair-book preserves fee reserve and recall returns sBTC to the treasury',async()=>{
 // Arrange
 const {call,sim,admin,cp,fund,balance}=await boot();
 fund(10000);ok(sim.transferSTX(1000n,cp('vault'),admin));
 ok(call('vault','set-pyth-fee-budget',[u(123)]));
 // Act
 const fuel=call('vault','fuel-fair-book');
 const recall=call('vault','dao-recall-sbtc');
 // Assert
 ok(fuel);ok(recall);
 expect(sim.getAssetsMap().get('STX')!.get(cp('vault'))).toBe(123n);
 expect(balance(cp('treasury'))).toBe(10000n);
});

it.each([1000000,5000])('jing-take respects chunk sizing and clears the clock only when empty (cap %i)',async(cap)=>{
 // Arrange
 const {call,read,cp,admin,fund,elapsed,balance}=await boot();
 const authority=admin;
 fund(10000);elapsed();
 ok(call('vault','set-max-chunk-sats',[u(cap)],authority));
 // Act
 const result=call('vault','jing-take',[u(1000),Cl.bufferFromHex('')],authority);
 const clock=read('vault','get-clock') as any;
 // Assert
 const sold=cap===1000000?10000:1000;
 const value=ok(result) as any;
 expect(value.value.payload.value.amount).toEqual(u(sold));
 expect(value.value.payload.value.out).toEqual(u(sold));
 expect(balance(cp('vault'))).toBe(BigInt(10000-sold));
 expect(clock.value['batch-start'].type).toBe(sold===10000?'none':'some');
});
it('DAO reclaim recovers resting tokens during patience and status agrees',async()=>{
 // Arrange
 const {call,read,cp,fund,balance,outsider}=await boot();
 fund(10000);ok(call('vault','jing-place',[Cl.bufferFromHex('')]));
 // Act
 const denied=call('vault','dao-reclaim',[Cl.none()],outsider);
 const recovered=call('vault','dao-reclaim',[Cl.none()]);
 const status=read('vault','get-status') as any;
 // Assert
 expect(denied.result).toEqual(Cl.error(u(16000)));ok(recovered);
 expect(balance(cp('vault'))).toBe(10000n);
 expect(status.value['jing-resting']).toEqual(u(0));
});
