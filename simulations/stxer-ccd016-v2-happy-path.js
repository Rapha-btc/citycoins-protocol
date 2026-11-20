// stxer-ccd016-v2-happy-path.js
// SELF-VERIFYING stxer mainnet-fork harness for ccd016-swap-vault-mia-v2 on
// the LIVE Jing stack the vault binds (markets-sbtc-stx-jing-v6-5 +
// swap-router-sbtc-stx-jing-v6 (jing repo bytes, deployed first), real principals, live state). 2026-11-18
// port of the v6-3 version; shared setup in simulations/_vault-live-v6-5.mjs.
//
// FIXTURES (disclosed, unchanged): base-dao patched (SetContractCode) so
// is-extension is true for the vault and a proxy that plays a passed
// proposal; DIA pushed from its real updater key with the Lazer prices; real
// sBTC / STX holders fund the treasury and take.
//
// The HAPPY PATH, three windows:
//   batch 1: fund (window opens) -> jing-place (pending on the live book ->
//            keeper settles) -> a taker bigger than the batch buys the WHOLE
//            batch at mid + 1 bp (the live asks behind the vault absorb the
//            rest) -> empty -> close-batch clears the stale clock ->
//            fuel-fair-book
//   batch 2: fund (second window) -> jing-place -> a 1-sat funding joins
//            (opens nothing) -> the window elapses (proposal + advance) ->
//            reclaim by anyone -> router-swap (fresh update) sells what fits
//            inside the floor -> a bid rests at the mid -> router-swap sells
//            the rest -> empty, the exit cleared the clock -> fuel
//   batch 3: fund (third window) -> jing-place rests the batch.
// Run: node simulations/stxer-ccd016-v2-happy-path.js
import { uintCV, noneCV, stringAsciiCV, falseCV, standardPrincipalCV, someCV } from "@stacks/transactions";
import {
  liveSession, freshUpdate, patchedBaseDao, strip, assertVaultBindsLive, makeCheck, writeResult, diaPush, num, bare, field,
  DEP, MKT_ID, SBTC, WSTX, P, STX_WHALE, SBTC_WHALE, STRANGER, DIA, DIA_UPDATER, REWARDS_TREASURY, DAO,
} from "./_vault-live-v6-5.mjs";

const BOOK = "ccd015-redemption-book-mia-stx", VAULT = "ccd016-swap-vault-mia-v2", PROXY = "sim-dao-proxy";
const BOOK_ID = `${DEP}.${BOOK}`, VAULT_ID = `${DEP}.${VAULT}`, PROXY_ID = `${DEP}.${PROXY}`;
const sbtcT = P(SBTC), wstxT = P(WSTX);
const PPDF = 10_000_000_000n, BPS = 10_000n, HUGE = 999_999_999_999_999n;
const FUND = 100_000n;
const TAKE_STX = 400_000_000n; // worth more than the batch, so the vault sells out
const PROXY_SRC = `
(define-public (is-dao-or-extension) (ok true))
(define-public (callback (sender principal) (memo (buff 34))) (ok true))
(define-public (allow-sbtc) (contract-call? '${REWARDS_TREASURY} set-allowed '${SBTC} true))
(define-public (set-window (blocks uint)) (contract-call? '${VAULT_ID} set-window-blocks blocks))
(define-public (recall) (contract-call? '${VAULT_ID} dao-recall-sbtc))
`;

const st = makeCheck(), check = st.check;
async function main() {
  console.log("=== ccd016 v2 HAPPY PATH on the live Jing v6-5 stack: three windows (mainnet fork, Lazer) ===");
  const vaultSrc = strip(`contracts/extensions/${VAULT}.clar`); assertVaultBindsLive(vaultSrc);
  const S = await liveSession({ deploys: [[BOOK, strip(`contracts/extensions/${BOOK}.clar`)], [VAULT, vaultSrc], [PROXY, PROXY_SRC]], patches: [[`${DAO}.base-dao`, await patchedBaseDao(VAULT_ID, PROXY_ID)]], check });
  const { tx, ev, advance } = S;
  const lz = await freshUpdate(Number(S.tip0.block_time));
  const UPD = lz.cv, MID = lz.mid, ASK = (MID * (BPS + 1n)) / BPS;
  console.log(`Lazer mid ${MID}; fork time ${S.tip0.block_time}; update at ${lz.at}`);
  const ok = (v) => String(v).startsWith("(ok");
  const toTreasury = (n) => [uintCV(n), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()];
  const status = (label, want) => ev(label, VAULT_ID, "(get-status)", want);
  const clock = (label, want) => ev(label, VAULT_ID, "(get-clock)", want);

  await tx("DIA: push the Lazer prices, fresh", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(lz.py, lz.px, BigInt(S.tip0.block_time) * 1000n)], "(ok true)");
  await tx("proxy allows sBTC on the treasury (idempotent)", DEP, PROXY_ID, "allow-sbtc", [], ok);
  await clock("S0 empty, no clock", (v) => field(v, "batch-start") === "none");
  const tr0 = bare((await ev("S0 treasury sats (live)", SBTC, `(get-balance '${REWARDS_TREASURY})`, () => true)).raw);

  // ---- B1 ----
  await tx("B1 whale sends 100k sats to the treasury", SBTC_WHALE, SBTC, "transfer", toTreasury(FUND), "(ok true)");
  const B1 = FUND + tr0;
  await tx("B1 fund-from-treasury: empty vault -> window opens", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${B1})`) && v.includes("(opened true)"));
  const b1 = await clock("B1 clock open", (v) => field(v, "window-open") === "true");
  await tx("B1 stranger jing-place: the whole batch", STRANGER, VAULT_ID, "jing-place", [UPD], (v) => ok(v) && v.includes(`(amount u${B1})`));
  await S.settleXIfPending("B1", VAULT_ID, UPD);
  await status("B1 the batch resting, 0 home", (v) => field(v, "jing-resting") === `u${B1}` && field(v, "sbtc-balance") === "u0" && field(v, "empty") === "false");
  await ev("B1 live depth behind the vault: other asks rest on X", MKT_ID, "(len (get-token-x-depositors (get-current-cycle)))", (v) => bare(v) >= 2n);
  const t1 = await tx("B1 a taker sells 400 STX: the vault's whole batch fills first (best ask, mid + 1 bp), the rest hits the live asks", STX_WHALE, MKT_ID, "swap", [uintCV(TAKE_STX), uintCV(HUGE), UPD, sbtcT, stringAsciiCV("sbtc-token"), wstxT, stringAsciiCV("wstx"), falseCV()], ok);
  check("B1 the vault matched at mid + 1 bp", t1.prints.split(" | ").filter((e) => e.includes('"match"') && e.includes(VAULT_ID)).join(" ") || "(none)", (v) => v.includes(`(price u${ASK})`));
  await status("B1 sold out: nothing resting, no sats home, STX home, EMPTY", (v) => field(v, "jing-resting") === "u0" && field(v, "sbtc-balance") === "u0" && bare(field(v, "stx-balance")) > 0n && field(v, "empty") === "true");
  await clock("B1 the clock still shows (no exit call ran here)", (v) => field(v, "batch-start") !== "none");
  await tx("B1 stranger close-batch: the vault is empty, the stale clock clears", STRANGER, VAULT_ID, "close-batch", [], (v) => ok(v) && v.includes("close-batch"));
  await clock("B1 clock cleared by close-batch", (v) => field(v, "batch-start") === "none" && field(v, "window-open") === "false");
  await tx("B1 close-batch again -> u16032 (no clock)", STRANGER, VAULT_ID, "close-batch", [], "(err u16032)");
  await tx("B1 stranger fuel-fair-book: the STX goes to the book", STRANGER, VAULT_ID, "fuel-fair-book", [], (v) => ok(v) && v.includes(BOOK_ID));
  await clock("B1 clock still clear after the flush", (v) => field(v, "batch-start") === "none");
  await advance(3);

  // ---- B2 ----
  await tx("B2 whale sends 100k sats to the treasury", SBTC_WHALE, SBTC, "transfer", toTreasury(FUND), "(ok true)");
  await tx("B2 fund-from-treasury: empty vault -> a SECOND window opens", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND})`) && v.includes("(opened true)"));
  const b2 = await clock("B2 clock open, fresh batch-start", (v) => field(v, "window-open") === "true");
  await tx("B2 stranger jing-place", STRANGER, VAULT_ID, "jing-place", [UPD], (v) => ok(v) && v.includes(`(amount u${FUND})`));
  await S.settleXIfPending("B2", VAULT_ID, UPD);
  await status("B2 100k resting", (v) => field(v, "jing-resting") === `u${FUND}`);
  await tx("B2 1 sat to the treasury", SBTC_WHALE, SBTC, "transfer", toTreasury(1n), "(ok true)");
  await tx("B2 fund-from-treasury while the batch rests -> joins, opens nothing (1 sat < MIN_RESTART_SATS)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(amount u1)") && v.includes("(opened false)"));
  await tx("B2 proxy set-window-blocks 1", DEP, PROXY_ID, "set-window", [uintCV(1)], "(ok true)");
  await advance(2);
  await clock("B2 window elapsed: nobody took", (v) => field(v, "window-elapsed") === "true");
  await tx("B2 stranger jing-reclaim: the batch comes home", STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], (v) => ok(v) && v.includes(`(amount u${FUND})`));
  await status("B2 100,001 home, nothing resting, not empty", (v) => field(v, "sbtc-balance") === `u${FUND + 1n}` && field(v, "jing-resting") === "u0" && field(v, "empty") === "false");
  const b2a = await tx("B2 stranger router-swap the whole 100,001 sats at the floor (fresh update): sells what fits inside it", STRANGER, VAULT_ID, "router-swap", [UPD], (v) => ok(v) && v.includes(`(amount u${FUND + 1n})`) && FUND + 1n - num(v, "unsold") > 8n && num(v, "out") >= ((FUND + 1n - num(v, "unsold") - 8n) * num(v, "limit-price")) / PPDF);
  await status("B2 exactly the unsold rest stays home", (v) => bare(field(v, "sbtc-balance")) === num(b2a.raw, "unsold"));
  await tx("B2 STX whale rests a 300 STX bid pegged at the mid", STX_WHALE, MKT_ID, "deposit-token-y", [uintCV(300_000_000), uintCV(HUGE), someCV(uintCV(0)), wstxT, stringAsciiCV("wstx")], "(ok u300000000)");
  await S.settleYIfPending("B2", STX_WHALE, UPD);
  await advance(1);
  await tx("B2 next burn block: router-swap sells the rest (or, if the first call left at most DUST_SATS 2, the batch is closed: u16031)", STRANGER, VAULT_ID, "router-swap", [UPD], (v) => num(b2a.raw, "unsold") > 2n ? ok(v) && v.includes(`(amount u${num(b2a.raw, "unsold")})`) && num(v, "unsold") <= 2n : v === "(err u16031)");
  await status("B2 sold: at most 2 dust sats home, nothing on the market, EMPTY", (v) => bare(field(v, "sbtc-balance")) <= 2n && field(v, "jing-resting") === "u0" && field(v, "jing-parked") === "u0" && field(v, "empty") === "true");
  await clock("B2 the exit cleared the clock", (v) => field(v, "batch-start") === "none" && field(v, "window-elapsed") === "false");
  await tx("B2 stranger fuel-fair-book", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);
  await tx("B2 the bidder cancels what is left of its bid", STX_WHALE, MKT_ID, "cancel-token-y-deposit", [wstxT, stringAsciiCV("wstx")], ok);

  // ---- B3 ----
  await tx("B3 whale sends 100k sats to the treasury", SBTC_WHALE, SBTC, "transfer", toTreasury(FUND), "(ok true)");
  await tx("B3 fund-from-treasury: empty vault -> a THIRD window opens", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(opened true)"));
  const b3 = await clock("B3 clock open", (v) => field(v, "window-open") === "true");
  await tx("B3 stranger jing-place", STRANGER, VAULT_ID, "jing-place", [UPD], ok);
  await S.settleXIfPending("B3", VAULT_ID, UPD);
  await status("B3 resting: the batch plus B2's dust (at most 2 sats), nothing escrowed", (v) => bare(field(v, "jing-resting")) >= FUND && bare(field(v, "jing-resting")) <= FUND + 2n && field(v, "jing-escrowed") === "u0");
  check("B2 batch-start moved on from B1", bare(field(b2.raw, "batch-start")), (v) => v > bare(field(b1.raw, "batch-start")));
  check("B3 batch-start moved on from B2", bare(field(b3.raw, "batch-start")), (v) => v > bare(field(b2.raw, "batch-start")));
  writeResult("happy-path", st, S, { mid: String(MID) });
}
main().catch((e) => { console.error(e); process.exit(1); });
