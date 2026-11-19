// Runs on the LIVE Jing market v6-4 + router v5-5 at their mainnet principals
// (deployed bytes sha256-checked; nothing Jing is redeployed or aliased). The
// fork first empties the live book with real taker swaps and owner cancels
// (_jing-live-v6-4.mjs); the vault and book deploy from the exact repo bytes,
// sha256 pinned. Real signed Lazer update, fetched keylessly; synthetic burn
// blocks use one-second intervals. The vault pegs at mid + maker-spread-bps
// (default u1).
// stxer-ccd016-v2-fixes.js
// SELF-VERIFYING stxer mainnet-fork harness for the ccd016-swap-vault-mia-v2
// fixes from the v6-3 submit + settle audit bounty (jing-contracts-v3
// README-audit-bounty-v6-3-submit-settle.md):
//   Nested Quinn L-1  router-swap sells what fits inside the floor, keeps the
//                     rest, and reverts u16047 when 8 sats or less sold
//   Void Kael #7      close-batch cancels market dust (wallet + market <= 2)
//                     home first, so a sold-out batch closes at once
//   Void Kael #8      router-swap allowance = amount + min-x + 70 bps
//                     (measured on a book-leg sale)
//   L-2 does not apply to ccd016 (no timed recovery, keeps 1008): checked.
//
// 2026-11-18 port: on the LIVE Jing stack the vault binds
// (markets-sbtc-stx-jing-v6-5 + swap-router-sbtc-stx-jing-v5-6, real
// principals, live state); shared setup in simulations/_vault-live-v6-5.mjs.
// Live-book differences: the vault's peg asks mid + 1 bp (maker-spread-bps),
// so the exact-size takers buy at that price with limit mid + 1 bp (only the
// vault's ask, the live rung asks sit higher); bids rest pegged at the mid
// and the keeper settles pending deposits. Every update is fresh (age 0 on
// the fork), so router-swap's stale-update guard (u16048) passes.
// FIXTURES (disclosed, unchanged): base-dao patched (SetContractCode) so
// is-extension is true for the vault and a proxy that plays a passed
// proposal; DIA pushed from its real updater key with the Lazer prices.
//
// Run: node simulations/stxer-ccd016-v2-fixes.js
import fs from "node:fs";
import { uintCV, stringAsciiCV, falseCV, noneCV, standardPrincipalCV, deserializeCV, cvToString, someCV } from "@stacks/transactions";
import {
  liveSession, freshUpdate, patchedBaseDao, strip, sha, assertVaultBindsLive, makeCheck, writeResult, diaPush, num, bare, field,
  DEP, MKT_ID, ROUTER_ID, SBTC, WSTX, P, STX_WHALE, SBTC_WHALE, STRANGER, DIA, DIA_UPDATER, REWARDS_TREASURY, DAO, BASE_DAO,
} from "./_vault-live-v6-5.mjs";
const DEPLOYER = DEP;
const BOOK = "ccd015-redemption-book-mia-stx", VAULT = "ccd016-swap-vault-mia-v2", PROXY = "sim-dao-proxy";
const CORE_ID = `${DEPLOYER}.jing-core-v6`, BOOK_ID = `${DEPLOYER}.${BOOK}`, VAULT_ID = `${DEPLOYER}.${VAULT}`, PROXY_ID = `${DEPLOYER}.${PROXY}`;
const sbtcT = P(SBTC), wstxT = P(WSTX);
const PPDF = 10_000_000_000n, BPS = 10_000n, HUGE = 999_999_999_999_999n;
const MIN_X = 1000n, SLACK = 8n, REBATE_DUST = 51n, MAX_REBATE_BPS = 70n; // JING_REBATE_DUST_SATS, MAX_TAKER_REBATE_BPS
const FUND_A = 100_000n, FUND_B = 100_000n, FUND_C = 10_000_000n; // C: 0.1 BTC, more than the pools hold between mid - 0.5% and the 1% floor
const DUMP = 20_000_000n; // a whale's router sale down to mid - 0.5% before C
const LOW_BID_STX = 10_000_000n; // a resting bid at mid - 10%: never fills at the mid
const BID_STX = 300_000_000n; // the book bid that lets the next router-swap sell more
const floorOut = (sats, limit) => (sats * limit) / PPDF;
const PROXY_SRC = `
(define-public (is-dao-or-extension) (ok true))
(define-public (callback (sender principal) (memo (buff 34))) (ok true))
(define-public (allow-sbtc) (contract-call? '${REWARDS_TREASURY} set-allowed '${SBTC} true))
(define-public (set-window (blocks uint)) (contract-call? '${VAULT_ID} set-window-blocks blocks))
(define-public (recall) (contract-call? '${VAULT_ID} dao-recall-sbtc))
(define-public (set-chunk (sats uint)) (contract-call? '${VAULT_ID} set-max-chunk-sats sats))
`;
const eventsOf = (slot) => (slot?.receipt?.receipt?.events ?? []).map(e => typeof e === "string" ? JSON.parse(e) : e).filter(e => e.committed !== false);
const sbtcMoves = (evs) => evs.filter(e => e.type === "ft_transfer_event" && String(e.ft_transfer_event.asset_identifier).startsWith(SBTC))
  .map(e => ({ from: e.ft_transfer_event.sender, to: e.ft_transfer_event.recipient, amount: BigInt(e.ft_transfer_event.amount) }));
const stxMoves = (evs) => evs.filter(e => e.type === "stx_transfer_event").map(e => ({ from: e.stx_transfer_event.sender, to: e.stx_transfer_event.recipient, amount: BigInt(e.stx_transfer_event.amount) }));
const printsOf = (evs, contract) => evs.filter(e => e.type === "contract_event" && e.contract_event?.topic === "print" && e.contract_event.contract_identifier === contract)
  .map(e => { try { return cvToString(deserializeCV(e.contract_event.raw_value)); } catch { return ""; } });
const sum = (xs) => xs.reduce((a, m) => a + m.amount, 0n);
// the uSTX a Y taker must send so it buys exactly `target` sats at `price`
function takeFor(price, target) {
  const guess = (target * price * (BPS + 20n)) / PPDF / BPS;
  for (let t = guess - 5000n; t < guess + 5000n; t++) {
    const net = (t * BPS) / (BPS + 20n);
    if ((net * PPDF) / price === target) return t;
  }
  throw new Error(`no taker size buys exactly ${target} sats at ${price}`);
}
const st = makeCheck(), check = st.check;
async function main() {
  console.log("=== ccd016-swap-vault-mia-v2 FIXES on the live Jing v6-5 stack: L-1 partial router-swap / u16047, #7 market dust, #8 allowance ===");
  const bookSrc = strip(`contracts/extensions/${BOOK}.clar`), vaultSrc = strip(`contracts/extensions/${VAULT}.clar`);
  assertVaultBindsLive(vaultSrc);
  for (const needle of ["ROUTER_SLACK_SATS u8", "JING_REBATE_DUST_SATS u51", "MAX_TAKER_REBATE_BPS u70", "(define-private (market-total)", "MAX_WINDOW_BLOCKS u1008"])
    if (!vaultSrc.includes(needle)) throw new Error(`vault source lacks ${needle}`);
  const S = await liveSession({ deploys: [[BOOK, bookSrc], [VAULT, vaultSrc], [PROXY, PROXY_SRC]], patches: [[BASE_DAO, await patchedBaseDao(VAULT_ID, PROXY_ID)]], check });
  const { tx, ev, advance } = S;
  const lz = await freshUpdate(Number(S.tip0.block_time));
  const UPD = lz.cv, MID = lz.mid, ASK = (MID * (BPS + 1n)) / BPS;
  console.log(`Lazer mid ${MID}; fork time ${S.tip0.block_time}; update at ${lz.at}`);
  const TAKE_A = takeFor(ASK, FUND_A);
  const TAKE_B = takeFor(ASK, FUND_B + 1n);
  const ok = (v) => String(v).startsWith("(ok");
  const any = () => true;
  const status = (label, want) => ev(label, VAULT_ID, "(get-status)", want);
  const clock = (label, want) => ev(label, VAULT_ID, "(get-clock)", want);
  const config = (label, want = any) => ev(label, VAULT_ID, "(get-config)", want);
  const market = (label, want) => ev(label, VAULT_ID, `(let ((c (contract-call? '${MKT_ID} get-current-cycle))) { live: (contract-call? '${MKT_ID} get-token-x-deposit c current-contract), parked: (contract-call? '${MKT_ID} get-token-x-parked current-contract), pending: (default-to u0 (get amount (contract-call? '${MKT_ID} get-token-x-pending-deposit current-contract))) })`, want);
  const stxBal = (label, who, want = any) => ev(label, VAULT_ID, `(stx-get-balance '${who})`, want);
  const toTreasury = (label, amount) => tx(label, SBTC_WHALE, SBTC, "transfer", [uintCV(amount), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  const donate = (label, amount) => tx(label, SBTC_WHALE, SBTC, "transfer", [uintCV(amount), standardPrincipalCV(SBTC_WHALE), P(VAULT_ID), noneCV()], "(ok true)");
  const taker = (label, ustx) => tx(label, STX_WHALE, MKT_ID, "swap", [uintCV(ustx), uintCV(ASK), UPD, sbtcT, stringAsciiCV("sbtc-token"), wstxT, stringAsciiCV("wstx"), falseCV()], ok);
  await tx("DIA: push the Lazer prices, fresh", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(lz.py, lz.px, BigInt(S.tip0.block_time) * 1000n)], "(ok true)");
  await tx("proxy allows sBTC on the treasury", DEPLOYER, PROXY_ID, "allow-sbtc", [], ok);
  await ev("live treasury holds no sBTC (amounts below are exact)", SBTC, `(get-balance '${REWARDS_TREASURY})`, "(ok u0)");
  await ev("live Y side non-empty: the vault's places go to pending escrow", MKT_ID, "(> (len (get-token-y-depositors (get-current-cycle))) u0)", "true");

  // ---- L-2 does not apply: ccd016 keeps the 1008 cap ----
  await tx("L-2 n/a: set-window-blocks 1009 -> u16033 (ccd016 cap stays 1008)", DEPLOYER, PROXY_ID, "set-window", [uintCV(1009)], "(err u16033)");
  await tx("L-2 n/a: set-window-blocks 1008 -> ok", DEPLOYER, PROXY_ID, "set-window", [uintCV(1008)], "(ok true)");
  await tx("set-window-blocks back to the 288 default", DEPLOYER, PROXY_ID, "set-window", [uintCV(288)], "(ok true)");

  // ---- #7 A: the market's minimum is on the whole position, so a 1-sat place
  // only lands while the ask still rests; with a bid on the book it goes to
  // pending escrow, and the sell-out of the ask then leaves exactly that 1 sat
  // on the market (wallet 0): market dust that holds the batch open ----
  const LOW = (MID * 90n) / 100n;
  const lowBid = () => tx(`STRANGER rests a ${LOW_BID_STX / 1_000_000n} STX bid at mid - 10% (never fills at the mid)`, STRANGER, MKT_ID, "deposit-token-y", [uintCV(LOW_BID_STX), uintCV(LOW), noneCV(), wstxT, stringAsciiCV("wstx")], `(ok u${LOW_BID_STX})`);
  const settleVault = (label) => tx(label, STRANGER, MKT_ID, "settle-token-x-deposit", [P(VAULT_ID), UPD, sbtcT, stringAsciiCV("sbtc-token")], ok);
  await lowBid();
  await S.settleYIfPending("low bid", STRANGER, UPD);
  await toTreasury(`#7A whale sends ${FUND_A} sats to the treasury`, FUND_A);
  await tx("#7A fund-from-treasury opens a window", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND_A})`) && v.includes("(opened true)"));
  await tx("#7A stranger jing-place: the whole batch (escrowed: a bid rests)", STRANGER, VAULT_ID, "jing-place", [UPD], (v) => ok(v) && v.includes(`(amount u${FUND_A})`));
  await settleVault("#7A anyone settles the vault's escrow: the ask rests (no cross at mid - 10%)");
  await market(`#7A ${FUND_A} live, nothing pending`, (v) => field(v, "live") === `u${FUND_A}` && field(v, "pending") === "u0");
  await donate("#7A griefer donates 1 sat to the vault", 1n);
  const aPlace = await tx("#7A griefer jing-place: 1 sat, accepted as a top-up (whole position >= min), escrowed", STRANGER, VAULT_ID, "jing-place", [UPD], (v) => ok(v) && v.includes("(amount u1)"));
  await market("#7A 1 sat pending next to the live ask", (v) => field(v, "live") === `u${FUND_A}` && field(v, "pending") === "u1");
  const aStx0 = await stxBal("#7A vault STX before the fill", VAULT_ID);
  const aTake = await taker(`#7A taker sends ${TAKE_A} uSTX: buys exactly the ${FUND_A} live sats at mid + 1 bp (limit mid + 1 bp)`, TAKE_A);
  await market("#7A sold out: live 0, the 1 sat still pending on the market", (v) => field(v, "live") === "u0" && field(v, "parked") === "u0" && field(v, "pending") === "u1");
  await status("#7A wallet 0, NOT empty (market dust)", (v) => field(v, "sbtc-balance") === "u0" && field(v, "jing-escrowed") === "u1" && field(v, "empty") === "false");
  await clock("#7A window still open", (v) => field(v, "window-open") === "true");
  const aClose = await tx("#7A stranger close-batch: wallet + market = 1 <= 2, cancels the dust home and closes at once", STRANGER, VAULT_ID, "close-batch", [], (v) => ok(v) && v.includes("close-batch"));
  await market("#7A market position 0 after close-batch", (v) => field(v, "live") === "u0" && field(v, "parked") === "u0" && field(v, "pending") === "u0");
  await status("#7A wallet holds the 1 dust sat, empty", (v) => field(v, "sbtc-balance") === "u1" && field(v, "empty") === "true");
  await clock("#7A clock cleared although the window had not ended", (v) => field(v, "batch-start") === "none" && field(v, "window-open") === "false");
  await tx("#7A close-batch again -> u16032 (no clock)", STRANGER, VAULT_ID, "close-batch", [], "(err u16032)");
  const aStx1 = await stxBal("#7A vault STX after the fill", VAULT_ID);
  const bookA0 = await stxBal("#7A book STX before the flush", BOOK_ID);
  await tx("#7A fuel-fair-book: the sell-out STX goes to the book", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);
  const bookA1 = await stxBal("#7A book STX after the flush", BOOK_ID);

  // ---- #7 B: a real position (3 sats) is never cancelled by close-batch ----
  await toTreasury(`#7B whale sends ${FUND_B} sats to the treasury`, FUND_B);
  await tx("#7B fund-from-treasury: empty (1 dust) -> a new window opens", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND_B})`) && v.includes("(opened true)"));
  await tx(`#7B jing-place: ${FUND_B + 1n} (the batch plus the dust), escrowed`, STRANGER, VAULT_ID, "jing-place", [UPD], (v) => ok(v) && v.includes(`(amount u${FUND_B + 1n})`));
  await settleVault("#7B settle the escrow: the ask rests");
  await donate("#7B 3 sats donated", 3n);
  await tx("#7B jing-place: 3 sats escrowed", STRANGER, VAULT_ID, "jing-place", [UPD], (v) => ok(v) && v.includes("(amount u3)"));
  await taker(`#7B taker sends ${TAKE_B} uSTX: buys exactly the ${FUND_B + 1n} live sats`, TAKE_B);
  await market("#7B sold out, 3 sats pending", (v) => field(v, "live") === "u0" && field(v, "pending") === "u3");
  await tx("#7B close-batch: wallet 0 + market 3 > 2 -> u16043, nothing cancelled", STRANGER, VAULT_ID, "close-batch", [], "(err u16043)");
  await market("#7B the 3-sat escrow is untouched", (v) => field(v, "pending") === "u3");
  await tx("#7B proxy set-window-blocks 1", DEPLOYER, PROXY_ID, "set-window", [uintCV(1)], "(ok true)");
  await advance(2);
  await tx("#7B jing-reclaim after the window: the 3 sats come home", STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], (v) => ok(v) && v.includes("(amount u3)"));
  await status("#7B wallet 3, not empty", (v) => field(v, "sbtc-balance") === "u3" && field(v, "empty") === "false");
  await tx("#7B fuel-fair-book", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);
  await tx("STRANGER cancels the low bid (clean book for the router cases)", STRANGER, MKT_ID, "cancel-token-y-deposit", [wstxT, stringAsciiCV("wstx")], ok);

  // ---- L-1 small: a sale of 8 sats or less reverts u16047 and burns no cooldown ----
  const cfg0 = await config("L-1 config before the small sales (last-router-swap)");
  await tx("L-1 router-swap of the 3-sat wallet -> u16047 (sold <= 8)", STRANGER, VAULT_ID, "router-swap", [UPD], "(err u16047)");
  await status("L-1 the 3 sats stay", (v) => field(v, "sbtc-balance") === "u3");
  await toTreasury(`L-1 whale sends ${FUND_C} sats to the treasury`, FUND_C);
  // 8adfa68 (bounty mv7dfb, Calm Forge): the 3 sats left are unsellable dust (wallet + market
  // <= ROUTER_SLACK_SATS 8) on an elapsed window, so the new rewards open a FRESH window and
  // rest first; they no longer join the elapsed batch and get router-swapped at the floor at once
  await tx("L-1 fund-from-treasury: elapsed window on 3 dust sats -> a fresh window opens (8adfa68)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND_C})`) && v.includes("(opened true)"));
  await clock("L-1 the fresh window is open", (v) => field(v, "window-open") === "true");
  await tx("L-1 router-swap inside the fresh window -> u16031 (the rewards rest first)", STRANGER, VAULT_ID, "router-swap", [UPD], "(err u16031)");
  await advance(2);
  await clock("L-1 after 2 burn blocks the 1-block window elapsed", (v) => field(v, "window-open") === "false");
  await tx("L-1 proxy set-max-chunk-sats 8", DEPLOYER, PROXY_ID, "set-chunk", [uintCV(8)], "(ok true)");
  await tx("L-1 router-swap of one 8-sat chunk -> u16047 (8 sats sold at most)", STRANGER, VAULT_ID, "router-swap", [UPD], "(err u16047)");
  const cfg1 = await config("L-1 config after both refusals: last-router-swap unchanged");
  await status(`L-1 wallet still ${FUND_C + 3n}`, (v) => field(v, "sbtc-balance") === `u${FUND_C + 3n}`);
  await tx("L-1 proxy set-max-chunk-sats 1 BTC: the next sale is the whole balance", DEPLOYER, PROXY_ID, "set-chunk", [uintCV(100_000_000)], "(ok true)");

  // ---- L-1 partial: the pools take only part within the floor, the rest stays ----
  // the pools' depth inside the floor moves by the hour (52k sats to over 3M on one afternoon):
  // a whale first routes sBTC down to mid - 0.5%, so only the band from 0.5% to the vault's
  // 1% floor is left for the vault (a no-op when the pools already sit lower)
  await tx(`L-1 fixture: an sBTC whale routes up to ${DUMP} sats down to mid - 0.5% (min-out 0)`, SBTC_WHALE, ROUTER_ID, "smart-swap-sbtc-for-stx", [uintCV(DUMP), uintCV((MID * 9950n) / 10000n), someCV(UPD), uintCV(MID), uintCV(0)], ok);
  const c0 = await status("L-1 status before the partial sale", any);
  const cStx0 = await stxBal("L-1 vault STX before the partial sale", VAULT_ID);
  const p1 = await tx(`L-1 router-swap (same burn block; the refusals burned no cooldown): sells what the pools take inside the floor`, STRANGER, VAULT_ID, "router-swap", [UPD], (v) => ok(v) && v.includes(`(amount u${FUND_C + 3n})`));
  const c1 = await status("L-1 status after the partial sale", any);
  const cStx1 = await stxBal("L-1 vault STX after the partial sale", VAULT_ID);
  await tx("L-1 router-swap again in the same burn block -> u16044", STRANGER, VAULT_ID, "router-swap", [UPD], "(err u16044)");
  await advance(1);
  const p2 = await tx("L-1 next burn block, book empty: the pools are at the floor (observed; u16047 when <= 8 sats fit)", STRANGER, VAULT_ID, "router-swap", [UPD], any);
  const c2 = await status("L-1 status after the exhausted call", any);
  const LIMIT = (MID * (BPS - 100n)) / BPS;
  const probe = await tx("L-1 probe: an sBTC holder routes 1000 sats at the vault's floor, min-out 0 (same pool state)", SBTC_WHALE, ROUTER_ID, "smart-swap-sbtc-for-stx", [uintCV(1000), uintCV(LIMIT), someCV(UPD), uintCV(MID), uintCV(0)], any);
  await tx(`L-1 STX whale rests a ${BID_STX / 1_000_000n} STX bid pegged at the mid`, STX_WHALE, MKT_ID, "deposit-token-y", [uintCV(BID_STX), uintCV(HUGE), someCV(uintCV(0)), wstxT, stringAsciiCV("wstx")], `(ok u${BID_STX})`);
  await S.settleYIfPending("L-1 bid", STX_WHALE, UPD);
  const cStx2 = await stxBal("L-1 vault STX before the book-leg sale", VAULT_ID);
  const p3 = await tx("L-1 the next call sells more: the router's book leg takes the bid", STRANGER, VAULT_ID, "router-swap", [UPD], ok);
  const c3 = await status("L-1 status after the book-leg sale", any);
  const cStx3 = await stxBal("L-1 vault STX after the book-leg sale", VAULT_ID);

  // ---- clean up: recall the rest to the treasury, flush the STX ----
  await tx("proxy recall the unsold rest to the treasury", DEPLOYER, PROXY_ID, "recall", [], ok);
  await tx("fuel-fair-book", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);
  await status("empty again", (v) => field(v, "sbtc-balance") === "u0" && field(v, "stx-balance") === "u0" && field(v, "empty") === "true");

  // #7 A: exact balances and events
  const fillSbtc = sbtcMoves(eventsOf(aTake));
  check(`#7A the taker received ${FUND_A} sats less the 10 bps fee from the market`, sum(fillSbtc.filter(m => m.to === STX_WHALE)), (d) => d === FUND_A - FUND_A / 1000n);
  const closeEv = eventsOf(aClose), closeSbtc = sbtcMoves(closeEv);
  check("#7A close-batch moved exactly 1 sat market -> vault and nothing else", JSON.stringify(closeSbtc.map(m => ({ ...m, amount: String(m.amount) }))), () => closeSbtc.length === 1 && closeSbtc[0].from === MKT_ID && closeSbtc[0].to === VAULT_ID && closeSbtc[0].amount === 1n);
  const closePrints = printsOf(closeEv, VAULT_ID);
  check("#7A close-batch printed jing-reclaim (amount u1) then close-batch", closePrints.join(" | "), () => closePrints.length === 2 && closePrints[0].includes('"jing-reclaim"') && closePrints[0].includes("(amount u1)") && closePrints[1].includes('"close-batch"'));
  const corePrints = printsOf(closeEv, CORE_ID);
  check("#7A core logged the pending refund (reason cancel, 1 sat)", corePrints.join(" | ").slice(0, 400), () => corePrints.some(p => p.includes("cancel") && p.includes("u1")));
  check("#7A close-batch moved no STX", stxMoves(closeEv).length, (n) => n === 0);
  const aProceeds = bare(aStx1.raw) - bare(aStx0.raw);
  check("#7A the vault's STX = the fill proceeds (> 0)", aProceeds, (d) => d > 0n);
  check("#7A the book received exactly the vault's STX", bare(bookA1.raw) - bare(bookA0.raw), (d) => d === bare(aStx1.raw));

  // L-1 small: no cooldown burned
  check("L-1 u16047 refusals left last-router-swap unchanged", `${field(cfg0.raw, "last-router-swap")} -> ${field(cfg1.raw, "last-router-swap")}`, () => field(cfg0.raw, "last-router-swap") === field(cfg1.raw, "last-router-swap"));

  // L-1 partial: exact deltas
  const amount1 = num(p1.raw, "amount"), unsold1 = num(p1.raw, "unsold"), out1 = num(p1.raw, "out"), limit1 = num(p1.raw, "limit-price"), sold1 = amount1 - unsold1;
  check("L-1 partial: the pools sold more than 8 sats and left a rest (unsold > 0)", `sold ${sold1}, unsold ${unsold1}`, () => sold1 > SLACK && unsold1 > 0n);
  check("L-1 partial: out >= floor-out(sold - 8) at the limit", `out ${out1}, floor ${floorOut(sold1 - SLACK, limit1)}`, () => out1 >= floorOut(sold1 - SLACK, limit1));
  check("L-1 partial: wallet dropped by exactly the sold sats; the rest stayed", `${field(c0.raw, "sbtc-balance")} -> ${field(c1.raw, "sbtc-balance")}`, () => bare(field(c0.raw, "sbtc-balance")) - bare(field(c1.raw, "sbtc-balance")) === sold1 && bare(field(c1.raw, "sbtc-balance")) === unsold1);
  check("L-1 partial: vault STX rose by exactly out", bare(cStx1.raw) - bare(cStx0.raw), (d) => d === out1);
  const p1Ev = eventsOf(p1), p1Sbtc = sbtcMoves(p1Ev);
  check("L-1 partial: net sBTC out of the vault in events = sold", sum(p1Sbtc.filter(m => m.from === VAULT_ID)) - sum(p1Sbtc.filter(m => m.to === VAULT_ID)), (d) => d === sold1);
  const r1 = printsOf(p1Ev, ROUTER_ID).find(x => x.includes("smart-swap-sbtc-for-stx")) || "";
  check("L-1 partial: router print agrees (jing-in 0, unsold, out)", r1.slice(0, 300), () => num(r1, "jing-in") === 0n && num(r1, "unsold") === unsold1 && num(r1, "out") === out1);
  check("L-1 partial: the vault is not empty (the rest is held)", field(c1.raw, "empty"), "false");
  // the exhausted call
  const pSold = 1000n - num(probe.raw, "unsold"), pOut = num(probe.raw, "out");
  check("L-1 probe routed inside the floor (out >= floor-out(sold - 8))", `sold ${pSold}, out ${pOut}`, () => ok(probe.raw) && pOut >= ((pSold > SLACK ? pSold - SLACK : 0n) * LIMIT) / PPDF);
  check("L-1 exhausted pools: the next call is u16047 exactly when 8 sats or less fit (probe), and moves nothing", `${p2.raw} / probe sold ${pSold}`, () => p2.raw === "(err u16047)" && pSold <= SLACK && field(c2.raw, "sbtc-balance") === field(c1.raw, "sbtc-balance"));
  // the next call sells more through the book
  const amount3 = num(p3.raw, "amount"), unsold3 = num(p3.raw, "unsold"), out3 = num(p3.raw, "out"), limit3 = num(p3.raw, "limit-price"), sold3 = amount3 - unsold3;
  check("L-1 next call: sells the whole wallet as amount", amount3, (a) => a === bare(field(c2.raw, "sbtc-balance")));
  check("L-1 next call: sold > 8, out >= floor-out(sold - 8)", `sold ${sold3}, out ${out3}, floor ${floorOut(sold3 - SLACK, limit3)}`, () => sold3 > SLACK && out3 >= floorOut(sold3 - SLACK, limit3));
  check("L-1 next call: wallet dropped by exactly sold, rest = unsold", `${field(c2.raw, "sbtc-balance")} -> ${field(c3.raw, "sbtc-balance")}`, () => bare(field(c3.raw, "sbtc-balance")) === unsold3);
  check("L-1 next call: vault STX rose by exactly out", bare(cStx3.raw) - bare(cStx2.raw), (d) => d === out3);
  const p3Ev = eventsOf(p3), p3Sbtc = sbtcMoves(p3Ev);
  const r3 = printsOf(p3Ev, ROUTER_ID).find(x => x.includes("smart-swap-sbtc-for-stx")) || "";
  check("L-1 next call: the router's book leg filled (jing-ok true, jing-in > 0)", r3.slice(0, 400), () => r3.includes("(jing-ok true)") && num(r3, "jing-in") > 0n);
  const gross3 = sum(p3Sbtc.filter(m => m.from === VAULT_ID)), back3 = sum(p3Sbtc.filter(m => m.to === VAULT_ID));
  check("L-1 next call: net sBTC out of the vault in events = sold", gross3 - back3, (d) => d === sold3);
  // #8: the allowance on a book-leg sale
  const allowNew = amount3 + MIN_X + REBATE_DUST + (MIN_X * MAX_REBATE_BPS + BPS - 1n) / BPS, allowOld = amount3 + MIN_X;
  check(`#8 book-leg sale: gross sBTC outflow within the allowance amount + min-x + 51 + ceil(min-x * 70 bps) (measured; old allowance ${allowOld})`, `gross ${gross3}, refunded ${back3}, allowance ${allowNew}`, () => gross3 <= allowNew);
  console.log(`  ..   #8 gross ${gross3} vs old allowance ${allowOld}: ${gross3 > allowOld ? "ABOVE the old allowance (the band)" : "under the old allowance (band not reached)"}`);

  writeResult("fixes", st, S, { mid: String(MID), takers: { TAKE_A: String(TAKE_A), TAKE_B: String(TAKE_B) } });
}
main().catch((e) => { console.error(e); process.exit(1); });
