// stxer-ccd016-v2-pyth-fee.js
// SELF-VERIFYING stxer mainnet-fork harness for the ccd016-swap-vault-mia-v2
// Pyth Lazer fee budget (pyth-fee-budget + set-pyth-fee-budget).
//
// The live SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8.pyth-lazer-oracle charges
// `fee` uSTX from tx-sender on every verify-price-feeds; inside the vault's
// as-contract? tx-sender is the vault. Fork-only fixture: an Eval inside the
// oracle sets its fee var to u10 (governance's set-fee would do the same).
//
// Bounty mv7dfb (Super Orb): the vault pays both verifies (vault-mid's
// refresh-mid, then the market's swap). router-swap's stale-update guard
// (bounty mw4761 H3) only decodes the payload (get-taker-rebate-bps-for, no
// verify), so it adds no fee. The caller pays nothing: a fresh 0-STX account
// runs router-swap.
//
// 2026-11-18 port: on the LIVE Jing stack the vault binds
// (markets-sbtc-stx-jing-v6-5 + swap-router-sbtc-stx-jing-v5-6, real
// principals, live state); shared setup in simulations/_vault-live-v6-5.mjs.
// The book bid rests pegged at the mid (a fixed bid at any price would cross
// the live rung asks) and the keeper settles it.
// FIXTURES (disclosed): base-dao patched (SetContractCode) so is-extension is
// true for the vault and a proxy that plays a passed proposal; DIA pushed
// from its real updater key; the oracle fee var set by Eval (above).
//
// Covers:
//   setter: stranger u16000, max + 1 u16033, max ok, 0 ok, print, get-config
//   budget 0 + no vault STX: router-swap and jing-take abort with (err u1)
//   budget 0 + an STX float: both abort on vault-mid's STX allowance (err u0)
//   budget 9 = fee - 1: both abort on that allowance (err u0)
//   budget 20 = 2 x fee + float: router-swap fills through the book leg and
//     jing-take fills; each pays exactly two 10 uSTX fees from the vault
//   fuel-fair-book keeps the budget
//
// Run: node simulations/stxer-ccd016-v2-pyth-fee.js
import { uintCV, stringAsciiCV, noneCV, standardPrincipalCV, deserializeCV, cvToString, someCV, getAddressFromPrivateKey } from "@stacks/transactions";
import {
  liveSession, freshUpdate, patchedBaseDao, strip, assertVaultBindsLive, makeCheck, writeResult, diaPush, num, bare, field,
  DEP, MKT_ID, ROUTER_ID, SBTC, WSTX, P, STX_WHALE, SBTC_WHALE, STRANGER, DIA, DIA_UPDATER, REWARDS_TREASURY, BASE_DAO,
} from "./_vault-live-v6-5.mjs";
const DEPLOYER = DEP;
const EMPTY = getAddressFromPrivateKey("5".repeat(64) + "01", "mainnet"); // a fresh 0-STX account
const ORACLE = "SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8.pyth-lazer-oracle";
const BOOK = "ccd015-redemption-book-mia-stx", VAULT = "ccd016-swap-vault-mia-v2", PROXY = "sim-dao-proxy";
const VAULT_ID = `${DEPLOYER}.${VAULT}`, PROXY_ID = `${DEPLOYER}.${PROXY}`;
const sbtcT = P(SBTC), wstxT = P(WSTX);
const HUGE = 999_999_999_999_999n;
const FEE = 10n, PER_FILL = 2n * FEE, MAX_BUDGET = 10_000_000n; // MAX_PYTH_FEE_BUDGET = 10 STX
const FUND = 100_000n;
const DUMP = 20_000_000n; // a whale's router sale down to mid - 1%: the AMMs take nothing inside the vault's floor
const SLIPPAGE = 50n; // vault floor mid - 0.5%: only the book leg can fill
const BID_STX = 600_000_000n; // resting bid pegged at the mid, covers both sales
const FLOAT = 1_000_000n; // 1 STX the DAO leaves in the vault for fees
const PROXY_SRC = `
(define-public (is-dao-or-extension) (ok true))
(define-public (callback (sender principal) (memo (buff 34))) (ok true))
(define-public (allow-sbtc) (contract-call? '${REWARDS_TREASURY} set-allowed '${SBTC} true))
(define-public (set-window (blocks uint)) (contract-call? '${VAULT_ID} set-window-blocks blocks))
(define-public (set-slippage (bps uint)) (contract-call? '${VAULT_ID} set-slippage-bps bps))
(define-public (set-budget (ustx uint)) (contract-call? '${VAULT_ID} set-pyth-fee-budget ustx))
(define-public (take (requested uint) (update (buff 8192))) (contract-call? '${VAULT_ID} jing-take requested update))
`;
const eventsOf = (slot) => (slot?.receipt?.receipt?.events ?? []).map(e => typeof e === "string" ? JSON.parse(e) : e).filter(e => e.committed !== false);
const stxMoves = (evs) => evs.filter(e => e.type === "stx_transfer_event").map(e => ({ from: e.stx_transfer_event.sender, to: e.stx_transfer_event.recipient, amount: BigInt(e.stx_transfer_event.amount) }));
const printsOf = (evs, contract) => evs.filter(e => e.type === "contract_event" && e.contract_event?.topic === "print" && e.contract_event.contract_identifier === contract)
  .map(e => { try { return cvToString(deserializeCV(e.contract_event.raw_value)); } catch { return ""; } });
const st = makeCheck(), check = st.check;
async function main() {
  console.log("=== ccd016-swap-vault-mia-v2 PYTH FEE BUDGET on the live Jing v6-5 stack (mainnet fork) ===");
  const bookSrc = strip(`contracts/extensions/${BOOK}.clar`), vaultSrc = strip(`contracts/extensions/${VAULT}.clar`);
  assertVaultBindsLive(vaultSrc);
  for (const needle of ["(define-constant MAX_PYTH_FEE_BUDGET u10000000)", "(define-data-var pyth-fee-budget uint u0)", "(define-public (set-pyth-fee-budget"])
    if (!vaultSrc.includes(needle)) throw new Error(`vault source lacks ${needle}`);
  const S = await liveSession({ deploys: [[BOOK, bookSrc], [VAULT, vaultSrc], [PROXY, PROXY_SRC]], patches: [[BASE_DAO, await patchedBaseDao(VAULT_ID, PROXY_ID)]], check });
  const { tx, ev } = S;
  const lz = await freshUpdate(Number(S.tip0.block_time));
  const UPD = lz.cv, MID = lz.mid;
  console.log(`Lazer mid ${MID}; fork time ${S.tip0.block_time}; update at ${lz.at}`);
  const ok = (v) => String(v).startsWith("(ok");
  const any = () => true;
  const status = (label, want = any) => ev(label, VAULT_ID, "(get-status)", want);
  const config = (label, want = any) => ev(label, VAULT_ID, "(get-config)", want);
  const stxBal = (label, who, want = any) => ev(label, VAULT_ID, `(stx-get-balance '${who})`, want);
  const toTreasury = (label, amount) => tx(label, SBTC_WHALE, SBTC, "transfer", [uintCV(amount), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  const budget = (ustx, want = "(ok true)") => tx(`proxy set-pyth-fee-budget ${ustx}`, DEPLOYER, PROXY_ID, "set-budget", [uintCV(ustx)], want);
  const routerSwap = (label, want, sender = STRANGER) => tx(label, sender, VAULT_ID, "router-swap", [UPD], want);
  const jingTake = (label, want) => tx(label, DEPLOYER, PROXY_ID, "take", [uintCV(FUND), UPD], want);
  const stxTo = (label, sender, recipient, amount) => S.stxTo(label, sender, recipient, amount);
  const isErr = (v) => /^\(err u\d+\)$/.test(String(v));
  await tx("DIA: push the Lazer prices, fresh", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(lz.py, lz.px, BigInt(S.tip0.block_time) * 1000n)], "(ok true)");
  await tx("proxy allows sBTC on the treasury", DEPLOYER, PROXY_ID, "allow-sbtc", [], ok);
  await ev("live treasury holds no sBTC (amounts below are exact)", SBTC, `(get-balance '${REWARDS_TREASURY})`, "(ok u0)");

  // ---- setter: auth, bound, ok, print, get-config ----
  await config("S0 get-config: pyth-fee-budget defaults to u0", (v) => field(v, "pyth-fee-budget") === "u0");
  await tx("S1 stranger set-pyth-fee-budget 10 -> u16000", STRANGER, VAULT_ID, "set-pyth-fee-budget", [uintCV(10)], "(err u16000)");
  await budget(MAX_BUDGET + 1n, "(err u16033)");
  const setMax = await budget(MAX_BUDGET);
  await config("S2 get-config: pyth-fee-budget = 10 STX", (v) => field(v, "pyth-fee-budget") === `u${MAX_BUDGET}`);
  await budget(0n);
  await config("S3 get-config: pyth-fee-budget back to u0", (v) => field(v, "pyth-fee-budget") === "u0");

  // ---- fixture: the live oracle starts charging ----
  const fee0 = await ev("F0 live oracle fee on the fork (before)", ORACLE, "(var-get fee)", any);
  await ev("F1 fixture: Eval inside pyth-lazer-oracle sets fee u10", ORACLE, `(var-set fee u${FEE})`, any);
  await ev("F2 oracle get-fee = u10", ORACLE, "(get-fee)", `u${FEE}`);
  const recipient = await ev("F3 oracle fee recipient", ORACLE, "(get-fee-recipient)", any);

  // ---- a batch in liquidation, the AMMs below the floor, a bid on the book ----
  await toTreasury(`whale sends ${FUND} sats to the treasury`, FUND);
  await tx("proxy set-window-blocks 0: liquidation at once", DEPLOYER, PROXY_ID, "set-window", [uintCV(0)], "(ok true)");
  await tx(`proxy set-slippage-bps ${SLIPPAGE}: floor mid - 0.5%`, DEPLOYER, PROXY_ID, "set-slippage", [uintCV(SLIPPAGE)], "(ok true)");
  await tx("fund-from-treasury opens a batch", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND})`) && v.includes("(opened true)"));
  await tx(`fixture: an sBTC whale routes up to ${DUMP} sats down to mid - 1% (min-out 0)`, SBTC_WHALE, ROUTER_ID, "smart-swap-sbtc-for-stx", [uintCV(DUMP), uintCV((MID * 9900n) / 10000n), someCV(UPD), uintCV(MID), uintCV(0)], ok);
  await tx(`STX whale rests a ${BID_STX / 1_000_000n} STX bid pegged at the mid`, STX_WHALE, MKT_ID, "deposit-token-y", [uintCV(BID_STX), uintCV(HUGE), someCV(uintCV(0)), wstxT, stringAsciiCV("wstx")], `(ok u${BID_STX})`);
  await S.settleYIfPending("bid", STX_WHALE, UPD);
  await stxBal("vault STX = 0", VAULT_ID, "u0");

  // ---- budget 0, no STX in the vault ----
  const r0 = await routerSwap("A1 budget 0, vault STX 0: router-swap -> (err u1) (the vault cannot pay its refresh-mid fee)", "(err u1)");
  const t0 = await jingTake("A2 budget 0, vault STX 0: jing-take aborts", isErr);
  await status(`A3 vault still holds ${FUND} sats`, (v) => field(v, "sbtc-balance") === `u${FUND}`);

  // ---- budget 0 with a float: the allowance blocks the fee ----
  await stxTo(`DAO float: ${FLOAT} uSTX into the vault`, STX_WHALE, VAULT_ID, FLOAT);
  const r1 = await routerSwap("B1 budget 0, float: router-swap aborts on the as-contract? STX allowance", (v) => isErr(v) && v !== "(err u16047)");
  const t1 = await jingTake("B2 budget 0, float: jing-take aborts on the as-contract? STX allowance", isErr);
  await budget(FEE - 1n);
  const t2 = await jingTake(`B3 budget ${FEE - 1n} = fee - 1: jing-take aborts on vault-mid's allowance`, isErr);
  const r2 = await routerSwap(`B3b budget ${FEE - 1n} = fee - 1: router-swap aborts on vault-mid's allowance`, isErr);
  await status(`B4 vault still holds ${FUND} sats`, (v) => field(v, "sbtc-balance") === `u${FUND}`);
  await stxBal(`B5 vault STX still ${FLOAT}`, VAULT_ID, `u${FLOAT}`);

  // ---- budget >= fee: both paths work and pay exactly the fee ----
  await budget(PER_FILL);
  const fuel1 = await tx(`D1 budget ${PER_FILL}, float 1 STX: stranger fuel-fair-book sweeps all but the budget`, STRANGER, VAULT_ID, "fuel-fair-book", [], (v) => ok(v) && v.includes(`(amount u${FLOAT - PER_FILL})`));
  await stxBal(`D2 vault keeps exactly the ${PER_FILL} uSTX budget`, VAULT_ID, `u${PER_FILL}`);
  await tx("D3 balance = budget: fuel-fair-book -> u16006 (nothing above the reserve)", STRANGER, VAULT_ID, "fuel-fair-book", [], "(err u16006)");
  const sA = await stxBal("C0 vault STX before router-swap", VAULT_ID);
  const eA = await stxBal("E0 the fresh caller holds 0 STX", EMPTY, "u0");
  const rA = await routerSwap(`C1 budget ${PER_FILL} = 2 x fee: a 0-STX caller runs router-swap, it fills through the book leg`, (v) => ok(v) && v.includes(`(amount u${FUND})`), EMPTY);
  const sB = await stxBal("C2 vault STX after router-swap", VAULT_ID);
  await stxBal("E1 the caller still holds 0 STX: the vault paid both verifies", EMPTY, "u0");
  await status("C3 vault empty after the sale", (v) => field(v, "sbtc-balance") === "u0" && field(v, "empty") === "true");
  await toTreasury(`whale sends ${FUND} more sats to the treasury`, FUND);
  await tx("fund-from-treasury opens the next batch", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(opened true)"));
  await tx("D4 stranger fuel-fair-book sweeps the router-swap proceeds, keeps the budget", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);
  await stxBal(`D5 vault keeps exactly the ${PER_FILL} uSTX budget`, VAULT_ID, `u${PER_FILL}`);
  const sC = await stxBal("C4 vault STX before jing-take", VAULT_ID);
  const tA = await jingTake(`C5 budget ${PER_FILL} = 2 x fee: jing-take fills the bid`, (v) => ok(v) && v.includes(`(amount u${FUND})`));
  const sD = await stxBal("C6 vault STX after jing-take", VAULT_ID);
  await status("C7 vault sBTC 0 after the take", (v) => field(v, "sbtc-balance") === "u0");

  // ---- clean up ----
  await ev("fixture: oracle fee back to its live value", ORACLE, "(var-set fee u0)", any);
  await budget(0n);
  await tx("fuel-fair-book sweeps the float and proceeds", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);
  await stxBal("vault STX 0 after the sweep (the float goes with it)", VAULT_ID, "u0");

  const R = String(recipient.raw);
  console.log(`  ..   live fee before the fixture: ${fee0.raw}; recipient ${R}`);
  const setPrints = printsOf(eventsOf(setMax), VAULT_ID);
  check("S2 set-pyth-fee-budget printed its notification and value", setPrints.join(" | "), () => setPrints.some(x => x.includes('"set-pyth-fee-budget"') && x.includes(`(value u${MAX_BUDGET})`)));
  // A1 and A2: (err u1) is stx-transfer?'s insufficient-balance code from the
  // oracle (the vault's refresh-mid fee); B: (err u0) is vault-mid's
  // as-contract? violation index of its only slot, with-stx
  console.log(`  ..   A2 jing-take ${t0.raw}; B1 router-swap ${r1.raw}; B2 jing-take ${t1.raw}; B3 ${t2.raw}; B3b ${r2.raw}`);
  check("B1..B3b abort with vault-mid's with-stx allowance index (err u0)", [r1, t1, t2, r2].map(x => x.raw).join(" "), () => [r1, t1, t2, r2].every(x => x.raw === "(err u0)"));
  // C: each success pays exactly two FEEs from the vault to the oracle's
  // recipient (refresh-mid, then the market swap), and the caller pays none
  for (const [lbl, step, caller] of [["C1 router-swap", rA, EMPTY], ["C5 jing-take", tA, DEPLOYER]]) {
    const moves = stxMoves(eventsOf(step));
    const fees = moves.filter(m => m.from === VAULT_ID);
    check(`${lbl}: the vault's only STX outflows are two ${FEE} uSTX fees to the oracle fee recipient`, JSON.stringify(fees.map(m => ({ ...m, amount: String(m.amount) }))), () => fees.length === 2 && fees.every(m => m.amount === FEE && m.to === R));
    check(`${lbl}: the caller sent no STX`, moves.filter(m => m.from === caller).length, (n) => n === 0);
  }
  const rPrint = printsOf(eventsOf(rA), ROUTER_ID).find(x => x.includes("smart-swap-sbtc-for-stx")) || "";
  check("C1 the router's book leg filled (jing-ok true, jing-in > 0)", rPrint.slice(0, 300), () => rPrint.includes("(jing-ok true)") && num(rPrint, "jing-in") > 0n);
  // the router measures `out` as the vault's STX delta over its own call: net of
  // the market's verify inside it, not of current-mid's refresh-mid before it
  check("C1 router out = jing-out - 1 x fee (the market verify inside the router)", `out ${num(rPrint, "out")}, jing-out ${num(rPrint, "jing-out")}`, () => num(rPrint, "out") === num(rPrint, "jing-out") - FEE);
  check("C1 vault STX rose by out - 1 x fee (refresh-mid, outside the router)", `${bare(sA.raw)} -> ${bare(sB.raw)}, out ${num(rA.raw, "out")}`, () => bare(sB.raw) - bare(sA.raw) === num(rA.raw, "out") - FEE);
  check("C5 vault STX rose by out - 2 x fee", `${bare(sC.raw)} -> ${bare(sD.raw)}, out ${num(tA.raw, "out")}`, () => bare(sD.raw) - bare(sC.raw) === num(tA.raw, "out") - PER_FILL);
  const fuelMoves = stxMoves(eventsOf(fuel1));
  check("D1 the sweep moved exactly balance - budget to the book", JSON.stringify(fuelMoves.map(m => ({ ...m, amount: String(m.amount) }))), () => fuelMoves.length === 1 && fuelMoves[0].amount === FLOAT - PER_FILL && fuelMoves[0].to === `${DEPLOYER}.${BOOK}`);
  check(`C0 router-swap started from exactly the ${PER_FILL} uSTX reserve`, sA.raw, `u${PER_FILL}`);
  check(`C4 jing-take started from exactly the ${PER_FILL} uSTX reserve`, sC.raw, `u${PER_FILL}`);
  check("A1 router-swap moved no STX from the vault", stxMoves(eventsOf(r0)).filter(m => m.from === VAULT_ID).length, (n) => n === 0);

  writeResult("pyth-fee", st, S, { mid: String(MID) });
}
main().catch((e) => { console.error(e); process.exit(1); });
