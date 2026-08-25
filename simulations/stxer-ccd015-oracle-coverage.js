// stxer-ccd015-oracle-coverage.js
// SELF-VERIFYING stxer mainnet-fork harness for ccd015-redemption-book-mia
// v0.4.0 (DIA price + native miner-commit band). Every step is asserted;
// exit code 1 on any failure.
//
// How the DAO gate is simulated: base-dao is patched with addSetContractCode
// so `is-extension` also returns true for ccd015 and for a tiny proxy
// contract that plays the role of a passed proposal (update-par, set-allowed
// on the rewards treasury, set-band-enabled, set-coinbase-ustx, set-paused).
// Nothing in ccd015 itself is modified: the contract under test is the
// production source, deployed as Clarity 5 (stxer max; the source only uses
// Clarity-5 constructs).
//
// DIA is impersonated by sending set-multiple-values from its real updater
// key (the simulator derives tx-sender from the sender field, no signature).
//
// Phase 1 (probe) reads native vs DIA at coinbase 1000 and 500 and picks the
// coinbase that lands DIA inside the band, reporting both. Phase 2 runs the
// coverage on that setting.
//
// Run: node simulations/stxer-ccd015-oracle-coverage.js
import fs from "node:fs";
import {
  ClarityVersion,
  uintCV,
  boolCV,
  noneCV,
  listCV,
  tupleCV,
  stringAsciiCV,
  contractPrincipalCV,
  standardPrincipalCV,
  deserializeCV,
  cvToString,
} from "@stacks/transactions";
import { SimulationBuilder, getSimulationResult } from "stxer";

const NODE = process.env.STACKS_API_URL || "http://77.42.3.101/stacks-api";

// --- actors (mainnet, impersonated on the fork; balances 2026-08-25) ---
const DEPLOYER = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22"; // 274 STX
const WHALE_A = "SP3HXJJMJQ06GNAZ8XWDN1QM48JEDC6PP6W3YZPZJ"; // 1.64B MIA
const WHALE_B = "SP22WH53NS94VR6N145ZX77BK4S0EWFBE41VW3Z6B"; // 739M MIA
const WHALE_C = "SP1MGH8BH1KRY49Z7EE5TY0JVKT6C3NT9RTVM8FND"; // 124M MIA
const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2"; // 40.8 sBTC
const STRANGER = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM"; // permissionless trigger
const DIA_UPDATER = "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0"; // real DIA updater key

const DAO = "SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH";
const BASE_DAO = `${DAO}.base-dao`;
const REWARDS_TREASURY = `${DAO}.ccd002-treasury-mia-rewards-v3`;
const MIA = "SP1H1733V5MZ3SZ9XRW9FKYGEZT0JDGEB8Y634C7R.miamicoin-token-v2";
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const DIA = `${DIA_UPDATER}.dia-oracle`;

const CONTRACT_NAME = "ccd015-redemption-book-mia";
const CID = `${DEPLOYER}.${CONTRACT_NAME}`;
const PROXY_NAME = "sim-dao-proxy";
const PROXY_CID = `${DEPLOYER}.${PROXY_NAME}`;

const MICRO = 1_000_000n;
const M = (mia) => BigInt(mia) * MICRO; // MIA -> micro-MIA

// --- offers: A and B below par, C far above par (skipped, stays) ---
const OFFER_A = { who: WHALE_A, amount: M(5_000_000), btc: 1_200_000n }; // 240k sats / 1M MIA
const OFFER_B = { who: WHALE_B, amount: M(3_000_000), btc: 900_000n }; // 300k sats / 1M MIA
const OFFER_C = { who: WHALE_C, amount: M(1_000_000), btc: 2_000_000n }; // 2M sats / 1M MIA (> par)
const TREASURY_FUND = 1_500_000n; // via fund-from-treasury: fills A, partial B (300k)
const DIRECT_FUND = 100_000n; // plain transfer: partial B again
const ORACLE_FUND = 50_000n; // present while the oracle cases run (must NOT be spent)

// --- helpers ---
const [sbtcAddr, sbtcName] = SBTC.split(".");
const [diaAddr, diaName] = DIA.split(".");
const [trAddr, trName] = REWARDS_TREASURY.split(".");
const [cAddr, cName] = CID.split(".");
const [bdAddr, bdName] = BASE_DAO.split(".");
const [pAddr, pName] = PROXY_CID.split(".");

const miaBal = (a) => `(contract-call? '${MIA} get-balance '${a})`;
const sbtcBal = (a) => `(contract-call? '${SBTC} get-balance '${a})`;
const decodeTx = (s) => {
  const r = s?.Result?.Transaction;
  if (!r) return "<no transaction result>";
  if ("Err" in r) return `ENGINE-ERR: ${JSON.stringify(r.Err).slice(0, 200)}`;
  try { return cvToString(deserializeCV(r.Ok.result)); } catch (e) { return `decode-failed: ${e.message}`; }
};
const decodeEval = (s) => {
  const r = s?.Result?.Eval;
  if (!r) return "<no eval result>";
  if (!("Ok" in r)) return `ERR: ${JSON.stringify(r.Err).slice(0, 200)}`;
  try { return cvToString(deserializeCV(r.Ok)); } catch { return r.Ok; }
};
const num = (s, key) => BigInt((String(s).match(new RegExp(`\\(${key} u(\\d+)\\)`)) || [])[1] ?? "-1");
const bare = (s) => BigInt((String(s).match(/u(\d+)/) || [])[1] ?? "-1");

async function fetchJson(path) {
  const r = await fetch(`${NODE}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// Proxy = "a passed proposal": an enabled extension that forwards the gated
// calls. contract-caller seen by the targets is this contract.
const PROXY_SRC = `
(define-constant ERR_UNAUTHORIZED (err u999))
(define-public (is-dao-or-extension) (ok true))
(define-public (callback (sender principal) (memo (buff 34))) (ok true))
(define-public (allow-sbtc)
  (contract-call? '${REWARDS_TREASURY} set-allowed '${SBTC} true))
(define-public (update-par)
  (contract-call? '${CID} update-par))
(define-public (set-band (on bool))
  (contract-call? '${CID} set-band-enabled on))
(define-public (set-coinbase (ustx uint))
  (contract-call? '${CID} set-coinbase-ustx ustx))
(define-public (set-paused (p bool))
  (contract-call? '${CID} set-paused p))
`;

function diaPush(stxUsd, btcUsd, tsMs) {
  return listCV([
    tupleCV({ key: stringAsciiCV("STX/USD"), value: uintCV(stxUsd), timestamp: uintCV(tsMs) }),
    tupleCV({ key: stringAsciiCV("BTC/USD"), value: uintCV(btcUsd), timestamp: uintCV(tsMs) }),
  ]);
}

// ---------------------------------------------------------------------
// builder with a parallel assertion plan
// ---------------------------------------------------------------------
function makeBuilder() {
  const plan = [];
  const b = SimulationBuilder.new();
  const api = {
    b, plan,
    deploy(name, source) {
      b.withSender(DEPLOYER).addContractDeploy({ contract_name: name, source_code: source, clarity_version: ClarityVersion.Clarity5 });
      plan.push({ kind: "deploy", label: `deploy ${name}` });
    },
    patch(contract_id, source_code, label, clarity_version) {
      b.addSetContractCode({ contract_id, source_code, clarity_version });
      plan.push({ kind: "patch", label });
    },
    call(label, sender, cid, fn, args, expect, capture) {
      b.withSender(sender).addContractCall({ contract_id: cid, function_name: fn, function_args: args });
      plan.push({ kind: "tx", label, expect, capture });
    },
    evalc(label, code, capture) {
      b.addEvalCode(CID, code);
      plan.push({ kind: "eval", label, capture });
    },
  };
  return api;
}

async function runAndReport(title, api) {
  console.log(`\n=== ${title} ===`);
  const sessionId = await api.b.run();
  const url = `https://stxer.xyz/simulations/mainnet/${sessionId}`;
  console.log(`Submitted. Fetching results...\n${url}\n`);
  const res = await getSimulationResult(sessionId);
  const captured = {};
  let pass = 0, fail = 0;
  res.steps.forEach((s, i) => {
    const p = api.plan[i];
    if (!p) return;
    if (p.kind === "deploy" || p.kind === "patch") {
      const ok = !("Err" in (s?.Result?.SetContractCode || s?.Result?.Transaction || {}));
      console.log(`${ok ? "✅" : "❌"} [${i}] ${p.label}`);
      ok ? pass++ : fail++;
    } else if (p.kind === "tx") {
      const d = decodeTx(s);
      if (p.capture) captured[p.capture] = d;
      const ok = typeof p.expect === "function" ? p.expect(d) : p.expect instanceof RegExp ? p.expect.test(d) : d === p.expect;
      console.log(`${ok ? "✅" : "❌"} [${i}] ${p.label}\n        got ${d.slice(0, 170)}${ok ? "" : `\n        EXPECTED ${p.expect}`}`);
      ok ? pass++ : fail++;
    } else if (p.kind === "eval") {
      const v = decodeEval(s);
      if (p.capture) captured[p.capture] = v;
      console.log(`ℹ️  [${i}] ${p.label}: ${String(v).slice(0, 200)}`);
    }
  });
  return { captured, pass, fail, url };
}

// ---------------------------------------------------------------------
// shared setup: deploy ccd015 + proxy, patch base-dao
// ---------------------------------------------------------------------
async function setup(api, baseDaoPatched, ccd015Src) {
  api.deploy(CONTRACT_NAME, ccd015Src);
  api.deploy(PROXY_NAME, PROXY_SRC);
  // base-dao is a Clarity-1 contract (uses as-contract): keep its version, or
  // the Clarity-5 static check rejects the patch and every gated call 14000s
  api.patch(BASE_DAO, baseDaoPatched, "patch base-dao: is-extension true for ccd015 + proxy", ClarityVersion.Clarity1);
}

async function main() {
  const ccd015Src = fs.readFileSync(`./contracts/extensions/${CONTRACT_NAME}.clar`, "utf8");
  const baseDaoSrc = (await fetchJson(`/extended/v1/contract/${BASE_DAO}`)).source_code;
  const needle = "(default-to false (map-get? Extensions extension))";
  if (!baseDaoSrc.includes(needle)) throw new Error("base-dao is-extension body changed; update the patch");
  const baseDaoPatched = baseDaoSrc.replace(
    needle,
    `(or (default-to false (map-get? Extensions extension)) (is-eq extension '${CID}) (is-eq extension '${PROXY_CID}))`,
  );

  // live DIA values + chain time, so the "sane" pushes mirror reality
  const tip = (await fetchJson(`/extended/v1/block?limit=1`)).results[0];
  const nowSec = BigInt(tip.burn_block_time);
  const hexKey = (k) => { const b = Buffer.from(k); return "0x0d" + b.length.toString(16).padStart(8, "0") + b.toString("hex"); };
  const readDia = async (k) => {
    const r = await fetch(`${NODE}/v2/contracts/call-read/${diaAddr}/${diaName}/get-value`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: DEPLOYER, arguments: [hexKey(k)] }),
    }).then((x) => x.json());
    const cv = deserializeCV(r.result);
    return { value: BigInt(cv.value.value.value.value), ts: BigInt(cv.value.value.timestamp.value) };
  };
  const stx = await readDia("STX/USD");
  const btc = await readDia("BTC/USD");
  console.log(`live DIA: STX/USD ${Number(stx.value) / 1e8}  BTC/USD ${Number(btc.value) / 1e8}  age ${nowSec - stx.ts / 1000n}s  tip ${tip.height}`);
  const FRESH_MS = nowSec * 1000n;
  const STALE_MS = (nowSec - 3n * 3600n) * 1000n;

  // ===================================================================
  // Phase 1: probe native vs DIA at both coinbase values
  // ===================================================================
  const p1 = makeBuilder();
  await setup(p1, baseDaoPatched, ccd015Src);
  p1.evalc("native price @ coinbase 1000 STX", "(get-native-price)", "native1000");
  p1.evalc("get-price @ coinbase 1000 STX", "(get-price)", "price1000");
  p1.call("proxy: set-coinbase 500 STX", DEPLOYER, PROXY_CID, "set-coinbase", [uintCV(500_000_000n)], /^\(ok /);
  p1.evalc("native price @ coinbase 500 STX", "(get-native-price)", "native500");
  p1.evalc("get-price @ coinbase 500 STX", "(get-price)", "price500");
  const r1 = await runAndReport("Phase 1: band probe", p1);
  const inBand1000 = /^\(ok /.test(String(r1.captured.price1000));
  const inBand500 = /^\(ok /.test(String(r1.captured.price500));
  const diaPrice = (btc.value * 100_000_000n) / stx.value;
  console.log(`\nDIA-implied price ${diaPrice}; native@1000 ${bare(r1.captured.native1000)}; native@500 ${bare(r1.captured.native500)}`);
  console.log(`in band @1000: ${inBand1000}   in band @500: ${inBand500}`);
  const COINBASE = inBand1000 ? 1_000_000_000n : 500_000_000n;
  if (!inBand1000 && !inBand500) throw new Error("DIA outside the native band at both coinbase settings");
  console.log(`-> phase 2 runs with coinbase ${COINBASE / 1_000_000n} STX`);

  // ===================================================================
  // Phase 2: full coverage
  // ===================================================================
  const p2 = makeBuilder();
  const { call, evalc } = p2;
  await setup(p2, baseDaoPatched, ccd015Src);
  if (COINBASE !== 1_000_000_000n) {
    call("proxy: set-coinbase to the in-band value", DEPLOYER, PROXY_CID, "set-coinbase", [uintCV(COINBASE)], /^\(ok /);
  }
  // pin DIA to the live values with a fresh timestamp so every later step
  // sees the same rate regardless of how the sim's block time advances
  call("DIA: push live values, fresh", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(stx.value, btc.value, FRESH_MS)], "(ok true)");
  evalc("get-price (sane)", "(get-price)", "price0");
  evalc("supply before", "(get-mia-total-supply)", "supply0");

  // --- gating: nobody but an extension may configure ---
  call("update-par by stranger -> u14000", STRANGER, CID, "update-par", [], "(err u14000)");
  call("set-band-enabled by stranger -> u14000", STRANGER, CID, "set-band-enabled", [boolCV(false)], "(err u14000)");
  call("set-paused by stranger -> u14000", STRANGER, CID, "set-paused", [boolCV(true)], "(err u14000)");

  // --- par not set yet: a funded book still cannot cross ---
  call("sBTC whale sends 50k sats straight to the book", SBTC_WHALE, SBTC, "transfer",
    [uintCV(ORACLE_FUND), standardPrincipalCV(SBTC_WHALE), contractPrincipalCV(cAddr, cName), noneCV()], "(ok true)");
  call("cross-book before update-par -> u14011", STRANGER, CID, "cross-book", [], "(err u14011)");
  call("proxy: update-par -> ok", DEPLOYER, PROXY_CID, "update-par", [], /^\(ok /);
  evalc("par-scaled after snapshot", "(get-par-scaled)", "par");
  evalc("par in uSTX per 1M MIA", "(get-par-ustx-per-1m-mia)", "parUstx");

  // --- offers ---
  call("offer below min-deposit -> u14005", WHALE_A, CID, "place-offer", [uintCV(M(1_000)), uintCV(1_000n)], "(err u14005)");
  call("offer with zero ask -> u14001", WHALE_A, CID, "place-offer", [uintCV(M(200_000)), uintCV(0n)], "(err u14001)");
  call("A offers 5M MIA @ 1.2M sats", WHALE_A, CID, "place-offer", [uintCV(OFFER_A.amount), uintCV(OFFER_A.btc)], "(ok true)");
  call("A duplicate offer -> u14004", WHALE_A, CID, "place-offer", [uintCV(M(200_000)), uintCV(100_000n)], "(err u14004)");
  call("C offers 1M MIA @ 2M sats (above par)", WHALE_C, CID, "place-offer", [uintCV(OFFER_C.amount), uintCV(OFFER_C.btc)], "(ok true)");
  call("B offers 3M MIA @ 900k sats", WHALE_B, CID, "place-offer", [uintCV(OFFER_B.amount), uintCV(OFFER_B.btc)], "(ok true)");
  evalc("book (expect A, B, C cheapest-first)", "(get-offer-book)", "book0");
  evalc("A below par?", `(below-par? u${OFFER_A.amount} u${OFFER_A.btc} (get price (unwrap-panic (get-price))))`, "aBelow");
  evalc("B below par?", `(below-par? u${OFFER_B.amount} u${OFFER_B.btc} (get price (unwrap-panic (get-price))))`, "bBelow");
  evalc("C below par?", `(below-par? u${OFFER_C.amount} u${OFFER_C.btc} (get price (unwrap-panic (get-price))))`, "cBelow");
  evalc("MIA escrowed in book", miaBal(CID), "escrow0");

  // --- oracle failure cases (book funded with 50k, must stay unspent) ---
  call("DIA: stale push (3h old)", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(stx.value, btc.value, STALE_MS)], "(ok true)");
  evalc("get-price stale -> err u14014", "(get-price)", "priceStale");
  call("cross-book on stale DIA -> u14014", STRANGER, CID, "cross-book", [], "(err u14014)");
  call("DIA: fresh but STX/USD x10 (price/10, below band)", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(stx.value * 10n, btc.value, FRESH_MS)], "(ok true)");
  evalc("get-price low -> err u14015", "(get-price)", "priceLow");
  call("cross-book on low DIA -> u14015", STRANGER, CID, "cross-book", [], "(err u14015)");
  call("DIA: fresh but STX/USD /10 (price x10, above band)", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(stx.value / 10n, btc.value, FRESH_MS)], "(ok true)");
  evalc("get-price high -> err u14015", "(get-price)", "priceHigh");
  call("cross-book on high DIA -> u14015", STRANGER, CID, "cross-book", [], "(err u14015)");
  evalc("book sats untouched by the three reverts", sbtcBal(CID), "satsAfterReverts");
  call("proxy: band OFF", DEPLOYER, PROXY_CID, "set-band", [boolCV(false)], /^\(ok /);
  evalc("get-price with band off accepts the x10 price (native u0)", "(get-price)", "priceBandOff");
  call("proxy: band ON", DEPLOYER, PROXY_CID, "set-band", [boolCV(true)], /^\(ok /);
  call("DIA: restore live values, fresh", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(stx.value, btc.value, FRESH_MS)], "(ok true)");
  evalc("get-price sane again", "(get-price)", "priceRestored");

  // --- pause ---
  call("proxy: pause", DEPLOYER, PROXY_CID, "set-paused", [boolCV(true)], /^\(ok /);
  call("cross-book while paused -> u14007", STRANGER, CID, "cross-book", [], "(err u14007)");
  call("place-offer while paused -> u14007", WHALE_A, CID, "place-offer", [uintCV(M(200_000)), uintCV(1_000n)], "(err u14007)");
  call("proxy: unpause", DEPLOYER, PROXY_CID, "set-paused", [boolCV(false)], /^\(ok /);

  // --- funding path 1: rewards treasury -> fund-from-treasury ---
  call("sBTC whale sends 1.5M sats to the rewards treasury", SBTC_WHALE, SBTC, "transfer",
    [uintCV(TREASURY_FUND), standardPrincipalCV(SBTC_WHALE), contractPrincipalCV(trAddr, trName), noneCV()], "(ok true)");
  // sBTC is already on the treasury allowlist on mainnet (ccd014 forwards
  // rewards there); the proxy call is idempotent and proves the gate works.
  evalc("treasury allows sBTC already?", `(contract-call? '${REWARDS_TREASURY} is-allowed '${SBTC})`, "allowed0");
  call("proxy: allow sBTC on the rewards treasury (idempotent)", DEPLOYER, PROXY_CID, "allow-sbtc", [], /^\(ok /);
  call("fund-from-treasury -> ok (1.5M)", STRANGER, CID, "fund-from-treasury", [], (d) => d.includes("fund-from-treasury") && d.includes(`(amount u${TREASURY_FUND})`));
  evalc("book sats = 50k + 1.5M", sbtcBal(CID), "sats1");
  evalc("A sats before", sbtcBal(WHALE_A), "aBefore");
  evalc("B sats before", sbtcBal(WHALE_B), "bBefore");
  evalc("C sats before", sbtcBal(WHALE_C), "cBefore");

  // --- cross 1: budget 1.55M = A full (1.2M) + B partial (350k); C skipped ---
  const BUDGET1 = ORACLE_FUND + TREASURY_FUND; // 1,550,000
  const B_PART1 = BUDGET1 - OFFER_A.btc; // 350,000 into B
  const B_TAKEN1 = (OFFER_B.amount * B_PART1) / OFFER_B.btc;
  call("cross-book #1 -> A full, B partial, C skipped", STRANGER, CID, "cross-book", [], /^\(ok /, "cross1");
  evalc("book after #1", "(get-offer-book)", "book1");
  evalc("A sats after", sbtcBal(WHALE_A), "aAfter");
  evalc("B sats after", sbtcBal(WHALE_B), "bAfter");
  evalc("C sats after", sbtcBal(WHALE_C), "cAfter");
  evalc("book sats after #1 (0)", sbtcBal(CID), "sats2");
  evalc("supply after #1", "(get-mia-total-supply)", "supply1");
  evalc("MIA escrowed after #1", miaBal(CID), "escrow1");
  evalc("info after #1", "(get-info)", "info1");
  call("cross-book with empty budget -> u14010", STRANGER, CID, "cross-book", [], "(err u14010)");

  // --- funding path 2: plain transfer, partial B again ---
  const B_REM_AMT = OFFER_B.amount - B_TAKEN1;
  const B_REM_BTC = OFFER_B.btc - B_PART1;
  const B_TAKEN2 = (B_REM_AMT * DIRECT_FUND) / B_REM_BTC;
  call("sBTC whale sends 100k sats straight to the book", SBTC_WHALE, SBTC, "transfer",
    [uintCV(DIRECT_FUND), standardPrincipalCV(SBTC_WHALE), contractPrincipalCV(cAddr, cName), noneCV()], "(ok true)");
  call("cross-book #2 -> B partial again", STRANGER, CID, "cross-book", [], /^\(ok /, "cross2");
  evalc("book after #2", "(get-offer-book)", "book2");
  evalc("supply after #2", "(get-mia-total-supply)", "supply2");

  // --- only above-par left: cross finds nothing ---
  call("B cancels the remainder", WHALE_B, CID, "cancel-offer", [], "(ok true)");
  call("sBTC whale sends 10k sats", SBTC_WHALE, SBTC, "transfer",
    [uintCV(10_000n), standardPrincipalCV(SBTC_WHALE), contractPrincipalCV(cAddr, cName), noneCV()], "(ok true)");
  call("cross-book with only C (above par) -> u14006", STRANGER, CID, "cross-book", [], "(err u14006)");
  call("C cancels -> refund", WHALE_C, CID, "cancel-offer", [], "(ok true)");
  evalc("book empty", "(get-offer-count)", "count3");
  evalc("no MIA left in escrow", miaBal(CID), "escrow3");

  const r2 = await runAndReport("Phase 2: coverage", p2);
  const c = r2.captured;
  let pass = r1.pass + r2.pass, fail = r1.fail + r2.fail;
  const check = (label, got, want) => {
    const ok = got === want;
    console.log(`${ok ? "✅" : "❌"} ${label}: ${got}${ok ? "" : ` (want ${want})`}`);
    ok ? pass++ : fail++;
  };
  console.log("\n--- numeric cross-checks ---");
  const price = num(c.price0, "price");
  check("get-price == BTC_USD*1e8/STX_USD (unit math)", price, diaPrice);
  check("get-price restored == initial", num(c.priceRestored, "price"), price);
  check("band off: native reported as u0", num(c.priceBandOff, "native"), 0n);
  check("stale -> u14014", String(c.priceStale), "(err u14014)");
  check("low -> u14015", String(c.priceLow), "(err u14015)");
  check("high -> u14015", String(c.priceHigh), "(err u14015)");
  check("A below par", String(c.aBelow), "true");
  check("B below par", String(c.bBelow), "true");
  check("C NOT below par", String(c.cBelow), "false");
  const orderOk = [WHALE_A, WHALE_B, WHALE_C].map((w) => String(c.book0).indexOf(w));
  check("book order A < B < C", orderOk[0] > -1 && orderOk[0] < orderOk[1] && orderOk[1] < orderOk[2], true);
  check("escrow == A+B+C", bare(c.escrow0), OFFER_A.amount + OFFER_B.amount + OFFER_C.amount);
  check("oracle reverts spent nothing (50k intact)", bare(c.satsAfterReverts), ORACLE_FUND);
  check("book sats before cross #1", bare(c.sats1), BUDGET1);
  check("cross #1 spent == budget", num(c.cross1, "spent"), BUDGET1);
  check("cross #1 acquired == A + B partial", num(c.cross1, "acquired"), OFFER_A.amount + B_TAKEN1);
  check("A paid exactly its ask", bare(c.aAfter) - bare(c.aBefore), OFFER_A.btc);
  check("B paid the partial", bare(c.bAfter) - bare(c.bBefore), B_PART1);
  check("C paid nothing", bare(c.cAfter) - bare(c.cBefore), 0n);
  check("book sats 0 after #1", bare(c.sats2), 0n);
  check("supply shrank by acquired (burn)", bare(c.supply0) - bare(c.supply1), OFFER_A.amount + B_TAKEN1);
  check("escrow after #1 == B remainder + C", bare(c.escrow1), B_REM_AMT + OFFER_C.amount);
  check("B remainder amount on book", String(c.book1).includes(`(amount u${B_REM_AMT})`), true);
  check("B remainder ask on book", String(c.book1).includes(`(btc u${B_REM_BTC})`), true);
  check("C still on book after #1", String(c.book1).includes(WHALE_C), true);
  check("total-burned-mia recorded", num(c.info1, "total-burned-mia"), OFFER_A.amount + B_TAKEN1);
  check("total-spent-sats recorded", num(c.info1, "total-spent-sats"), BUDGET1);
  check("cross #2 spent == 100k", num(c.cross2, "spent"), DIRECT_FUND);
  check("cross #2 acquired == pro-rata of B remainder", num(c.cross2, "acquired"), B_TAKEN2);
  check("supply shrank again by cross #2", bare(c.supply1) - bare(c.supply2), B_TAKEN2);
  check("book empty at the end", bare(c.count3), 0n);
  check("no MIA stranded in escrow", bare(c.escrow3), 0n);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  console.log(`Phase 1: ${r1.url}\nPhase 2: ${r2.url}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
