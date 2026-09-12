// stxer-ccd016-v2-coverage.js
// SELF-VERIFYING stxer mainnet-fork harness for ccd016-swap-vault-mia-v2
// (0.3.0: zero-spread peg on markets-sbtc-stx-jing-v6, community = three
// steps, DAO = the precise tools). Nothing of the next Jing stack is on
// mainnet, so the fork deploys it first under chavita from the jing repo
// sources (JING_SRC): jing-core-v5, markets-sbtc-stx-jing-v6 (ONE sim-only
// patch: MAX_STALENESS widened so the single real Lazer update survives the
// block advance), swap-router-sbtc-stx-jing-v5. Then the ccd015 STX book and
// the vault at the same deployer (the vault binds the book relatively).
//
// The DAO gate is simulated as in stxer-ccd015-oracle-coverage.js: base-dao
// is patched so is-extension is true for the vault (the treasury withdraw)
// and for a proxy contract that plays a passed proposal. DIA is impersonated
// from its real updater key with the Lazer prices, so Pyth and DIA agree.
//
// Covers: fund-from-treasury opens the window; jing-place in two chunks rests
// a zero-spread peg (order (some u0), floor = mid - leeway, price = mid);
// window gates (take / router-swap / reclaim refused, refloor DAO-only and
// working); a taker fills the vault at the mid (exact STX received); fuel-
// fair-book; window elapse by proposal + block advance; reclaim by anyone;
// router-swap by anyone at the floor; DAO-only take against a resting bid;
// setters gated and range-checked; recall to the treasury; idle.
//
// Run: PYTH_API_KEY=<key> node simulations/stxer-ccd016-v2-coverage.js
import fs from "node:fs";
import {
  ClarityVersion, uintCV, boolCV, noneCV, listCV, tupleCV, stringAsciiCV, bufferCV, trueCV, falseCV,
  contractPrincipalCV, standardPrincipalCV, deserializeCV, cvToString,
} from "@stacks/transactions";
import { SimulationBuilder, getSimulationResult } from "stxer";

const NODE = process.env.STACKS_API_URL || "http://77.42.3.101/stacks-api";
const JING_SRC = process.env.JING_SRC || `${process.env.HOME}/projects/jing-contracts-v3/contracts`;

const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22"; // chavita: the jing deployer, and the vault + book here
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const STX_WHALE = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
const STRANGER = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM";
const DIA_UPDATER = "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0";
const DAO = "SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH";
const BASE_DAO = `${DAO}.base-dao`;
const REWARDS_TREASURY = `${DAO}.ccd002-treasury-mia-rewards-v3`;
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const WSTX = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
const DIA = `${DIA_UPDATER}.dia-oracle`;

const CORE = "jing-core-v5", MKT = "markets-sbtc-stx-jing-v6", ROUTER = "swap-router-sbtc-stx-jing-v5";
const BOOK = "ccd015-redemption-book-mia-stx", VAULT = "ccd016-swap-vault-mia-v2", PROXY = "sim-dao-proxy";
const CORE_ID = `${DEPLOYER}.${CORE}`, MKT_ID = `${DEPLOYER}.${MKT}`, BOOK_ID = `${DEPLOYER}.${BOOK}`, VAULT_ID = `${DEPLOYER}.${VAULT}`, PROXY_ID = `${DEPLOYER}.${PROXY}`;
const [sbtcAddr, sbtcName] = SBTC.split("."), [wstxAddr, wstxName] = WSTX.split("."), [trAddr, trName] = REWARDS_TREASURY.split(".");
const sbtcT = contractPrincipalCV(sbtcAddr, sbtcName), wstxT = contractPrincipalCV(wstxAddr, wstxName);
const PP = 100_000_000n, PPDF = PP * 100n, BPS = 10_000n, HUGE = 999_999_999_999_999n;
const FUND = 1_000_000n; // sats into the treasury, then the vault
const TAKE_STX = 100_000_000n; // the taker's gross STX
const src = (f) => fs.readFileSync(f, "utf8");
const sbtcBal = (a) => `(contract-call? '${SBTC} get-balance '${a})`;
const decodeTx = (s) => { const r = s?.Result?.Transaction; if (!r) return "<no tx>"; if ("Err" in r) return `ENGINE-ERR: ${JSON.stringify(r.Err).slice(0, 200)}`; if (r.Ok?.vm_error) return `VM-ERR: ${r.Ok.vm_error}`; try { return cvToString(deserializeCV(r.Ok.result)); } catch (e) { return `decode-failed: ${e.message}`; } };
const decodeEval = (s) => { const r = s?.Result?.Eval; if (!r) return "<no eval>"; if (!("Ok" in r)) return `ERR: ${JSON.stringify(r.Err).slice(0, 200)}`; try { return cvToString(deserializeCV(r.Ok)); } catch { return r.Ok; } };
const num = (s, key) => BigInt((String(s).match(new RegExp(`\\(${key} u(\\d+)\\)`)) || [])[1] ?? "-1");
const bare = (s) => BigInt((String(s).match(/u(\d+)/) || [])[1] ?? "-1");
const field = (s, k) => (String(s).match(new RegExp(`\\(${k} (u?\\d+|none|true|false|\\(some u\\d+\\))\\)`)) || [])[1];

async function fetchJson(path) { const r = await fetch(`${NODE}${path}`); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); }
async function fetchLazerUpdate() {
  const key = process.env.PYTH_API_KEY;
  if (!key) throw new Error("PYTH_API_KEY is required");
  const r = await fetch("https://pyth-lazer.dourolabs.app/v1/latest_price", { method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ priceFeedIds: [1, 45], properties: ["price", "exponent", "confidence", "publisherCount", "feedUpdateTimestamp"], formats: ["evm"], channel: "fixed_rate@1000ms", jsonBinaryEncoding: "hex" }) });
  if (!r.ok) throw new Error(`Lazer ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const f = Object.fromEntries(j.parsed.priceFeeds.map((e) => [e.priceFeedId, e]));
  return { hex: j.evm.data, px: BigInt(f[1].price), py: BigInt(f[45].price), ts: Number(j.parsed.timestampUs) / 1e6 };
}
const diaPush = (stxUsd, btcUsd, tsMs) => listCV([
  tupleCV({ key: stringAsciiCV("STX/USD"), value: uintCV(stxUsd), timestamp: uintCV(tsMs) }),
  tupleCV({ key: stringAsciiCV("BTC/USD"), value: uintCV(btcUsd), timestamp: uintCV(tsMs) }),
]);

// the proxy = a passed proposal: an enabled extension that forwards the DAO-only calls
const PROXY_SRC = `
(define-public (is-dao-or-extension) (ok true))
(define-public (callback (sender principal) (memo (buff 34))) (ok true))
(define-public (allow-sbtc) (contract-call? '${REWARDS_TREASURY} set-allowed '${SBTC} true))
(define-public (refloor (update (buff 8192))) (contract-call? '${VAULT_ID} jing-refloor update))
(define-public (take (amount uint) (update (buff 8192))) (contract-call? '${VAULT_ID} jing-take amount update))
(define-public (set-window (blocks uint)) (contract-call? '${VAULT_ID} set-window-blocks blocks))
(define-public (recall) (contract-call? '${VAULT_ID} dao-recall-sbtc))
`;

let checks = 0, failures = 0;
function check(label, actual, want) {
  checks += 1;
  const ok = typeof want === "function" ? want(actual) : want instanceof RegExp ? want.test(String(actual)) : String(actual) === want;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${String(actual).slice(0, 170)}${ok ? "" : ` (want ${typeof want === "function" ? want.toString().slice(0, 90) : want})`}`);
}

async function main() {
  console.log("=== ccd016-swap-vault-mia-v2 on the next Jing stack (core-v5, market v6, router v5), mainnet fork ===");
  const lz = await fetchLazerUpdate();
  const UPD = bufferCV(Buffer.from(lz.hex, "hex"));
  const MID = (lz.px * PP) / lz.py;
  const tip = (await fetchJson(`/extended/v1/block?limit=1`)).results[0];
  const FRESH_MS = BigInt(tip.burn_block_time) * 1000n;
  console.log(`Lazer mid ${MID} (1 STX ~ ${(10n ** 16n) / MID} sats); DIA impersonated with the same prices; tip ${tip.height}`);

  // sources
  const coreSrc = src(`${JING_SRC}/${CORE}.clar`);
  let mktSrc = src(`${JING_SRC}/${MKT}.clar`);
  if (!mktSrc.includes("(define-constant MAX_STALENESS u80)")) throw new Error("MAX_STALENESS anchor missing");
  mktSrc = mktSrc.replace("(define-constant MAX_STALENESS u80)", "(define-constant MAX_STALENESS u999999999)");
  const routerSrc = src(`${JING_SRC}/${ROUTER}.clar`);
  const bookSrc = src(`./contracts/extensions/${BOOK}.clar`);
  const vaultSrc = src(`./contracts/extensions/${VAULT}.clar`);
  if (!vaultSrc.includes(`.${MKT})`) || !vaultSrc.includes(`.${ROUTER})`)) throw new Error("vault does not bind market v6 / router v5");
  const baseDaoSrc = (await fetchJson(`/extended/v1/contract/${BASE_DAO}`)).source_code;
  const needle = "(default-to false (map-get? Extensions extension))";
  if (!baseDaoSrc.includes(needle)) throw new Error("base-dao is-extension body changed; update the patch");
  const baseDaoPatched = baseDaoSrc.replace(needle, `(or (default-to false (map-get? Extensions extension)) (is-eq extension '${VAULT_ID}) (is-eq extension '${PROXY_ID}))`);

  // ---- expected numbers ----
  const LEEWAY = 500n, SLIPPAGE = 100n;
  const FLOOR = (MID * (BPS - LEEWAY)) / BPS;
  const REB = (TAKE_STX * 20n) / BPS, NET = TAKE_STX - REB;
  const XC = (NET * PPDF) / MID; // sats the taker buys at mid (y binding: the vault's 1M sats is far bigger)
  const STX_TO_VAULT = NET - NET / 1000n + REB; // net - 10 bps fee + the whole rebate rides (single x maker)
  if (XC >= FUND) throw new Error("sizing: 100 STX must be worth under 1M sats");

  // ---- builder with a plan ----
  const plan = [];
  let b = SimulationBuilder.new({ stacksNodeAPI: NODE });
  const deploy = (name, code, cv = ClarityVersion.Clarity5) => { b = b.withSender(DEPLOYER).addContractDeploy({ contract_name: name, source_code: code, clarity_version: cv }); plan.push({ kind: "deploy", label: `deploy ${name}` }); };
  const patch = (cid, code, label, cv) => { b = b.addSetContractCode({ contract_id: cid, source_code: code, clarity_version: cv }); plan.push({ kind: "patch", label }); };
  const tx = (label, sender, cid, fn, args, want) => { b = b.withSender(sender).addContractCall({ contract_id: cid, function_name: fn, function_args: args }); plan.push({ kind: "tx", label, want }); };
  const ev = (label, cid, code, want) => { b = b.addEvalCode(cid, code); const slot = { kind: "eval", label, want }; plan.push(slot); return slot; };
  const advance = (btc) => { b = b.addAdvanceBlocks({ bitcoin_blocks: btc, stacks_blocks_per_bitcoin: 1 }); plan.push({ kind: "advance", label: `advance ${btc} bitcoin blocks` }); };
  const ok = (v) => String(v).startsWith("(ok");

  // ---- S0 the stack ----
  deploy(CORE, coreSrc); deploy(MKT, mktSrc);
  tx("core-v5 verifies market v6", DEPLOYER, CORE_ID, "set-verified-contract", [contractPrincipalCV(DEPLOYER, MKT)], "(ok true)");
  tx("market v6 initialize", DEPLOYER, MKT_ID, "initialize", [contractPrincipalCV(DEPLOYER, MKT), sbtcT, wstxT, uintCV(1000), uintCV(1_000_000), uintCV(1), uintCV(45)], "(ok true)");
  deploy(ROUTER, routerSrc);
  deploy(BOOK, bookSrc);
  deploy(VAULT, vaultSrc);
  deploy(PROXY, PROXY_SRC);
  patch(BASE_DAO, baseDaoPatched, "patch base-dao: is-extension true for the vault + proxy", ClarityVersion.Clarity1);
  tx("DIA: push the Lazer prices, fresh", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(lz.py, lz.px, FRESH_MS)], "(ok true)");
  ev("S0 config binds market v6 + router v5", VAULT_ID, "(get-config)", (v) => v.includes(MKT_ID) && v.includes(`${DEPLOYER}.${ROUTER}`) && v.includes(BOOK_ID));
  ev("S0 idle", VAULT_ID, "(is-idle)", "true");

  // ---- S1 funding from the treasury opens the window ----
  tx("S1 sBTC whale sends 1M sats to the rewards treasury", SBTC_WHALE, SBTC, "transfer", [uintCV(FUND), standardPrincipalCV(SBTC_WHALE), contractPrincipalCV(trAddr, trName), noneCV()], "(ok true)");
  tx("S1 proxy allows sBTC on the treasury (idempotent)", DEPLOYER, PROXY_ID, "allow-sbtc", [], ok);
  tx("S1 stranger fund-from-treasury -> 1M sats into the vault, window opens", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes(`(amount u${FUND})`));
  ev("S1 window open", VAULT_ID, "(window-open)", "true");
  ev("S1 vault holds 1M sats", VAULT_ID, "(get-status)", (v) => field(v, "sbtc-balance") === `u${FUND}` && field(v, "idle") === "false");
  tx("S1 start-clock while open -> u16031", STRANGER, VAULT_ID, "start-clock", [], "(err u16031)");

  // ---- S2 the community places, in chunks ----
  tx("S2 stranger jing-place 400k", STRANGER, VAULT_ID, "jing-place", [uintCV(400_000), UPD], (v) => ok(v) && v.includes(`(floor u${FLOOR})`));
  tx("S2 stranger jing-place 600k (merges)", STRANGER, VAULT_ID, "jing-place", [uintCV(600_000), UPD], ok);
  tx("S2 jing-place more than the vault holds -> u16006", STRANGER, VAULT_ID, "jing-place", [uintCV(1), UPD], "(err u16006)");
  ev("S2 market order: zero-spread peg, floor = mid - 5%", MKT_ID, `(get-token-x-order '${VAULT_ID})`, (v) => field(v, "spread-bps") === "(some u0)" && field(v, "limit") === `u${FLOOR}`);
  ev("S2 the vault's price is the mid", MKT_ID, `(token-x-limit-at '${VAULT_ID} u${MID})`, `u${MID}`);
  ev("S2 status: 1M resting, 0 home", VAULT_ID, "(get-status)", (v) => field(v, "jing-resting") === `u${FUND}` && field(v, "sbtc-balance") === "u0");

  // ---- S3 gates while the window is open ----
  tx("S3 stranger jing-take -> u16000 (DAO only)", STRANGER, VAULT_ID, "jing-take", [uintCV(1000), UPD], "(err u16000)");
  tx("S3 proxy jing-take while open -> u16031", DEPLOYER, PROXY_ID, "take", [uintCV(1000), UPD], "(err u16031)");
  tx("S3 stranger router-swap while open -> u16031", STRANGER, VAULT_ID, "router-swap", [uintCV(1000), UPD], "(err u16031)");
  tx("S3 stranger jing-reclaim while open -> u16031", STRANGER, VAULT_ID, "jing-reclaim", [], "(err u16031)");
  tx("S3 stranger jing-refloor -> u16000 (DAO only)", STRANGER, VAULT_ID, "jing-refloor", [UPD], "(err u16000)");
  tx("S3 proxy jing-refloor -> ok (floor re-read from the mid)", DEPLOYER, PROXY_ID, "refloor", [UPD], (v) => ok(v) && v.includes(`(floor u${FLOOR})`));
  ev("S3 order still a zero-spread peg", MKT_ID, `(get-token-x-order '${VAULT_ID})`, (v) => field(v, "spread-bps") === "(some u0)");
  tx("S3 stranger set-window-blocks -> u16000", STRANGER, VAULT_ID, "set-window-blocks", [uintCV(1)], "(err u16000)");
  tx("S3 proxy set-window-blocks 2000 -> u16033 (cap 1008)", DEPLOYER, PROXY_ID, "set-window", [uintCV(2000)], "(err u16033)");

  // ---- S4 a taker buys the vault's sBTC at the mid ----
  tx(`S4 STX whale sells ${TAKE_STX / 1_000_000n} STX (taker): the vault fills at the mid`, STX_WHALE, MKT_ID, "swap", [uintCV(TAKE_STX), uintCV(HUGE), UPD, sbtcT, stringAsciiCV("sbtc-token"), wstxT, stringAsciiCV("wstx"), falseCV()], ok);
  ev("S4 settlement at the mid", MKT_ID, "(get price (unwrap-panic (get-settlement u0)))", `u${MID}`);
  ev(`S4 vault: ${FUND - XC} sats still resting, ${STX_TO_VAULT} uSTX home`, VAULT_ID, "(get-status)", (v) => field(v, "jing-resting") === `u${FUND - XC}` && field(v, "stx-balance") === `u${STX_TO_VAULT}`);
  ev("S4 the peg rolled into cycle u1 with its rule", MKT_ID, `(get-token-x-order '${VAULT_ID})`, (v) => field(v, "spread-bps") === "(some u0)");

  // ---- S5 STX only ever goes to the book ----
  ev("S5 book STX before", BOOK_ID, `(stx-get-balance '${BOOK_ID})`, () => true);
  const bookBefore = plan[plan.length - 1];
  tx("S5 stranger fuel-fair-book", STRANGER, VAULT_ID, "fuel-fair-book", [], (v) => ok(v) && v.includes(`(amount u${STX_TO_VAULT})`) && v.includes(BOOK_ID));
  ev("S5 book STX after", BOOK_ID, `(stx-get-balance '${BOOK_ID})`, () => true);
  const bookAfter = plan[plan.length - 1];
  ev("S5 vault STX 0", VAULT_ID, "(get-status)", (v) => field(v, "stx-balance") === "u0");
  tx("S5 fuel-fair-book with nothing -> u16006", STRANGER, VAULT_ID, "fuel-fair-book", [], "(err u16006)");

  // ---- S6 the window elapses: proposal shortens it, the chain moves on ----
  tx("S6 proxy set-window-blocks 1", DEPLOYER, PROXY_ID, "set-window", [uintCV(1)], "(ok true)");
  advance(2);
  ev("S6 window elapsed", VAULT_ID, "(window-elapsed)", "true");
  tx("S6 jing-place after the window -> u16030", STRANGER, VAULT_ID, "jing-place", [uintCV(1000), UPD], "(err u16030)");

  // ---- S7 liquidation by anyone ----
  tx(`S7 stranger jing-reclaim -> ${FUND - XC} sats home`, STRANGER, VAULT_ID, "jing-reclaim", [], (v) => ok(v) && v.includes(`(amount u${FUND - XC})`));
  ev("S7 status: nothing resting, sats home", VAULT_ID, "(get-status)", (v) => field(v, "jing-resting") === "u0" && field(v, "sbtc-balance") === `u${FUND - XC}`);
  tx("S7 router-swap over the chunk cap -> u16039", STRANGER, VAULT_ID, "router-swap", [uintCV(5_000_001), UPD], "(err u16039)");
  tx("S7 stranger router-swap 300k sats at the floor (book empty: pools)", STRANGER, VAULT_ID, "router-swap", [uintCV(300_000), UPD], (v) => ok(v) && bare((String(v).match(/\(out (u\d+)\)/) || [])[1]) > 0n);
  ev("S7 vault got STX from the pools", VAULT_ID, "(get-status)", (v) => bare(field(v, "stx-balance")) > 0n);
  tx("S7 stranger fuel-fair-book again", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);

  // ---- S8 DAO-only take against a resting bid ----
  tx("S8 STX whale rests a 200 STX bid at the mid", STX_WHALE, MKT_ID, "deposit-token-y", [uintCV(200_000_000), uintCV(HUGE), noneCV(), UPD, wstxT, stringAsciiCV("wstx")], "(ok u200000000)");
  tx("S8 stranger jing-take after the window -> still u16000", STRANGER, VAULT_ID, "jing-take", [uintCV(50_000), UPD], "(err u16000)");
  tx("S8 proxy jing-take 50k sats -> fills at the mid (FOK)", DEPLOYER, PROXY_ID, "take", [uintCV(50_000), UPD], (v) => ok(v) && bare((String(v).match(/\(out (u\d+)\)/) || [])[1]) > 0n);
  ev("S8 vault STX from the take", VAULT_ID, "(get-status)", (v) => bare(field(v, "stx-balance")) > 0n);

  // ---- S9 recall: sBTC only ever goes back to the treasury ----
  ev("S9 treasury sats before recall", VAULT_ID, sbtcBal(REWARDS_TREASURY), () => true);
  const trBefore = plan[plan.length - 1];
  tx("S9 stranger dao-recall-sbtc -> u16000", STRANGER, VAULT_ID, "dao-recall-sbtc", [], "(err u16000)");
  tx("S9 proxy recall -> ok", DEPLOYER, PROXY_ID, "recall", [], ok);
  ev("S9 treasury sats after recall", VAULT_ID, sbtcBal(REWARDS_TREASURY), () => true);
  const trAfter = plan[plan.length - 1];
  ev("S9 vault sats 0", VAULT_ID, "(get-status)", (v) => field(v, "sbtc-balance") === "u0");
  tx("S9 stranger fuel-fair-book (the take's STX)", STRANGER, VAULT_ID, "fuel-fair-book", [], ok);
  ev("S9 idle again", VAULT_ID, "(is-idle)", "true");

  // ---- run ----
  const sid = await b.run();
  console.log(`View: https://stxer.xyz/simulations/mainnet/${sid}\n`);
  const res = await getSimulationResult(sid);
  const s = res.steps; let i = 0;
  for (const p of plan) {
    if (p.kind === "deploy" || p.kind === "patch" || p.kind === "advance") {
      const st = s[i++]; const r = st?.Result || {};
      const okStep = !("Err" in (r.SetContractCode || r.Transaction || r.AdvanceBlocks || {})) && !r.Transaction?.Ok?.vm_error;
      check(p.label, okStep ? "ok" : JSON.stringify(r).slice(0, 160), "ok");
      continue;
    }
    while (i < s.length && !s[i]?.Result?.Transaction && !s[i]?.Result?.Eval) i += 1;
    const raw = p.kind === "tx" ? decodeTx(s[i]) : decodeEval(s[i]); i += 1;
    p.raw = raw;
    if (typeof p.want === "function" && p.want.length === 0) { console.log(`  ..   ${p.label}: ${String(raw).slice(0, 120)}`); continue; }
    check(p.label, raw, p.want);
  }
  check(`S5 the book received exactly ${STX_TO_VAULT} uSTX`, bare(bookAfter.raw) - bare(bookBefore.raw), (d) => d === STX_TO_VAULT);
  check("S9 the treasury received the recalled sats", bare(trAfter.raw) - bare(trBefore.raw), (d) => d > 0n);
  console.log(`\n${checks - failures}/${checks} checks green`);
  if (failures > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
