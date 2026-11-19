// Shared setup for the ccd016 v2 harnesses on the LIVE Jing stack this branch's
// vault binds: markets-sbtc-stx-jing-v6-5 + swap-router-sbtc-stx-jing-v5-6 at
// their real principals and live state (no fresh v6-3 stack, no aliases).
// Mainnet fork only: unsigned simulated senders, nothing is broadcast.
//
// Fixtures kept from the v2 harnesses (disclosed in each file): base-dao is
// patched (SetContractCode) so is-extension is true for the vault and for a
// proxy contract that plays a passed proposal; DIA is pushed from its real
// updater key with the Lazer prices.
//
// Steps run one at a time on one session (callContract / submitSimulationSteps)
// so a harness can branch on live state: on the live book an X deposit goes
// pending while the Y list is non-empty, and the keeper settles it.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { cvToString, deserializeCV, bufferCV, contractPrincipalCV, standardPrincipalCV, stringAsciiCV, ClarityVersion } from "@stacks/transactions";
import { SimulationBuilder, getSimulationResult, getSimulationTip, submitSimulationSteps, callContract, getNonce, setSender } from "stxer";
import { makeUnsignedSTXTokenTransfer } from "@stacks/transactions";

export const NODE = process.env.STACKS_API_URL || "http://77.42.3.101/stacks-api";
process.env.STACKS_API_URL ||= NODE;
const JING_SIM = process.env.JING_SIM || `${process.env.HOME}/projects/jing-contracts-v3/simulations`;
const { fetchLazerUpdateAny, lazerFeedTimes } = await import(`${JING_SIM}/_lazer.js`);
export const DEP = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
export const MKT = "markets-sbtc-stx-jing-v6-5", ROUTER = "swap-router-sbtc-stx-jing-v5-6";
export const MKT_ID = `${DEP}.${MKT}`, ROUTER_ID = `${DEP}.${ROUTER}`;
export const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
export const WSTX = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
export const DAO = "SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH";
export const BASE_DAO = `${DAO}.base-dao`;
export const P = (s) => (s.includes(".") ? contractPrincipalCV(...s.split(".")) : standardPrincipalCV(s));

export const strip = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*;;/.test(l)).join("\n");
export const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const cv = (hex) => cvToString(deserializeCV(hex));
export async function fetchJson(p) { const r = await fetch(`${NODE}${p}`); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); }

export function assertVaultBindsLive(vaultSrc) {
  if (!vaultSrc.includes(`'${MKT_ID})`) || !vaultSrc.includes(`'${ROUTER_ID})`)) throw new Error(`vault does not bind live ${MKT} / ${ROUTER}`);
}

export async function patchedBaseDao(...extensions) {
  const src = (await fetchJson(`/extended/v1/contract/${BASE_DAO}`)).source_code;
  const needle = "(default-to false (map-get? Extensions extension))";
  if (!src.includes(needle)) throw new Error("base-dao is-extension body changed; update the patch");
  return src.replace(needle, `(or (default-to false (map-get? Extensions extension)) ${extensions.map((e) => `(is-eq extension '${e})`).join(" ")})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A real signed Lazer [1,45] update whose feeds are newer than `notBefore`
// (the fork clock): age 0 on the fork, so the market's rebate is the base
// 20 bps and router-swap's stale-update guard (u16048) passes.
export async function freshUpdate(notBefore) {
  for (let i = 0; i < 200; i++) {
    const now = Date.now() / 1000;
    if (now < notBefore + 2) { await sleep(Math.min(15_000, (notBefore + 3 - now) * 1000)); continue; }
    const u = await fetchLazerUpdateAny();
    const at = (await lazerFeedTimes(u.hex)).at;
    if (at > notBefore) return { ...u, at, hex: u.hex.replace(/^0x/, ""), cv: bufferCV(Buffer.from(u.hex.replace(/^0x/, ""), "hex")), mid: (u.px * 100_000_000n) / u.py };
    await sleep(2000);
  }
  throw new Error("no Lazer update newer than the fork clock");
}

// Deploy `deploys` ([name, source]) as DEP and run `patches` ([contractId,
// source, clarityVersion]), at FORK_BLOCK or the node tip. Returns the session
// and step helpers bound to the harness's `check`.
export async function liveSession({ deploys, patches = [], check }) {
  const tip = process.env.FORK_BLOCK ? await fetchJson(`/extended/v1/block/by_height/${process.env.FORK_BLOCK}`) : (await fetchJson("/extended/v1/block?limit=1")).results[0];
  let b = SimulationBuilder.new({ stacksNodeAPI: NODE }).useBlockHeight(tip.height).withSender(DEP);
  for (const [name, source] of deploys) b = b.withSender(DEP).addContractDeploy({ contract_name: name, source_code: source, clarity_version: ClarityVersion.Clarity6 });
  for (const [id, source, ver] of patches) b = b.addSetContractCode({ contract_id: id, source_code: source, clarity_version: ver ?? ClarityVersion.Clarity1 });
  const sid = await b.run();
  const url = `https://stxer.xyz/simulations/mainnet/${sid}`;
  console.log(`View: ${url}`);
  const steps = (await getSimulationResult(sid)).steps.filter((s) => s.Result?.Transaction || s.Result?.SetContractCode);
  deploys.forEach(([name], i) => { const t = steps[i]?.Result?.Transaction; check(`deploy ${name}`, t?.Ok && !t.Ok.vm_error ? "ok" : JSON.stringify(steps[i]).slice(0, 200), "ok"); });
  patches.forEach(([id], i) => { const s = steps[deploys.length + i]?.Result?.SetContractCode; check(`patch ${id}`, s && !("Err" in s) ? "ok" : JSON.stringify(s).slice(0, 200), "ok"); });
  const tip0 = await getSimulationTip(sid);
  const record = [];
  const decodeEval = (r) => (r?.Eval && "Ok" in r.Eval ? cv(r.Eval.Ok) : `EVAL-ERR ${JSON.stringify(r?.Eval?.Err ?? r).slice(0, 200)}`);
  const judge = (slot) => {
    record.push({ label: slot.label, raw: slot.raw });
    if (typeof slot.want === "function" && slot.want.length === 0) { console.log(`  ..   ${slot.label}: ${String(slot.raw).slice(0, 160)}`); return slot; }
    if (slot.want !== undefined) check(slot.label, slot.raw, slot.want);
    return slot;
  };
  const prints = (r) => (r.receipt?.events ?? []).map((e) => (typeof e === "string" ? JSON.parse(e) : e))
    .filter((e) => e.contract_event?.raw_value).map((e) => `${e.contract_event.contract_identifier}: ${cv(e.contract_event.raw_value)}`).join(" | ");
  async function tx(label, sender, contract, fn, args, want) {
    const r = await callContract(sid, { sender, contract, functionName: fn, functionArgs: args, fee: 0 });
    const raw = r.vmError ? `VM-ERR: ${r.vmError}` : r.pcAborted ? "post-condition-aborted" : r.result;
    return judge({ label, want, raw, prints: prints(r), receipt: r });
  }
  async function ev(label, contract, code, want) {
    const out = await submitSimulationSteps(sid, { steps: [{ Eval: [DEP, "", contract, code] }] });
    return judge({ label, want, raw: decodeEval(out.steps[0]?.Result ?? out.steps[0]) });
  }
  async function advance(btc, secs = 1) {
    const r = await submitSimulationSteps(sid, { steps: [{ AdvanceBlocks: { bitcoin_blocks: btc, stacks_blocks_per_bitcoin: 1, bitcoin_interval_secs: secs } }] });
    const bad = r.steps.some((s) => s.Result?.AdvanceBlocks?.Err);
    check(`advance ${btc} bitcoin blocks`, bad ? JSON.stringify(r).slice(0, 200) : "ok", "ok");
  }
  // jing-place / top-ups on the live book go pending while the Y list is
  // non-empty: the keeper (DEP, as on mainnet) settles the vault's deposit.
  async function settleXIfPending(label, who, update) {
    const pend = await ev(`${label}: vault deposit pending?`, MKT_ID, `(is-some (get-token-x-pending-deposit '${who}))`, () => true);
    if (pend.raw !== "true") return null;
    return tx(`${label}: keeper settle-token-x-deposit`, DEP, MKT_ID, "settle-token-x-deposit", [P(who), update, P(SBTC), stringAsciiCV("sbtc-token")], (v) => String(v).startsWith("(ok"));
  }
  async function settleYIfPending(label, who, update) {
    const pend = await ev(`${label}: bid pending?`, MKT_ID, `(is-some (get-token-y-pending-deposit '${who}))`, () => true);
    if (pend.raw !== "true") return null;
    return tx(`${label}: keeper settle-token-y-deposit`, DEP, MKT_ID, "settle-token-y-deposit", [P(who), update, P(WSTX), stringAsciiCV("wstx")], (v) => String(v).startsWith("(ok"));
  }
  async function settleXLimitIfPending(label, who, update) {
    const pend = await ev(`${label}: limit pending?`, MKT_ID, `(is-some (get-token-x-pending-limit '${who}))`, () => true);
    if (pend.raw !== "true") return null;
    return tx(`${label}: keeper settle-token-x-limit`, DEP, MKT_ID, "settle-token-x-limit", [P(who), update], (v) => String(v).startsWith("(ok"));
  }
  // a real STX transfer from `from` (unsigned simulated sender)
  async function stxTo(label, from, to, amount) {
    const raw = await makeUnsignedSTXTokenTransfer({ recipient: to, amount: BigInt(amount), nonce: await getNonce(sid, from), network: "mainnet", publicKey: "", fee: 0 });
    setSender(raw, from);
    const out = await submitSimulationSteps(sid, { steps: [{ Transaction: raw.serialize() }] });
    const t = out.steps[0]?.Result?.Transaction?.Ok ?? out.steps[0]?.Transaction?.Ok;
    const raw2 = t && !t.vm_error ? cv(t.result) : `ENGINE-ERR ${JSON.stringify(out.steps[0]).slice(0, 200)}`;
    return judge({ label, want: (v) => String(v).startsWith("(ok"), raw: raw2, receipt: { receipt: t } });
  }
  return { sid, url, tip, tip0, tx, ev, advance, stxTo, settleXIfPending, settleYIfPending, settleXLimitIfPending, record, getTip: () => getSimulationTip(sid) };
}

// ---- small shared helpers for the ported harnesses ----
import { uintCV as _u, listCV as _l, tupleCV as _t, stringAsciiCV as _s } from "@stacks/transactions";
export const STX_WHALE = process.env.STX_WHALE || "SP3HXJJMJQ06GNAZ8XWDN1QM48JEDC6PP6W3YZPZJ"; // real holder with liquid STX (SP9BP4... is empty since 2026-11)
export const SBTC_WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
export const STRANGER = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM";
export const DIA_UPDATER = "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0";
export const DIA = `${DIA_UPDATER}.dia-oracle`;
export const REWARDS_TREASURY = `${DAO}.ccd002-treasury-mia-rewards-v3`;
export const num = (s, key) => BigInt((String(s).match(new RegExp(`\\(${key} u(\\d+)\\)`)) || [])[1] ?? "-1");
export const bare = (s) => BigInt((String(s).match(/u(\d+)/) || [])[1] ?? "-1");
export const field = (s, k) => (String(s).match(new RegExp(`\\(${k} (u?\\d+|none|true|false|\\(some u\\d+\\))\\)`)) || [])[1];
export const diaPush = (stxUsd, btcUsd, tsMs) => _l([
  _t({ key: _s("STX/USD"), value: _u(stxUsd), timestamp: _u(tsMs) }),
  _t({ key: _s("BTC/USD"), value: _u(btcUsd), timestamp: _u(tsMs) }),
]);
export function makeCheck() {
  const st = { checks: 0, failures: 0, failed: [] };
  st.check = (label, actual, want) => {
    st.checks += 1;
    const ok = typeof want === "function" ? want(actual) : want instanceof RegExp ? want.test(String(actual)) : String(actual) === want;
    if (!ok) { st.failures += 1; st.failed.push(label); }
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${String(actual).slice(0, 170)}${ok ? "" : ` (want ${typeof want === "function" ? want.toString().slice(0, 90) : want})`}`);
  };
  return st;
}
export function writeResult(name, st, S, extra = {}) {
  console.log(`\n${st.checks - st.failures}/${st.checks} checks green${st.failed.length ? `; FAILED: ${st.failed.join("; ")}` : ""}\n${S.url}`);
  const dir = process.env.SIM_RESULTS_DIR || "simulations/results/ccd016-v2";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify({ simulationId: S.sid, url: S.url, checks: st.checks, failures: st.failures, failed: st.failed, liveStack: { market: MKT_ID, router: ROUTER_ID }, fork: S.tip0, vaultSha256: sha("contracts/extensions/ccd016-swap-vault-mia-v2.clar"), bookSha256: sha("contracts/extensions/ccd015-redemption-book-mia-stx.clar"), ...extra, steps: S.record }, null, 2) + "\n");
  if (st.failures > 0) process.exitCode = 1;
}
