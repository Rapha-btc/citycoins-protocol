// stxer-ccd016-v2-clock-keyless.js
// SELF-VERIFYING stxer mainnet-fork harness for the CLOCK of
// ccd016-swap-vault-mia-v2 (bounty mu0oy1vzf432efb13c31, Patient Reed /
// Celestial Mast: a free start-clock, or 1 sat into the treasury plus
// fund-from-treasury, re-armed the patience window forever on leftovers).
// NO PYTH KEY: nothing is placed on the book (jing-place needs a Lazer
// update); the sats stay home, the window is shortened by proposal and the
// chain advanced, and every clock path is exercised on the leftovers.
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
// the band to 0, a stranger cannot, a restore proposal puts 1000 back.
//
// Run: node simulations/stxer-ccd016-v2-clock-keyless.js
import fs from "node:fs";
import {
  ClarityVersion, uintCV, noneCV, stringAsciiCV, bufferCV, trueCV,
  contractPrincipalCV, standardPrincipalCV, deserializeCV, cvToString,
} from "@stacks/transactions";
import { SimulationBuilder, getSimulationResult } from "stxer";
const NODE = process.env.STACKS_API_URL || "http://77.42.3.101/stacks-api";
const JING_SRC = process.env.JING_SRC || `${process.env.HOME}/projects/jing-contracts-v3/contracts`;
const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22"; // chavita: the jing deployer, the rungs, and the vault + book here
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const STRANGER = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM";
const DAO = "SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH";
const BASE_DAO = `${DAO}.base-dao`;
const REWARDS_TREASURY = `${DAO}.ccd002-treasury-mia-rewards-v3`;
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const WSTX = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
const CORE = "jing-core-v5", LADDER = "jing-ladder", MKT = "markets-sbtc-stx-jing-v6", ROUTER = "swap-router-sbtc-stx-jing-v5";
const RUNG_SRC_FILE = "jing-buy-stx-core-spread";
const SPREADS = [0, 10, 20, 30];
const RUNG = (bps) => `jing-buy-stx-spread-${bps}`;
const RUNG_ID = (bps) => `${DEPLOYER}.${RUNG(bps)}`;
const BOOK = "ccd015-redemption-book-mia-stx", VAULT = "ccd016-swap-vault-mia-v2", PROXY = "sim-dao-proxy";
const CORE_ID = `${DEPLOYER}.${CORE}`, LADDER_ID = `${DEPLOYER}.${LADDER}`, MKT_ID = `${DEPLOYER}.${MKT}`;
const BOOK_ID = `${DEPLOYER}.${BOOK}`, VAULT_ID = `${DEPLOYER}.${VAULT}`, PROXY_ID = `${DEPLOYER}.${PROXY}`;
const [sbtcAddr, sbtcName] = SBTC.split("."), [wstxAddr, wstxName] = WSTX.split("."), [trAddr, trName] = REWARDS_TREASURY.split(".");
const sbtcT = contractPrincipalCV(sbtcAddr, sbtcName), wstxT = contractPrincipalCV(wstxAddr, wstxName);
const FUND = 1_000_000n; // sats into the treasury, then the vault
const Q = FUND / 4n;
const NO_UPDATE = bufferCV(Buffer.from("00", "hex"));
const src = (f) => fs.readFileSync(f, "utf8");
const sbtcBal = (a) => `(contract-call? '${SBTC} get-balance '${a})`;
const decodeTx = (s) => { const r = s?.Result?.Transaction; if (!r) return "<no tx>"; if ("Err" in r) return `ENGINE-ERR: ${JSON.stringify(r.Err).slice(0, 200)}`; if (r.Ok?.vm_error) return `VM-ERR: ${r.Ok.vm_error}`; try { return cvToString(deserializeCV(r.Ok.result)); } catch (e) { return `decode-failed: ${e.message}`; } };
const decodeEval = (s) => { const r = s?.Result?.Eval; if (!r) return "<no eval>"; if (!("Ok" in r)) return `ERR: ${JSON.stringify(r.Err).slice(0, 200)}`; try { return cvToString(deserializeCV(r.Ok)); } catch { return r.Ok; } };
const bare = (s) => BigInt((String(s).match(/u(\d+)/) || [])[1] ?? "-1");
const field = (s, k) => (String(s).match(new RegExp(`\\(${k} (u?\\d+|none|true|false|\\(some u\\d+\\))\\)`)) || [])[1];
async function fetchJson(path) { const r = await fetch(`${NODE}${path}`); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); }
// the proxy = a passed proposal: an enabled extension that forwards the DAO-only calls
const PROXY_SRC = `
(define-public (is-dao-or-extension) (ok true))
(define-public (callback (sender principal) (memo (buff 34))) (ok true))
(define-public (allow-sbtc) (contract-call? '${REWARDS_TREASURY} set-allowed '${SBTC} true))
(define-public (take (amount uint) (update (buff 8192))) (contract-call? '${VAULT_ID} jing-take amount update))
(define-public (set-window (blocks uint)) (contract-call? '${VAULT_ID} set-window-blocks blocks))
(define-public (recall) (contract-call? '${VAULT_ID} dao-recall-sbtc))
(define-public (reclaim) (contract-call? '${VAULT_ID} dao-reclaim))
(use-trait proposal-trait '${DAO}.proposal-trait.proposal-trait)
(define-public (run (p <proposal-trait>)) (contract-call? '${BASE_DAO} execute p tx-sender))
`;
// the restore, inline: the mirror of the DIA-band-off proposal
const RESTORE_SRC = `
(impl-trait '${DAO}.proposal-trait.proposal-trait)
(define-public (execute (sender principal))
  (begin
    (try! (contract-call? '${VAULT_ID} set-dia-band-bps u1000))
    (ok true)
  )
)
`;
let checks = 0, failures = 0;
function check(label, actual, want) {
  checks += 1;
  const ok = typeof want === "function" ? want(actual) : want instanceof RegExp ? want.test(String(actual)) : String(actual) === want;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${String(actual).slice(0, 170)}${ok ? "" : ` (want ${typeof want === "function" ? want.toString().slice(0, 90) : want})`}`);
}
async function main() {
  console.log("=== ccd016-swap-vault-mia-v2 CLOCK on the next Jing stack, mainnet fork, keyless ===");
  const tip = (await fetchJson(`/extended/v1/block?limit=1`)).results[0];
  console.log(`tip ${tip.height}`);

  // sources
  const coreSrc = src(`${JING_SRC}/${CORE}.clar`), ladderSrc = src(`${JING_SRC}/${LADDER}.clar`);
  const mktSrc = src(`${JING_SRC}/${MKT}.clar`), routerSrc = src(`${JING_SRC}/${ROUTER}.clar`);
  const bookSrc = src(`./contracts/extensions/${BOOK}.clar`);
  const vaultSrc = src(`./contracts/extensions/${VAULT}.clar`);
  const PROP = "ccip027-ccd016-dia-band-off", PROP_ID = `${DEPLOYER}.${PROP}`, RESTORE = "ccip-ccd016-dia-band-restore", RESTORE_ID = `${DEPLOYER}.${RESTORE}`;
  const propSrc = src(`./contracts/proposals/${PROP}.clar`);
  if (!propSrc.includes(".ccd016-swap-vault-mia-v2 set-dia-band-bps u0")) throw new Error("proposal does not set the band to 0");
  const baseDaoSrc = (await fetchJson(`/extended/v1/contract/${BASE_DAO}`)).source_code;
  const needle = "(default-to false (map-get? Extensions extension))";
  if (!baseDaoSrc.includes(needle)) throw new Error("base-dao is-extension body changed; update the patch");
  const baseDaoPatched = baseDaoSrc.replace(needle, `(or (default-to false (map-get? Extensions extension)) (is-eq extension '${VAULT_ID}) (is-eq extension '${PROXY_ID}))`);

  // ---- builder with a plan ----
  const plan = [];
  let b = SimulationBuilder.new({ stacksNodeAPI: NODE });
  const deploy = (name, code, cv = ClarityVersion.Clarity5) => { b = b.withSender(DEPLOYER).addContractDeploy({ contract_name: name, source_code: code, clarity_version: cv }); plan.push({ kind: "deploy", label: `deploy ${name}` }); };
  const patch = (cid, code, label, cv) => { b = b.addSetContractCode({ contract_id: cid, source_code: code, clarity_version: cv }); plan.push({ kind: "patch", label }); };
  const tx = (label, sender, cid, fn, args, want) => { b = b.withSender(sender).addContractCall({ contract_id: cid, function_name: fn, function_args: args }); plan.push({ kind: "tx", label, want }); };
  const ev = (label, cid, code, want) => { b = b.addEvalCode(cid, code); const slot = { kind: "eval", label, want }; plan.push(slot); return slot; };
  const advance = (btc) => { b = b.addAdvanceBlocks({ bitcoin_blocks: btc, stacks_blocks_per_bitcoin: 1 }); plan.push({ kind: "advance", label: `advance ${btc} bitcoin blocks` }); };
  const ok = (v) => String(v).startsWith("(ok");
  const err = (v) => String(v).startsWith("(err");
  const status = (label, want) => ev(label, VAULT_ID, "(get-status)", want);
  const resting = (v) => bare(field(v, "jing-resting"));

  // ---- S0 the stack ----
  deploy(CORE, coreSrc); deploy(LADDER, ladderSrc); deploy(MKT, mktSrc);
  tx("core-v5 verifies market v6", DEPLOYER, CORE_ID, "set-verified-contract", [contractPrincipalCV(DEPLOYER, MKT)], "(ok true)");
  tx("market v6 initialize", DEPLOYER, MKT_ID, "initialize", [contractPrincipalCV(DEPLOYER, MKT), sbtcT, wstxT, uintCV(1000), uintCV(1_000_000), uintCV(1), uintCV(45)], "(ok true)");
  deploy(ROUTER, routerSrc);
  deploy(BOOK, bookSrc);
  deploy(VAULT, vaultSrc);
  deploy(PROXY, PROXY_SRC);
  patch(BASE_DAO, baseDaoPatched, "patch base-dao: vault + proxy are extensions", ClarityVersion.Clarity2);
  ev("S0 empty", VAULT_ID, "(is-empty)", "true");
  ev("S0 no clock", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none" && field(v, "window-open") === "false" && field(v, "window-elapsed") === "false");
  tx("S0 close-batch with no clock -> u16032", STRANGER, VAULT_ID, "close-batch", [], "(err u16032)");

  // ---- S1 funding an empty vault opens the window ----
  tx("S1 sBTC whale sends 1M sats to the rewards treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(FUND), standardPrincipalCV(SBTC_WHALE), contractPrincipalCV(trAddr, trName), noneCV()], "(ok true)");
  tx("S1 proxy allows sBTC on the treasury (idempotent)", DEPLOYER, PROXY_ID, "allow-sbtc", [], ok);
  tx("S1 stranger fund-from-treasury -> 1M sats in, window opens (vault was empty)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND})`) && v.includes("(opened true)"));
  const c1 = ev("S1 clock: open", VAULT_ID, "(get-clock)", (v) => field(v, "window-open") === "true" && field(v, "window-elapsed") === "false");
  status("S1 1M home, not empty", (v) => field(v, "sbtc-balance") === `u${FUND}` && field(v, "empty") === "false");
  tx("S1 a top-up while open: 100 sats to the treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(100), standardPrincipalCV(SBTC_WHALE), contractPrincipalCV(trAddr, trName), noneCV()], "(ok true)");
  tx("S1 fund-from-treasury while open -> joins, opens nothing", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(amount u100)") && v.includes("(opened false)"));
  const c1b = ev("S1 clock unchanged by the top-up", VAULT_ID, "(get-clock)", (v) => field(v, "window-open") === "true");
  tx("S1 reclaim while open -> u16031", STRANGER, VAULT_ID, "jing-reclaim", [], "(err u16031)");

  // ---- S2 the window elapses: proposal shortens it, the chain moves on ----
  tx("S2 proxy set-window-blocks 1", DEPLOYER, PROXY_ID, "set-window", [uintCV(1)], "(ok true)");
  advance(2);
  ev("S2 window elapsed, leftovers home", VAULT_ID, "(get-clock)", (v) => field(v, "window-open") === "false" && field(v, "window-elapsed") === "true");
  status("S2 1,000,100 home, not empty", (v) => field(v, "sbtc-balance") === `u${FUND + 100n}` && field(v, "empty") === "false");

  // ---- S3 the re-arm (Reed / Mast): refused on leftovers ----
  ev("S3 start-clock is gone: no function to re-arm with", VAULT_ID, "(window-elapsed)", "true");
  tx("S3 1 sat lands in the treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(1), standardPrincipalCV(SBTC_WHALE), contractPrincipalCV(trAddr, trName), noneCV()], "(ok true)");
  tx("S3 fund-from-treasury on a non-empty vault -> pulls the sat, opens nothing (was: re-armed)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(amount u1)") && v.includes("(opened false)"));
  ev("S3 still elapsed: the sat joined the liquidation phase", VAULT_ID, "(window-elapsed)", "true");
  status("S3 1,000,101 home", (v) => field(v, "sbtc-balance") === `u${FUND + 101n}`);
  tx("S3 close-batch while not empty -> u16043", STRANGER, VAULT_ID, "close-batch", [], "(err u16043)");
  tx("S3 jing-reclaim with nothing on the book -> the market's refusal (nothing to cancel)", STRANGER, VAULT_ID, "jing-reclaim", [], (v) => String(v).startsWith("(err"));

  // ---- S4 recall empties the vault and clears the clock ----
  const trBefore = ev("S4 treasury sats before recall", VAULT_ID, sbtcBal(REWARDS_TREASURY), () => true);
  tx("S4 stranger dao-recall-sbtc -> u16000", STRANGER, VAULT_ID, "dao-recall-sbtc", [], "(err u16000)");
  tx("S4 proxy recall -> ok", DEPLOYER, PROXY_ID, "recall", [], (v) => ok(v) && v.includes(`(amount u${FUND + 101n})`));
  const trAfter = ev("S4 treasury sats after recall", VAULT_ID, sbtcBal(REWARDS_TREASURY), () => true);
  status("S4 vault sats 0, empty", (v) => field(v, "sbtc-balance") === "u0" && field(v, "empty") === "true");
  ev("S4 the exit cleared the clock", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none" && field(v, "window-open") === "false" && field(v, "window-elapsed") === "false");
  tx("S4 close-batch with no clock -> u16032", STRANGER, VAULT_ID, "close-batch", [], "(err u16032)");
  tx("S4 fuel-fair-book with nothing -> u16006", STRANGER, VAULT_ID, "fuel-fair-book", [], "(err u16006)");

  // ---- S5 the next funding opens a fresh window ----
  tx("S5 the treasury has the recalled sats: fund again -> fresh window (opened true)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND + 101n})`) && v.includes("(opened true)"));
  ev("S5 window open", VAULT_ID, "(window-open)", "true");
  tx("S5 proxy recall again -> ok, clock clears", DEPLOYER, PROXY_ID, "recall", [], ok);
  ev("S5 clock cleared", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none");

  // ---- S6 a plain transfer into an EMPTY vault: no clock of its own, it joins the next funding ----
  tx("S6 whale sends 1000 sats straight to the empty vault", SBTC_WHALE, SBTC, "transfer", [uintCV(1000), standardPrincipalCV(SBTC_WHALE), contractPrincipalCV(DEPLOYER, VAULT), noneCV()], "(ok true)");
  ev("S6 no clock: neither open nor elapsed", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none" && field(v, "window-open") === "false" && field(v, "window-elapsed") === "false");
  tx("S6 reclaim with no clock -> u16031", STRANGER, VAULT_ID, "jing-reclaim", [], "(err u16031)");
  tx("S6 close-batch while not empty -> u16043", STRANGER, VAULT_ID, "close-batch", [], "(err u16043)");
  tx("S6 200 sats land in the treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(200), standardPrincipalCV(SBTC_WHALE), contractPrincipalCV(trAddr, trName), noneCV()], "(ok true)");
  tx("S6 fund-from-treasury: vault not empty but no clock -> opens (the stray sats join)", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND + 301n})`) && v.includes("(opened true)")); // the treasury still holds S5's recalled sats
  ev("S6 window open", VAULT_ID, "(window-open)", "true");
  status("S6 1,001,301 home", (v) => field(v, "sbtc-balance") === `u${FUND + 1301n}`);
  tx("S6 proxy set-window-blocks 1", DEPLOYER, PROXY_ID, "set-window", [uintCV(1)], "(ok true)");
  advance(2);
  ev("S6 elapsed", VAULT_ID, "(window-elapsed)", "true");
  tx("S6 proxy recall -> ok, the clock clears with the vault", DEPLOYER, PROXY_ID, "recall", [], (v) => ok(v) && v.includes(`(amount u${FUND + 1301n})`));
  ev("S6 clock cleared, empty", VAULT_ID, "(get-clock)", (v) => field(v, "batch-start") === "none");
  ev("S6 empty", VAULT_ID, "(is-empty)", "true");

  // ---- S7 the DIA escape hatch: a real proposal through base-dao execute ----
  deploy(PROP, propSrc); deploy(RESTORE, RESTORE_SRC);
  ev("S7 dia band 1000 before", VAULT_ID, "(get dia-band-bps (get-config))", "u1000");
  tx("S7 stranger calls the proposal's execute directly -> the vault refuses (u16000: not the DAO)", STRANGER, PROP_ID, "execute", [standardPrincipalCV(STRANGER)], "(err u16000)");
  tx("S7 the proxy (an enabled extension) runs it through base-dao execute -> ok", DEPLOYER, PROXY_ID, "run", [contractPrincipalCV(DEPLOYER, PROP)], "(ok true)");
  ev("S7 dia band 0: the vault prices on Lazer alone", VAULT_ID, "(get dia-band-bps (get-config))", "u0");
  tx("S7 the same proposal again -> base-dao refuses a proposal already executed", DEPLOYER, PROXY_ID, "run", [contractPrincipalCV(DEPLOYER, PROP)], err);
  tx("S7 the restore proposal through base-dao -> ok", DEPLOYER, PROXY_ID, "run", [contractPrincipalCV(DEPLOYER, RESTORE)], "(ok true)");
  ev("S7 dia band back to 1000", VAULT_ID, "(get dia-band-bps (get-config))", "u1000");

  // ---- run ----
  const sid = await b.run();
  console.log(`View: https://stxer.xyz/simulations/mainnet/${sid}\n`);
  const res = await getSimulationResult(sid);
  const s = res.steps; let i = 0;
  for (const p of plan) {
    if (p.kind === "deploy" || p.kind === "patch" || p.kind === "advance") {
      const st = s[i++]; const r = st?.Result || {};
      const okStep = !("Err" in (r.SetContractCode || r.Transaction || r.AdvanceBlocks || {})) && !r.Transaction?.Ok?.vm_error;
      check(p.label, okStep ? "ok" : JSON.stringify(r).slice(0, 220), "ok");
      continue;
    }
    while (i < s.length && !s[i]?.Result?.Transaction && !s[i]?.Result?.Eval) i += 1;
    const raw = p.kind === "tx" ? decodeTx(s[i]) : decodeEval(s[i]); i += 1;
    p.raw = raw;
    if (typeof p.want === "function" && p.want.length === 0) { console.log(`  ..   ${p.label}: ${String(raw).slice(0, 120)}`); continue; }
    check(p.label, raw, p.want);
  }
  check(`S4 the treasury received exactly ${FUND + 101n} sats`, bare(trAfter.raw) - bare(trBefore.raw), (d) => d === FUND + 101n);
  console.log(`\n${checks - failures}/${checks} checks green`);
  if (failures > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
