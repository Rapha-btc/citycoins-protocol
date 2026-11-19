// stxer-ccd016-v2-coverage.js
// SELF-VERIFYING stxer mainnet-fork harness for ccd016-swap-vault-mia-v2, on
// the LIVE Jing stack the vault binds: markets-sbtc-stx-jing-v6-5 +
// swap-router-sbtc-stx-jing-v5-6 at their real principals and live state
// (2026-11-18 port; the old harness deployed a fresh v6-3 stack, which the
// vault no longer binds). Shared setup: simulations/_vault-live-v6-5.mjs.
//
// FIXTURES (disclosed, unchanged from the v2 harnesses): base-dao is patched
// (SetContractCode) so is-extension is true for the vault (the treasury
// withdraw) and for a proxy contract that plays a passed proposal. DIA is
// pushed from its real updater key with the Lazer prices, so Pyth and DIA
// agree. The reward is a real sBTC transfer from a holder into the treasury.
//
// Live-book differences from the v6-3 version: the Y side has a live bid, so
// an X deposit goes pending and the keeper (DEP) settles it; the vault rests
// at mid + maker-spread-bps (default u1), and other makers rest on the book,
// so fills are checked relative (the vault's own deltas) not to one maker.
//
// Covers: fund-from-treasury opens the window; jing-place (whole balance) rests
// a pegged order (spread (some u1), floor = mid - leeway); window gates (take /
// router-swap / reclaim refused, refloor DAO-only and working); a taker fills
// the vault; fuel-fair-book; window elapse by proposal + block advance;
// reclaim by anyone; router-swap by anyone at the floor with a fresh update,
// and refused u16048 with an update older than 30 s; a resting bid filled
// through the router's book leg; DAO-only take; router-swap-split; setters
// gated and range-checked; recall to the treasury; empty.
//
// Run: node simulations/stxer-ccd016-v2-coverage.js
import fs from "node:fs";
import {
  uintCV, noneCV, listCV, tupleCV, stringAsciiCV, bufferCV, falseCV,
  standardPrincipalCV, someCV,
} from "@stacks/transactions";
import { liveSession, freshUpdate, patchedBaseDao, strip, sha, assertVaultBindsLive, DEP, MKT_ID, ROUTER_ID, SBTC, WSTX, P } from "./_vault-live-v6-5.mjs";

const DEPLOYER = DEP;
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const STX_WHALE = process.env.STX_WHALE || "SP3HXJJMJQ06GNAZ8XWDN1QM48JEDC6PP6W3YZPZJ"; // real holder with liquid STX (SP9BP4… is empty since 2026-11)
const STRANGER = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM";
const DIA_UPDATER = "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0";
const DAO = "SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH";
const REWARDS_TREASURY = `${DAO}.ccd002-treasury-mia-rewards-v3`;
const DIA = `${DIA_UPDATER}.dia-oracle`;
const BOOK = "ccd015-redemption-book-mia-stx", VAULT = "ccd016-swap-vault-mia-v2", PROXY = "sim-dao-proxy";
const BOOK_ID = `${DEPLOYER}.${BOOK}`, VAULT_ID = `${DEPLOYER}.${VAULT}`, PROXY_ID = `${DEPLOYER}.${PROXY}`;
const sbtcT = P(SBTC), wstxT = P(WSTX);
const PP = 100_000_000n, PPDF = PP * 100n, BPS = 10_000n, HUGE = 999_999_999_999_999n;
const FUND = 1_000_000n; // sats into the treasury, then the vault
const TAKE_STX = 100_000_000n; // the taker's gross STX
const VAULT_FILE = `contracts/extensions/${VAULT}.clar`;

const sbtcBal = (a) => `(contract-call? '${SBTC} get-balance '${a})`;
const num = (s, key) => BigInt((String(s).match(new RegExp(`\\(${key} u(\\d+)\\)`)) || [])[1] ?? "-1");
const bare = (s) => BigInt((String(s).match(/u(\d+)/) || [])[1] ?? "-1");
const field = (s, k) => (String(s).match(new RegExp(`\\(${k} (u?\\d+|none|true|false|\\(some u\\d+\\))\\)`)) || [])[1];
const diaPush = (stxUsd, btcUsd, tsMs) => listCV([
  tupleCV({ key: stringAsciiCV("STX/USD"), value: uintCV(stxUsd), timestamp: uintCV(tsMs) }),
  tupleCV({ key: stringAsciiCV("BTC/USD"), value: uintCV(btcUsd), timestamp: uintCV(tsMs) }),
]);

const PROXY_SRC = `
(define-public (is-dao-or-extension) (ok true))
(define-public (callback (sender principal) (memo (buff 34))) (ok true))
(define-public (allow-sbtc) (contract-call? '${REWARDS_TREASURY} set-allowed '${SBTC} true))
(define-public (refloor (update (buff 8192))) (contract-call? '${VAULT_ID} jing-refloor update))
(define-public (take (amount uint) (update (buff 8192))) (contract-call? '${VAULT_ID} jing-take amount update))
(define-public (set-window (blocks uint)) (contract-call? '${VAULT_ID} set-window-blocks blocks))
(define-public (recall) (contract-call? '${VAULT_ID} dao-recall-sbtc))
(define-public (reclaim) (contract-call? '${VAULT_ID} dao-reclaim none))
(define-public (set-cooldown (blocks uint)) (contract-call? '${VAULT_ID} set-router-cooldown blocks))
(define-public (set-leeway (bps uint)) (contract-call? '${VAULT_ID} set-leeway-bps bps))
(define-public (set-slippage (bps uint)) (contract-call? '${VAULT_ID} set-slippage-bps bps))
(define-public (set-chunk (sats uint)) (contract-call? '${VAULT_ID} set-max-chunk-sats sats))
(define-public (set-dia (bps uint)) (contract-call? '${VAULT_ID} set-dia-band-bps bps))
(define-public (split (amount uint) (jing uint) (dlmm uint) (xyk uint) (velar uint) (update (buff 8192))) (contract-call? '${VAULT_ID} router-swap-split amount jing dlmm xyk velar update))
(define-public (probe) (ok { clock: (contract-call? '${VAULT_ID} get-clock), config: (contract-call? '${VAULT_ID} get-config), status: (contract-call? '${VAULT_ID} get-status) }))
`;

let checks = 0, failures = 0;
const failed = [];
function check(label, actual, want) {
  checks += 1;
  const ok = typeof want === "function" ? want(actual) : want instanceof RegExp ? want.test(String(actual)) : String(actual) === want;
  if (!ok) { failures += 1; failed.push(label); }
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${String(actual).slice(0, 170)}${ok ? "" : ` (want ${typeof want === "function" ? want.toString().slice(0, 90) : want})`}`);
}

async function main() {
  console.log(`=== ccd016-swap-vault-mia-v2 on the LIVE Jing stack (${MKT_ID}, ${ROUTER_ID}), mainnet fork ===`);
  const bookSrc = strip(`./contracts/extensions/${BOOK}.clar`);
  const vaultSrc = strip(VAULT_FILE);
  assertVaultBindsLive(vaultSrc);
  const baseDaoPatched = await patchedBaseDao(VAULT_ID, PROXY_ID);
  const S = await liveSession({ deploys: [[BOOK, bookSrc], [VAULT, vaultSrc], [PROXY, PROXY_SRC]], patches: [[`${DAO}.base-dao`, baseDaoPatched]], check });
  const { tx, ev, advance } = S;
  const lz = await freshUpdate(Number(S.tip0.block_time));
  const UPD = lz.cv, MID = lz.mid;
  const FRESH_MS = BigInt(S.tip0.block_time) * 1000n;
  console.log(`Lazer mid ${MID}; fork stacks ${S.tip0.stacks_height} burn ${S.tip0.burn_height} time ${S.tip0.block_time}; update at ${lz.at}`);
  const ok = (v) => String(v).startsWith("(ok");
  const LEEWAY = 500n, SLIPPAGE = 100n;
  const FLOOR = (MID * (BPS - LEEWAY)) / BPS;
  const ASK = (MID * (BPS + 1n)) / BPS; // mid + maker-spread-bps u1

  // ---- S0 ----
  await tx("DIA: push the Lazer prices, fresh", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(lz.py, lz.px, FRESH_MS)], "(ok true)");
  await ev("S0 config binds live market v6-5 + router v5-6 + the book", VAULT_ID, "(get-config)", (v) => v.includes(MKT_ID) && v.includes(ROUTER_ID) && v.includes(BOOK_ID) && v.includes("(maker-spread-bps u1)"));
  await ev("S0 empty", VAULT_ID, "(is-empty)", "true");
  await tx("S0 probe (traced): no clock -> batch-start none, window-ends none", DEPLOYER, PROXY_ID, "probe", [], (v) => ok(v) && v.includes("(batch-start none)") && v.includes("(window-ends none)"));
  await tx("S0 jing-place with no clock -> u16030", STRANGER, VAULT_ID, "jing-place", [UPD], "(err u16030)");
  await tx("S0 close-batch with no clock -> u16032", STRANGER, VAULT_ID, "close-batch", [], "(err u16032)");
  await tx("S0 callback -> ok", STRANGER, VAULT_ID, "callback", [standardPrincipalCV(STRANGER), bufferCV(Buffer.alloc(0))], "(ok true)");

  // ---- S1 funding ----
  const tr0 = bare((await ev("S1 treasury sats before (live)", VAULT_ID, sbtcBal(REWARDS_TREASURY), () => true)).raw);
  await tx("S1 sBTC whale sends 1M sats to the rewards treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(FUND), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  await tx("S1 proxy allows sBTC on the treasury (idempotent)", DEPLOYER, PROXY_ID, "allow-sbtc", [], ok);
  const HELD = FUND + tr0;
  await tx(`S1 stranger fund-from-treasury -> ${HELD} sats into the vault, window opens`, STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${HELD})`) && v.includes("(opened true)"));
  await ev("S1 window open", VAULT_ID, "(window-open)", "true");
  await tx("S1 probe (traced): the clock shows, window-ends some", DEPLOYER, PROXY_ID, "probe", [], (v) => ok(v) && v.includes("(window-open true)") && !v.includes("(window-ends none)"));
  await tx("S1 close-batch while funded -> u16043", STRANGER, VAULT_ID, "close-batch", [], "(err u16043)");
  await ev("S1 vault holds the batch", VAULT_ID, "(get-status)", (v) => field(v, "sbtc-balance") === `u${HELD}` && field(v, "empty") === "false");

  // ---- S2 place ----
  await tx("S2 stranger jing-place: the whole balance", STRANGER, VAULT_ID, "jing-place", [UPD], (v) => ok(v) && v.includes(`(amount u${HELD})`) && v.includes(`(floor u${FLOOR})`));
  await tx("S2 jing-place again with 0 home -> u16006", STRANGER, VAULT_ID, "jing-place", [UPD], "(err u16006)");
  await S.settleXIfPending("S2", VAULT_ID, UPD);
  await ev("S2 market order: peg at spread (some u1), floor = mid - 5%", MKT_ID, `(get-token-x-order '${VAULT_ID})`, (v) => field(v, "spread-bps") === "(some u1)" && field(v, "limit") === `u${FLOOR}`);
  await ev("S2 the vault's price is mid + 1 bp", MKT_ID, `(token-x-limit-at '${VAULT_ID} u${MID})`, `u${ASK}`);
  await ev("S2 status: all resting, 0 home", VAULT_ID, "(get-status)", (v) => field(v, "jing-resting") === `u${HELD}` && field(v, "sbtc-balance") === "u0");

  // ---- S3 gates ----
  await tx("S3 stranger jing-take -> u16000 (DAO only)", STRANGER, VAULT_ID, "jing-take", [uintCV(1000), UPD], "(err u16000)");
  await tx("S3 proxy jing-take while open -> u16031", DEPLOYER, PROXY_ID, "take", [uintCV(1000), UPD], "(err u16031)");
  await tx("S3 stranger router-swap while open -> u16031", STRANGER, VAULT_ID, "router-swap", [UPD], "(err u16031)");
  await tx("S3 stranger jing-reclaim while open -> u16031", STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], "(err u16031)");
  await tx("S3 stranger jing-refloor -> u16000 (DAO only)", STRANGER, VAULT_ID, "jing-refloor", [UPD], "(err u16000)");
  await tx("S3 proxy jing-refloor -> ok (floor re-read from the mid)", DEPLOYER, PROXY_ID, "refloor", [UPD], (v) => ok(v) && v.includes(`(floor u${FLOOR})`));
  await S.settleXLimitIfPending("S3", VAULT_ID, UPD);
  await ev("S3 order still a peg at (some u1)", MKT_ID, `(get-token-x-order '${VAULT_ID})`, (v) => field(v, "spread-bps") === "(some u1)");
  await tx("S3 stranger set-window-blocks -> u16000", STRANGER, VAULT_ID, "set-window-blocks", [uintCV(1)], "(err u16000)");
  await tx("S3 proxy set-window-blocks 2000 -> u16033 (cap 1008)", DEPLOYER, PROXY_ID, "set-window", [uintCV(2000)], "(err u16033)");
  await tx("S3 proxy set-leeway-bps 1001 -> u16033 (cap 1000)", DEPLOYER, PROXY_ID, "set-leeway", [uintCV(1001)], "(err u16033)");
  await tx("S3 proxy set-leeway-bps 500 -> ok (unchanged)", DEPLOYER, PROXY_ID, "set-leeway", [uintCV(500)], "(ok true)");
  await tx("S3 proxy set-slippage-bps 1001 -> u16033 (cap 1000)", DEPLOYER, PROXY_ID, "set-slippage", [uintCV(1001)], "(err u16033)");
  await tx("S3 proxy set-slippage-bps 100 -> ok (unchanged)", DEPLOYER, PROXY_ID, "set-slippage", [uintCV(100)], "(ok true)");
  await tx("S3 proxy set-max-chunk-sats 0 -> u16033", DEPLOYER, PROXY_ID, "set-chunk", [uintCV(0)], "(err u16033)");
  await tx("S3 proxy set-max-chunk-sats 1 BTC + 1 -> u16033 (cap 1 BTC)", DEPLOYER, PROXY_ID, "set-chunk", [uintCV(100_000_001)], "(err u16033)");
  await tx("S3 proxy set-max-chunk-sats 0.01 BTC -> ok (unchanged default)", DEPLOYER, PROXY_ID, "set-chunk", [uintCV(1_000_000)], "(ok true)");
  await tx("S3 proxy set-dia-band-bps 5001 -> u16033 (cap 5000)", DEPLOYER, PROXY_ID, "set-dia", [uintCV(5001)], "(err u16033)");
  await tx("S3 proxy set-router-cooldown 1 -> ok (unchanged)", DEPLOYER, PROXY_ID, "set-cooldown", [uintCV(1)], "(ok true)");
  await tx("S3 stranger set-leeway-bps -> u16000", STRANGER, VAULT_ID, "set-leeway-bps", [uintCV(500)], "(err u16000)");

  // ---- S4 a taker buys the vault's sBTC (cheapest ask on the live book: mid + 1 bp) ----
  const st4 = await ev("S4 vault before the taker", VAULT_ID, "(get-status)", () => true);
  const t4 = await tx(`S4 STX whale sells ${TAKE_STX / 1_000_000n} STX (taker), limit mid + 1 bp: the vault fills`, STX_WHALE, MKT_ID, "swap", [uintCV(TAKE_STX), uintCV(ASK), UPD, sbtcT, stringAsciiCV("sbtc-token"), wstxT, stringAsciiCV("wstx"), falseCV()], ok);
  check("S4 the walk matched the vault at mid + 1 bp", t4.prints.split(" | ").filter((e) => e.includes('"match"') && e.includes(VAULT_ID)).join(" ") || "(no vault match)", (v) => v.includes(`(price u${ASK})`));
  const st4b = await ev("S4 vault after the taker: less resting, STX home", VAULT_ID, "(get-status)", (v) => bare(field(v, "jing-resting")) < bare(field(st4.raw, "jing-resting")) && bare(field(v, "stx-balance")) > 0n);
  const sold4 = bare(field(st4.raw, "jing-resting")) - bare(field(st4b.raw, "jing-resting"));
  const STX_TO_VAULT = bare(field(st4b.raw, "stx-balance"));
  check("S4 the vault was paid at least sold * (mid + 1 bp) less the 10 bps fee", STX_TO_VAULT, (d) => d * PPDF >= ((sold4 * ASK) * 999n) / 1000n);
  await ev("S4 the peg keeps its rule", MKT_ID, `(get-token-x-order '${VAULT_ID})`, (v) => field(v, "spread-bps") === "(some u1)");

  // ---- S5 STX only ever goes to the book ----
  const bookBefore = await ev("S5 book STX before", BOOK_ID, `(stx-get-balance '${BOOK_ID})`, () => true);
  await tx("S5 stranger fuel-fair-book", STRANGER, VAULT_ID, "fuel-fair-book", [], (v) => ok(v) && v.includes(`(amount u${STX_TO_VAULT})`) && v.includes(BOOK_ID));
  const bookAfter = await ev("S5 book STX after", BOOK_ID, `(stx-get-balance '${BOOK_ID})`, () => true);
  check(`S5 the book received exactly ${STX_TO_VAULT} uSTX`, bare(bookAfter.raw) - bare(bookBefore.raw), (d) => d === STX_TO_VAULT);
  await ev("S5 vault STX 0", VAULT_ID, "(get-status)", (v) => field(v, "stx-balance") === "u0");
  await tx("S5 fuel-fair-book with nothing -> u16006", STRANGER, VAULT_ID, "fuel-fair-book", [], "(err u16006)");

  // ---- S6 the window elapses ----
  await tx("S6 proxy set-window-blocks 1", DEPLOYER, PROXY_ID, "set-window", [uintCV(1)], "(ok true)");
  await advance(2);
  await ev("S6 window elapsed", VAULT_ID, "(window-elapsed)", "true");
  await tx("S6 jing-place after the window -> u16030", STRANGER, VAULT_ID, "jing-place", [UPD], "(err u16030)");
  await tx("S6 proxy jing-refloor after the window -> floor = mid - 1% (slippage)", DEPLOYER, PROXY_ID, "refloor", [UPD], (v) => ok(v) && v.includes(`(floor u${(MID * (BPS - SLIPPAGE)) / BPS})`));
  await S.settleXLimitIfPending("S6", VAULT_ID, UPD);

  // ---- S7 liquidation by anyone ----
  const rest = bare(field((await ev("S7 resting before reclaim", VAULT_ID, "(get-status)", () => true)).raw, "jing-resting"));
  await tx(`S7 stranger jing-reclaim -> ${rest} sats home`, STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], (v) => ok(v) && v.includes(`(amount u${rest})`));
  await ev("S7 status: nothing resting, sats home", VAULT_ID, "(get-status)", (v) => field(v, "jing-resting") === "u0" && field(v, "sbtc-balance") === `u${rest}`);
  await tx("S7 set 300k cap to preserve partial-swap coverage", DEPLOYER, PROXY_ID, "set-chunk", [uintCV(300000)], "(ok true)");
  // bounty mw4761 H3: an update older than 30 s (rebate above 20 bps) is refused
  await ev("S7 the fresh update's rebate on the fork is the base 20 bps", MKT_ID, `(get-taker-rebate-bps-for 0x${lz.hex})`, "u20");
  const s7 = await tx("S7 stranger router-swap (fresh update): balance > cap -> the 300k cap; sells what fits inside the floor", STRANGER, VAULT_ID, "router-swap", [UPD], (v) => ok(v) && v.includes("(amount u300000)") && 300_000n - num(v, "unsold") > 8n && num(v, "out") >= ((300_000n - num(v, "unsold") - 8n) * num(v, "limit-price")) / PPDF);
  const s7sold = 300_000n - num(s7.raw, "unsold");
  await ev("S7 exactly the sold sats left the vault; the unsold rest stays home", VAULT_ID, "(get-status)", (v) => bare(field(v, "sbtc-balance")) === rest - s7sold);
  await ev("S7 vault got STX from the router", VAULT_ID, "(get-status)", (v) => bare(field(v, "stx-balance")) > 0n);
  await tx("S7 router-swap again in the same burn block -> u16044 (cooldown)", STRANGER, VAULT_ID, "router-swap", [UPD], "(err u16044)");
  await ev("S7 the refused call moved nothing", VAULT_ID, "(get-status)", (v) => bare(field(v, "sbtc-balance")) === rest - s7sold);
  await ev("S7 config: cooldown 1 block, last sale stamped", VAULT_ID, "(get-config)", (v) => field(v, "router-cooldown-blocks") === "u1" && bare(field(v, "last-router-swap")) > 0n);
  await tx("S7 stranger set-router-cooldown -> u16000", STRANGER, VAULT_ID, "set-router-cooldown", [uintCV(0)], "(err u16000)");
  await tx("S7 proxy set-router-cooldown 200 -> u16033 (cap 144)", DEPLOYER, PROXY_ID, "set-cooldown", [uintCV(200)], "(err u16033)");
  await tx("S7 proxy set-max-chunk-sats 1000", DEPLOYER, PROXY_ID, "set-chunk", [uintCV(1000)], "(ok true)");
  await advance(1);
  const s7c = await tx("S7 next burn block: router-swap one 1000-sat chunk (checked against the probe below)", STRANGER, VAULT_ID, "router-swap", [UPD], () => true);
  const LIMIT = (MID * (BPS - SLIPPAGE)) / BPS;
  const probe = await tx("S7 probe: an sBTC holder routes 1000 sats at the vault's floor, min-out 0", SBTC_WHALE, ROUTER_ID, "smart-swap-sbtc-for-stx", [uintCV(1000), uintCV(LIMIT), someCV(UPD), uintCV(MID), uintCV(0)], () => true);
  {
    const pSold = 1000n - num(probe.raw, "unsold"), pOut = num(probe.raw, "out");
    check("S7 the probe routed inside the floor (out >= floor-out(sold - 8))", `sold ${pSold}, out ${pOut}`, () => ok(probe.raw) && pOut >= ((pSold > 8n ? pSold - 8n : 0n) * LIMIT) / PPDF);
    check("S7 1000-sat chunk: u16047 iff 8 sats or less fit inside the floor, else it sells", `${s7c.raw} / probe sold ${pSold}`, () => s7c.raw === "(err u16047)" ? pSold <= 8n : ok(s7c.raw) && s7c.raw.includes("(amount u1000)") && 1000n - num(s7c.raw, "unsold") > 8n);
  }
  await tx("S7 stranger fuel-fair-book again", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);

  // ---- S7s stale update (bounty mw4761 H3): older than 30 s -> u16048 ----
  const t7pre = await S.getTip();
  await advance(1, Math.max(1, lz.at + 50 - Number(t7pre.block_time)));
  const t7s = await S.getTip();
  const ageS = Number(t7s.block_time) - lz.at;
  check("S7s fork clock is now 40-60 s past the update (under the 80 s MAX_STALENESS)", ageS, (a) => a >= 40 && a < 80);
  await ev("S7s that update's rebate is now above the base 20 bps", MKT_ID, `(get-taker-rebate-bps-for 0x${lz.hex})`, (v) => bare(v) > 20n);
  const preS = await ev("S7s vault sats before", VAULT_ID, "(get-status)", () => true);
  await tx("S7s stranger router-swap with the stale update -> u16048", STRANGER, VAULT_ID, "router-swap", [UPD], "(err u16048)");
  await ev("S7s the refused call moved nothing", VAULT_ID, "(get-status)", (v) => field(v, "sbtc-balance") === field(preS.raw, "sbtc-balance"));
  const lz2 = await freshUpdate(Number(t7s.block_time));
  const UPD2 = lz2.cv, MID2 = lz2.mid;
  await ev("S7s a fresh update is back at 20 bps", MKT_ID, `(get-taker-rebate-bps-for 0x${lz2.hex})`, "u20");
  await tx("S7s DIA: push the fresh prices", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(lz2.py, lz2.px, BigInt(t7s.block_time) * 1000n)], "(ok true)");

  // ---- S7b the router's BOOK leg: a bid rests at the mid, router-swap fills it there ----
  const cyc0 = await ev("S7b market cycle before", MKT_ID, "(get-current-cycle)", () => true);
  const whaleSats0 = await ev("S7b the bidder's sats before", VAULT_ID, sbtcBal(STX_WHALE), () => true);
  await tx("S7b STX whale rests a 200 STX bid pegged at the mid", STX_WHALE, MKT_ID, "deposit-token-y", [uintCV(200_000_000), uintCV(HUGE), someCV(uintCV(0)), wstxT, stringAsciiCV("wstx")], ok);
  await S.settleYIfPending("S7b", STX_WHALE, UPD2);
  const stxBefore7b = await ev("S7b vault STX before", VAULT_ID, `(stx-get-balance '${VAULT_ID})`, () => true);
  await tx("S7b proxy set-max-chunk-sats 100k", DEPLOYER, PROXY_ID, "set-chunk", [uintCV(100_000)], "(ok true)");
  await advance(1);
  const s7b = await tx("S7b stranger router-swap 100k sats (fresh update): book leg + pools inside the floor, the rest stays", STRANGER, VAULT_ID, "router-swap", [UPD2], (v) => ok(v) && v.includes("(amount u100000)") && 100_000n - num(v, "unsold") > 8n && num(v, "out") >= ((100_000n - num(v, "unsold") - 8n) * num(v, "limit-price")) / PPDF);
  check("S7b router-swap execution cost (runtime)", JSON.stringify(s7b.receipt?.receipt?.execution_cost ?? s7b.receipt?.execution_cost ?? "n/a"), () => true);
  const cyc1 = await ev("S7b market cycle after: the book settled", MKT_ID, "(get-current-cycle)", () => true);
  const whaleSats1 = await ev("S7b the bidder's sats after", VAULT_ID, sbtcBal(STX_WHALE), () => true);
  const stxAfter7b = await ev("S7b vault STX after", VAULT_ID, `(stx-get-balance '${VAULT_ID})`, () => true);
  check("S7b the market settled one cycle through the router's book leg", bare(cyc1.raw) - bare(cyc0.raw), (d) => d === 1n);
  check("S7b the bidder received sBTC from the book leg", bare(whaleSats1.raw) - bare(whaleSats0.raw), (d) => d > 0n);
  check("S7b the vault received exactly the router-swap out in STX", bare(stxAfter7b.raw) - bare(stxBefore7b.raw), (d) => d > 0n && d === num(s7b.raw, "out"));
  await tx("S7b stranger fuel-fair-book", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);

  // ---- S8 DAO-only take against a resting bid ----
  await tx("S8 STX whale rests a 200 STX bid pegged at the mid", STX_WHALE, MKT_ID, "deposit-token-y", [uintCV(200_000_000), uintCV(HUGE), someCV(uintCV(0)), wstxT, stringAsciiCV("wstx")], ok);
  await S.settleYIfPending("S8", STX_WHALE, UPD2);
  await tx("S8 stranger jing-take after the window -> still u16000", STRANGER, VAULT_ID, "jing-take", [uintCV(50_000), UPD2], "(err u16000)");
  await tx("S8 proxy set-dia-band-bps 0 -> ok (the ccip027 dial: DIA no longer consulted)", DEPLOYER, PROXY_ID, "set-dia", [uintCV(0)], "(ok true)");
  await tx("S8 proxy jing-take 50k sats -> fills (FOK)", DEPLOYER, PROXY_ID, "take", [uintCV(50_000), UPD2], (v) => ok(v) && bare((String(v).match(/\(out (u\d+)\)/) || [])[1]) > 0n);
  await ev("S8 vault STX from the take", VAULT_ID, "(get-status)", (v) => bare(field(v, "stx-balance")) > 0n);

  // ---- S8b router-swap-split ----
  await tx("S8b stranger router-swap-split -> u16000", STRANGER, VAULT_ID, "router-swap-split", [uintCV(2000), uintCV(0), uintCV(2000), uintCV(0), uintCV(0), UPD2], "(err u16000)");
  await tx("S8b proxy split 2000 = 0 + 1000 + 0 + 0 -> u16040 (mismatch)", DEPLOYER, PROXY_ID, "split", [uintCV(2000), uintCV(0), uintCV(1000), uintCV(0), uintCV(0), UPD2], "(err u16040)");
  await tx("S8b proxy set-slippage-bps 500", DEPLOYER, PROXY_ID, "set-slippage", [uintCV(500)], "(ok true)");
  await advance(1);
  await tx("S8b proxy split 2000 sats, all to the DLMM -> ok, unsold 0", DEPLOYER, PROXY_ID, "split", [uintCV(2000), uintCV(0), uintCV(2000), uintCV(0), uintCV(0), UPD2], (v) => ok(v) && v.includes("(unsold u0)"));
  await tx("S8b proxy split again in the same burn block -> u16044 (shared cooldown)", DEPLOYER, PROXY_ID, "split", [uintCV(1000), uintCV(0), uintCV(1000), uintCV(0), uintCV(0), UPD2], "(err u16044)");
  await tx("S8b proxy set-slippage-bps back to 100", DEPLOYER, PROXY_ID, "set-slippage", [uintCV(100)], "(ok true)");

  // ---- S9 recall ----
  const trBefore = await ev("S9 treasury sats before recall", VAULT_ID, sbtcBal(REWARDS_TREASURY), () => true);
  await tx("S9 stranger dao-recall-sbtc -> u16000", STRANGER, VAULT_ID, "dao-recall-sbtc", [], "(err u16000)");
  await tx("S9 proxy recall -> ok", DEPLOYER, PROXY_ID, "recall", [], ok);
  const trAfter = await ev("S9 treasury sats after recall", VAULT_ID, sbtcBal(REWARDS_TREASURY), () => true);
  check("S9 the treasury received the recalled sats", bare(trAfter.raw) - bare(trBefore.raw), (d) => d > 0n);
  await ev("S9 vault sats 0", VAULT_ID, "(get-status)", (v) => field(v, "sbtc-balance") === "u0");
  await tx("S9 stranger fuel-fair-book (the take's STX)", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);
  await ev("S9 empty again", VAULT_ID, "(is-empty)", "true");

  console.log(`\n${checks - failures}/${checks} checks green${failed.length ? `; FAILED: ${failed.join("; ")}` : ""}\n${S.url}`);
  const RESULTS_DIR = process.env.SIM_RESULTS_DIR || "simulations/results/ccd016-v2";
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(`${RESULTS_DIR}/coverage.json`, JSON.stringify({ simulationId: S.sid, url: S.url, checks, failures, failed, liveStack: { market: MKT_ID, router: ROUTER_ID }, fork: S.tip0, mid: String(MID), sourceHash: sha(VAULT_FILE), steps: S.record }, null, 2) + "\n");
  if (failures > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
