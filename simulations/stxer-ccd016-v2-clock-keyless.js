// stxer-ccd016-v2-clock-keyless.js
// SELF-VERIFYING stxer mainnet-fork harness for the CLOCK of
// ccd016-swap-vault-mia-v2 (bounty mu0oy1vzf432efb13c31, Patient Reed /
// Celestial Mast: a free start-clock, or 1 sat into the treasury plus
// fund-from-treasury, re-armed the patience window forever on leftovers).
// 2026-11-18 port: the vault binds the LIVE markets-sbtc-stx-jing-v6-5 +
// swap-router-sbtc-stx-jing-v6 (jing repo bytes, deployed first), so nothing of Jing is deployed any more;
// shared setup in simulations/_vault-live-v6-5.mjs. Nothing is placed on
// the book; the sats stay home, the window is shortened by proposal and the
// chain advanced, and every clock path is exercised on the leftovers.
// Keyless: the one Lazer update (S8 router-swap gets past vault-mid to the
// window gate) comes from the public faktory-dao route.
//
// FIXTURES (disclosed, unchanged): base-dao patched (SetContractCode) so
// is-extension is true for the vault and a proxy that plays a passed proposal.
//
// Covers: funding an empty vault opens the window (opened true); a top-up
// while open joins; window elapse; 1 sat to the treasury + fund-from-treasury
// on the leftovers pulls the sat and opens nothing (still elapsed);
// close-batch refused while not empty; recall empties the vault and clears
// the clock; close-batch with no clock u16032; the next funding opens fresh;
// a plain transfer into the empty vault has no clock (reclaim u16031) and
// joins the next funding, which opens; recall clears again; the DIA
// escape-hatch proposal (contracts/proposals/ccip027-ccd016-dia-band-off.clar)
// executed through the real base-dao execute by an enabled extension sets
// the band to 0, a stranger cannot, a restore proposal puts 1000 back; S8
// the dust/elapsed cases (all consistent with the H2 restart rule: every
// funding that opens here is on an empty vault, no clock, elapsed dust, or
// >= MIN_RESTART_SATS and >= held; every join is under 500k).
//
// Run: node simulations/stxer-ccd016-v2-clock-keyless.js
import { uintCV, noneCV, standardPrincipalCV } from "@stacks/transactions";
import {
  liveSession, freshUpdate, patchedBaseDao, strip, assertVaultBindsLive, makeCheck, writeResult, bare, field,
  DEP, SBTC, P, SBTC_WHALE, STRANGER, REWARDS_TREASURY, DAO, BASE_DAO,
} from "./_vault-live-v6-5.mjs";
const DEPLOYER = DEP;
const BOOK = "ccd015-redemption-book-mia-stx", VAULT = "ccd016-swap-vault-mia-v2", PROXY = "sim-dao-proxy";
const VAULT_ID = `${DEPLOYER}.${VAULT}`, PROXY_ID = `${DEPLOYER}.${PROXY}`;
const FUND = 1_000_000n;
const sbtcBal = (a) => `(contract-call? '${SBTC} get-balance '${a})`;
const PROXY_SRC = `
(define-public (is-dao-or-extension) (ok true))
(define-public (callback (sender principal) (memo (buff 34))) (ok true))
(define-public (allow-sbtc) (contract-call? '${REWARDS_TREASURY} set-allowed '${SBTC} true))
(define-public (set-window (blocks uint)) (contract-call? '${VAULT_ID} set-window-blocks blocks))
(define-public (recall) (contract-call? '${VAULT_ID} dao-recall-sbtc))
(define-public (reclaim) (contract-call? '${VAULT_ID} dao-reclaim none))
(define-public (drain (amount uint)) (contract-call? '${REWARDS_TREASURY} withdraw-ft '${SBTC} amount tx-sender))
(define-public (set-band (bps uint)) (contract-call? '${VAULT_ID} set-dia-band-bps bps))
(use-trait proposal-trait '${DAO}.proposal-trait.proposal-trait)
(define-public (run (p <proposal-trait>)) (contract-call? '${BASE_DAO} execute p tx-sender))
`;
const RESTORE_SRC = `
(impl-trait '${DAO}.proposal-trait.proposal-trait)
(define-public (execute (sender principal))
  (begin
    (try! (contract-call? '${VAULT_ID} set-dia-band-bps u1000))
    (ok true)
  )
)
`;
const st = makeCheck(), check = st.check;
async function main() {
  console.log("=== ccd016-swap-vault-mia-v2 CLOCK, vault on the live Jing v6-5 stack, mainnet fork, keyless ===");
  const vaultSrc = strip(`contracts/extensions/${VAULT}.clar`); assertVaultBindsLive(vaultSrc);
  const PROP = "ccip027-ccd016-dia-band-off", PROP_ID = `${DEPLOYER}.${PROP}`, RESTORE = "ccip-ccd016-dia-band-restore", RESTORE_ID = `${DEPLOYER}.${RESTORE}`;
  const propSrc = strip(`./contracts/proposals/${PROP}.clar`);
  if (!propSrc.includes(".ccd016-swap-vault-mia-v2 set-dia-band-bps u0")) throw new Error("proposal does not set the band to 0");
  const S = await liveSession({ deploys: [[BOOK, strip(`contracts/extensions/${BOOK}.clar`)], [VAULT, vaultSrc], [PROXY, PROXY_SRC], [PROP, propSrc], [RESTORE, RESTORE_SRC]], patches: [[BASE_DAO, await patchedBaseDao(VAULT_ID, PROXY_ID)]], check });
  const { tx, ev, advance } = S;
  const lz = await freshUpdate(Number(S.tip0.block_time));
  const UPD = lz.cv;
  const ok = (v) => String(v).startsWith("(ok");
  const err = (v) => String(v).startsWith("(err");
  const status = (label, want) => ev(label, VAULT_ID, "(get-status)", want);
  await ev("S0 live treasury holds no sBTC (amounts below are exact)", SBTC, `(get-balance '${REWARDS_TREASURY})`, "(ok u0)");
  await ev("S0 empty", VAULT_ID, "(is-empty)", "true");
  await ev("S0 no clock", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none" && field(v, "window-open") === "false" && field(v, "window-elapsed") === "false");
  await tx("S0 close-batch with no clock -> u16032", STRANGER, VAULT_ID, "close-batch", [], "(err u16032)");

  // ---- S1 funding an empty vault opens the window ----
  await tx("S1 sBTC whale sends 1M sats to the rewards treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(FUND), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  await tx("S1 proxy allows sBTC on the treasury (idempotent)", DEPLOYER, PROXY_ID, "allow-sbtc", [], ok);
  await tx("S1 stranger fund-from-treasury -> 1M sats in, window opens (vault was empty)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND})`) && v.includes("(opened true)"));
  const c1 = await ev("S1 clock: open", VAULT_ID, "(get-clock)", (v) => field(v, "window-open") === "true" && field(v, "window-elapsed") === "false");
  await status("S1 1M home, not empty", (v) => field(v, "sbtc-balance") === `u${FUND}` && field(v, "empty") === "false");
  await tx("S1 a top-up while open: 100 sats to the treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(100), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  await tx("S1 fund-from-treasury while open -> joins, opens nothing", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(amount u100)") && v.includes("(opened false)"));
  const c1b = await ev("S1 clock unchanged by the top-up", VAULT_ID, "(get-clock)", (v) => field(v, "window-open") === "true");
  await tx("S1 reclaim while open -> u16031", STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], "(err u16031)");

  // ---- S2 the window elapses: proposal shortens it, the chain moves on ----
  await tx("S2 proxy set-window-blocks 1", DEPLOYER, PROXY_ID, "set-window", [uintCV(1)], "(ok true)");
  await advance(2);
  await ev("S2 window elapsed, leftovers home", VAULT_ID, "(get-clock)", (v) => field(v, "window-open") === "false" && field(v, "window-elapsed") === "true");
  await status("S2 1,000,100 home, not empty", (v) => field(v, "sbtc-balance") === `u${FUND + 100n}` && field(v, "empty") === "false");

  // ---- S3 the re-arm (Reed / Mast): refused on leftovers ----
  await ev("S3 start-clock is gone: no function to re-arm with", VAULT_ID, "(window-elapsed)", "true");
  await tx("S3 1 sat lands in the treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(1), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  await tx("S3 fund-from-treasury on a non-empty vault -> pulls the sat, opens nothing (was: re-armed)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(amount u1)") && v.includes("(opened false)"));
  await ev("S3 still elapsed: the sat joined the liquidation phase", VAULT_ID, "(window-elapsed)", "true");
  await status("S3 1,000,101 home", (v) => field(v, "sbtc-balance") === `u${FUND + 101n}`);
  await tx("S3 close-batch while not empty -> u16043", STRANGER, VAULT_ID, "close-batch", [], "(err u16043)");
  await tx("S3 jing-reclaim with nothing on the book -> amount zero", STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], (v) => String(v).startsWith("(ok") && String(v).includes("(amount u0)"));

  // ---- S4 recall empties the vault and clears the clock ----
  const trBefore = await ev("S4 treasury sats before recall", VAULT_ID, sbtcBal(REWARDS_TREASURY), () => true);
  await tx("S4 stranger dao-recall-sbtc -> u16000", STRANGER, VAULT_ID, "dao-recall-sbtc", [], "(err u16000)");
  await tx("S4 proxy recall -> ok", DEPLOYER, PROXY_ID, "recall", [], (v) => ok(v) && v.includes(`(amount u${FUND + 101n})`));
  const trAfter = await ev("S4 treasury sats after recall", VAULT_ID, sbtcBal(REWARDS_TREASURY), () => true);
  await status("S4 vault sats 0, empty", (v) => field(v, "sbtc-balance") === "u0" && field(v, "empty") === "true");
  await ev("S4 the exit cleared the clock", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none" && field(v, "window-open") === "false" && field(v, "window-elapsed") === "false");
  await tx("S4 close-batch with no clock -> u16032", STRANGER, VAULT_ID, "close-batch", [], "(err u16032)");
  await tx("S4 fuel-fair-book with nothing -> u16006", STRANGER, VAULT_ID, "fuel-fair-book", [], "(err u16006)");

  // ---- S5 the next funding opens a fresh window ----
  await tx("S5 the treasury has the recalled sats: fund again -> fresh window (opened true)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND + 101n})`) && v.includes("(opened true)"));
  await ev("S5 window open", VAULT_ID, "(window-open)", "true");
  await tx("S5 proxy recall again -> ok, clock clears", DEPLOYER, PROXY_ID, "recall", [], ok);
  await ev("S5 clock cleared", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none");

  // ---- S6 a plain transfer into an EMPTY vault: no clock of its own, it joins the next funding ----
  await tx("S6 whale sends 1000 sats straight to the empty vault", SBTC_WHALE, SBTC, "transfer", [uintCV(1000), standardPrincipalCV(SBTC_WHALE), P(VAULT_ID), noneCV()], "(ok true)");
  await ev("S6 no clock: neither open nor elapsed", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none" && field(v, "window-open") === "false" && field(v, "window-elapsed") === "false");
  await tx("S6 reclaim with no clock -> u16031", STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], "(err u16031)");
  await tx("S6 close-batch while not empty -> u16043", STRANGER, VAULT_ID, "close-batch", [], "(err u16043)");
  await tx("S6 200 sats land in the treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(200), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  await tx("S6 fund-from-treasury: vault not empty but no clock -> opens (the stray sats join)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND + 301n})`) && v.includes("(opened true)")); // the treasury still holds S5's recalled sats
  await ev("S6 window open", VAULT_ID, "(window-open)", "true");
  await status("S6 1,001,301 home", (v) => field(v, "sbtc-balance") === `u${FUND + 1301n}`);
  await tx("S6 proxy set-window-blocks 1", DEPLOYER, PROXY_ID, "set-window", [uintCV(1)], "(ok true)");
  await advance(2);
  await ev("S6 elapsed", VAULT_ID, "(window-elapsed)", "true");
  await tx("S6 proxy recall -> ok, the clock clears with the vault", DEPLOYER, PROXY_ID, "recall", [], (v) => ok(v) && v.includes(`(amount u${FUND + 1301n})`));
  await ev("S6 clock cleared, empty", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none");
  await ev("S6 empty", VAULT_ID, "(is-empty)", "true");

  // ---- S7 the DIA escape hatch: a real proposal through base-dao execute ----
  await ev("S7 dia band 1000 before", VAULT_ID, "(get dia-band-bps (get-config))", "u1000");
  await tx("S7 stranger calls the proposal's execute directly -> the vault refuses (u16000: not the DAO)", STRANGER, PROP_ID, "execute", [standardPrincipalCV(STRANGER)], "(err u16000)");
  await tx("S7 the proxy (an enabled extension) runs it through base-dao execute -> ok", DEPLOYER, PROXY_ID, "run", [P(PROP_ID)], "(ok true)");
  await ev("S7 dia band 0: the vault prices on Lazer alone", VAULT_ID, "(get dia-band-bps (get-config))", "u0");
  await tx("S7 the same proposal again -> base-dao refuses a proposal already executed", DEPLOYER, PROXY_ID, "run", [P(PROP_ID)], err);
  await tx("S7 the restore proposal through base-dao -> ok", DEPLOYER, PROXY_ID, "run", [P(RESTORE_ID)], "(ok true)");
  await ev("S7 dia band back to 1000", VAULT_ID, "(get dia-band-bps (get-config))", "u1000");

  // ---- S8 bounty mv7dfb (Calm Forge): dust left after an elapsed window ----
  // 3-8 sats (above DUST_SATS 2) kept the old elapsed batch alive, so new
  // rewards joined it (opened false) and router-swap could sell them at once
  // at the floor. Now funding after the window elapsed opens a fresh window.
  await tx("S8 proxy set-window-blocks 3", DEPLOYER, PROXY_ID, "set-window", [uintCV(3)], "(ok true)");
  await tx("S8 proxy dia band 0 (router-swap prices on Lazer alone, no DIA push on the fork)", DEPLOYER, PROXY_ID, "set-band", [uintCV(0)], "(ok true)");
  await tx("S8 proxy drains the treasury (S6's recalled sats) so each funding pulls a known amount", DEPLOYER, PROXY_ID, "drain", [uintCV(FUND + 1301n)], "(ok true)");
  await ev("S8 treasury holds 0 sats", VAULT_ID, sbtcBal(REWARDS_TREASURY), "(ok u0)");
  await ev("S8 start: empty, no clock", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none");
  await tx("S8a 3 sats land in the treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(3), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  await tx("S8a empty vault: fund-from-treasury opens as before (opened true)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(amount u3)") && v.includes("(opened true)"));
  const s8a = await ev("S8a batch-start = this burn height", VAULT_ID, "(var-get batch-start)", (v) => /^\(some u\d+\)$/.test(v));
  await ev("S8a batch-start is the current burn height", VAULT_ID, "(is-eq (var-get batch-start) (some burn-block-height))", "true");
  await tx("S8b 5 sats land in the treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(5), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  await advance(1);
  await ev("S8b window still open one block later", VAULT_ID, "(window-open)", "true");
  await tx("S8b window open: funding joins the batch (opened false)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(amount u5)") && v.includes("(opened false)"));
  const s8b = await ev("S8b batch-start unchanged", VAULT_ID, "(var-get batch-start)", () => true);
  await ev("S8b batch-start is now behind the burn height", VAULT_ID, "(is-eq (var-get batch-start) (some burn-block-height))", "false");
  await status("S8b 8 sats of dust home, not empty (DUST_SATS is 2)", (v) => field(v, "sbtc-balance") === "u8" && field(v, "empty") === "false");
  await advance(3);
  await ev("S8c window elapsed on the 8-sat dust", VAULT_ID, "(window-elapsed)", "true");
  await tx("S8c new rewards: 1M sats land in the treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(FUND), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  await tx("S8c elapsed + dust: funding opens a fresh window (opened true)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND})`) && v.includes("(opened true)"));
  const s8c = await ev("S8c batch-start moved", VAULT_ID, "(var-get batch-start)", () => true);
  await ev("S8c batch-start is the current burn height", VAULT_ID, "(is-eq (var-get batch-start) (some burn-block-height))", "true");
  await ev("S8c window open again", VAULT_ID, "(get-clock)", (v) => field(v, "window-open") === "true" && field(v, "window-elapsed") === "false");
  await tx("S8c router-swap on the new rewards -> u16031 (they rest at the mid first)", STRANGER, VAULT_ID, "router-swap", [UPD], "(err u16031)");
  await tx("S8c jing-reclaim -> u16031", STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], "(err u16031)");
  // S8d the re-arm guard still holds: an elapsed window with MORE than
  // ROUTER_SLACK_SATS (8) left is sellable, so 1 sat of funding joins it
  await advance(3);
  await ev("S8d window elapsed on 1,000,008 sats (sellable, not dust)", VAULT_ID, "(window-elapsed)", "true");
  await tx("S8d 1 sat lands in the treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(1), standardPrincipalCV(SBTC_WHALE), P(REWARDS_TREASURY), noneCV()], "(ok true)");
  await tx("S8d elapsed + more than 8 sats: funding joins (opened false)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(amount u1)") && v.includes("(opened false)"));
  const s8d = await ev("S8d batch-start unchanged", VAULT_ID, "(var-get batch-start)", () => true);
  await ev("S8d still elapsed: no re-arm", VAULT_ID, "(window-elapsed)", "true");
  await tx("S8 proxy recall -> ok, clock clears", DEPLOYER, PROXY_ID, "recall", [], (v) => ok(v) && v.includes(`(amount u${FUND + 9n})`));
  await tx("S8 proxy dia band back to 1000", DEPLOYER, PROXY_ID, "set-band", [uintCV(1000)], "(ok true)");

  check("S8b funding while open kept batch-start", `${s8a.raw} -> ${s8b.raw}`, () => s8a.raw === s8b.raw);
  check("S8c funding after elapse moved batch-start forward", `${s8b.raw} -> ${s8c.raw}`, () => bare(s8c.raw) > bare(s8b.raw));
  check("S8d 1-sat funding after elapse kept batch-start", `${s8c.raw} -> ${s8d.raw}`, () => s8c.raw === s8d.raw);
  check(`S4 the treasury received exactly ${FUND + 101n} sats`, bare(trAfter.raw) - bare(trBefore.raw), (d) => d === FUND + 101n);
  writeResult("clock-keyless", st, S);
}
main().catch((e) => { console.error(e); process.exit(1); });
