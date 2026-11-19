// stxer-ccd016-v2-parked.js
// SELF-VERIFYING stxer mainnet-fork harness for ccd016-swap-vault-mia-v2 on
// the LIVE Jing stack the vault binds (markets-sbtc-stx-jing-v6-5 +
// swap-router-sbtc-stx-jing-v5-6, real principals, live state). 2026-11-18
// port of the v6-3 version; shared setup in simulations/_vault-live-v6-5.mjs.
//
// FIXTURES (disclosed, unchanged): base-dao patched (SetContractCode) so
// is-extension is true for the vault and a proxy that plays a passed
// proposal; DIA pushed from its real updater key; fillers are fresh keys
// funded by a real sBTC holder.
//
// The vault PARKED on the live book. The open region of the X side is 40
// makers (50 slots minus the 10 seats the market reserves for the seated
// band rungs, which sit outside it). The harness reads how many non-seated
// makers rest live, adds fillers (2,000-sat pegs at the mid) until the open
// region is full with the vault (1,000 sats, the market minimum, smallest),
// then a 5,000-sat in-range newcomer parks the vault. On the live book every
// X deposit goes pending (the Y side is non-empty); the keeper settles it.
//   P1 status shows jing-parked 1000, jing-resting 0, not empty
//   P2 the DAO reclaims mid-window: the parked amount comes home
//   P3 jing-place again on the full side with the smallest size: settlement
//      refunds it; a filler leaves, jing-place lands; a fresh 5,000 parks it
//   P4 a stranger readmits the vault's parked sats via readmit-token-x once
//      there is room: back on the book at its peg (mid + 1 bp), harmless
//   P5 parked once more, the window elapses, jing-reclaim by anyone brings
//      the PARKED amount home, router-swap (fresh update) sells it, empty
// Run: node simulations/stxer-ccd016-v2-parked.js
import { uintCV, noneCV, someCV, stringAsciiCV, standardPrincipalCV, getAddressFromPrivateKey } from "@stacks/transactions";
import {
  liveSession, freshUpdate, patchedBaseDao, strip, assertVaultBindsLive, makeCheck, writeResult, diaPush, bare, field,
  DEP, MKT_ID, SBTC, P, SBTC_WHALE, STRANGER, DIA, DIA_UPDATER, REWARDS_TREASURY, DAO,
} from "./_vault-live-v6-5.mjs";

const BOOK = "ccd015-redemption-book-mia-stx", VAULT = "ccd016-swap-vault-mia-v2", PROXY = "sim-dao-proxy";
const VAULT_ID = `${DEP}.${VAULT}`, PROXY_ID = `${DEP}.${PROXY}`;
const sbtcT = P(SBTC);
const FILLERS = Array.from({ length: 42 }, (_, i) => getAddressFromPrivateKey((i + 300).toString(16).padStart(64, "0") + "01", "mainnet"));
const FILL = 2_000n;
const FUND = 1_000n; // the market minimum: the vault is the SMALLEST maker in the open region
const PROXY_SRC = `
(define-public (is-dao-or-extension) (ok true))
(define-public (callback (sender principal) (memo (buff 34))) (ok true))
(define-public (allow-sbtc) (contract-call? '${REWARDS_TREASURY} set-allowed '${SBTC} true))
(define-public (set-window (blocks uint)) (contract-call? '${VAULT_ID} set-window-blocks blocks))
(define-public (reclaim) (contract-call? '${VAULT_ID} dao-reclaim none))
`;

const st = makeCheck(), check = st.check;
async function main() {
  console.log("=== ccd016 v2 PARKED on the live Jing v6-5 book (mainnet fork, Lazer) ===");
  const vaultSrc = strip(`contracts/extensions/${VAULT}.clar`); assertVaultBindsLive(vaultSrc);
  const S = await liveSession({ deploys: [[BOOK, strip(`contracts/extensions/${BOOK}.clar`)], [VAULT, vaultSrc], [PROXY, PROXY_SRC]], patches: [[`${DAO}.base-dao`, await patchedBaseDao(VAULT_ID, PROXY_ID)]], check });
  const { tx, ev, advance } = S;
  const lz = await freshUpdate(Number(S.tip0.block_time));
  const UPD = lz.cv, MID = lz.mid;
  console.log(`Lazer mid ${MID}; fork time ${S.tip0.block_time}; update at ${lz.at}`);
  const ok = (v) => String(v).startsWith("(ok");
  const status = (label, want) => ev(label, VAULT_ID, "(get-status)", want);
  const clock = (label, want) => ev(label, VAULT_ID, "(get-clock)", want);
  const FLOOR9 = (MID * 90n) / 100n; // every filler and newcomer: a peg (some u0), floor 10% under the mid
  const PEG = (sats) => [uintCV(sats), uintCV(FLOOR9), someCV(uintCV(0)), sbtcT, stringAsciiCV("sbtc-token")];
  const sbtcXfer = (label, to, sats) => tx(label, SBTC_WHALE, SBTC, "transfer", [uintCV(sats), standardPrincipalCV(SBTC_WHALE), to, noneCV()], "(ok true)");
  const DEPS = "(get-token-x-depositors (get-current-cycle))";
  const OPEN = `(- (len ${DEPS}) (seated-on ${DEPS} (get-seated-x)))`; // private, evaluated inside the market
  const settleX = (label, who, want) => tx(label, STRANGER, MKT_ID, "settle-token-x-deposit", [P(who), UPD, sbtcT, stringAsciiCV("sbtc-token")], want);
  const place = async (label, who, sats) => { await tx(label, who, MKT_ID, "deposit-token-x", PEG(sats), `(ok u${sats})`); await S.settleXIfPending(label, who, UPD); };

  await tx("DIA: push the Lazer prices, fresh", DIA_UPDATER, DIA, "set-multiple-values", [diaPush(lz.py, lz.px, BigInt(S.tip0.block_time) * 1000n)], "(ok true)");
  await tx("proxy allows sBTC on the treasury (idempotent)", DEP, PROXY_ID, "allow-sbtc", [], ok);
  await ev("L0 the market reserves 10 seats per side", MKT_ID, "(protected-seats)", "u10");
  const open0 = bare((await ev("L0 live non-seated makers in the open region", MKT_ID, OPEN, () => true)).raw);
  const NFILL = 40 - Number(open0) - 1;
  check("L0 room for the vault + fillers in the open region", NFILL, (n) => n >= 3);

  // ---- P0 the vault rests 1,000 sats, fillers fill the open region ----
  const tr0 = bare((await ev("P0 treasury sats (live)", SBTC, `(get-balance '${REWARDS_TREASURY})`, () => true)).raw);
  check("P0 the live treasury holds no sBTC (the batch is exactly 1,000)", tr0, (v) => v === 0n);
  await sbtcXfer("P0 whale sends 1,000 sats to the treasury", P(REWARDS_TREASURY), FUND);
  await tx("P0 fund-from-treasury -> window opens", STRANGER, VAULT_ID, "fund-from-treasury", [], (v) => ok(v) && v.includes("(opened true)"));
  await tx("P0 stranger jing-place: 1,000 sats as the peg", STRANGER, VAULT_ID, "jing-place", [UPD], (v) => ok(v) && v.includes(`(amount u${FUND})`));
  await S.settleXIfPending("P0", VAULT_ID, UPD);
  for (const [i, f] of FILLERS.slice(0, NFILL).entries()) {
    await sbtcXfer(`P0 fund filler ${i + 1}`, standardPrincipalCV(f), FILL);
    await place(`P0 filler ${i + 1} rests a 2,000-sat peg at the mid`, f, FILL);
  }
  await ev("P0 open region full: 40 non-seated makers", MKT_ID, OPEN, "u40");
  await status("P0 vault: 1,000 resting", (v) => field(v, "jing-resting") === `u${FUND}` && field(v, "jing-parked") === "u0");

  // ---- P1 a bigger in-range newcomer parks the smallest: the vault ----
  await tx("P1 newcomer (whale) rests a 5,000-sat peg at the mid on the full side", SBTC_WHALE, MKT_ID, "deposit-token-x", PEG(5_000n), "(ok u5000)");
  await settleX("P1 settle the full-side entrant", SBTC_WHALE, "(ok u5000)");
  await ev("P1 the vault is parked with its 1,000 sats", MKT_ID, `(get-token-x-parked '${VAULT_ID})`, `u${FUND}`);
  await ev("P1 nothing of the vault rests", MKT_ID, `(get-token-x-deposit (get-current-cycle) '${VAULT_ID})`, "u0");
  await status("P1 status: parked 1,000, resting 0, not empty", (v) => field(v, "jing-parked") === `u${FUND}` && field(v, "jing-resting") === "u0" && field(v, "sbtc-balance") === "u0" && field(v, "empty") === "false");
  await ev("P1 open region still 40", MKT_ID, OPEN, "u40");

  // ---- P2 the DAO reclaims a PARKED position mid-window ----
  await tx("P2 stranger jing-reclaim while open -> u16031", STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], "(err u16031)");
  await tx("P2 proxy dao-reclaim: the parked amount comes home", DEP, PROXY_ID, "reclaim", [], (v) => ok(v) && v.includes(`(amount u${FUND})`));
  await status("P2 1,000 home, parked 0", (v) => field(v, "sbtc-balance") === `u${FUND}` && field(v, "jing-parked") === "u0" && field(v, "jing-resting") === "u0");

  // ---- P3 re-place on the full side ----
  await tx("P3 jing-place again: smallest size on a full side -> submits", STRANGER, VAULT_ID, "jing-place", [UPD], ok);
  await settleX("P3 settle refunds the too-small entrant", VAULT_ID, `(ok u${FUND})`);
  await status("P3 1,000 still home", (v) => field(v, "sbtc-balance") === `u${FUND}` && field(v, "jing-resting") === "u0");
  await tx("P3 filler 3 cancels: room", FILLERS[2], MKT_ID, "cancel-token-x-deposit", [sbtcT, stringAsciiCV("sbtc-token")], ok);
  await tx("P3 jing-place lands", STRANGER, VAULT_ID, "jing-place", [UPD], (v) => ok(v) && v.includes(`(amount u${FUND})`));
  await S.settleXIfPending("P3", VAULT_ID, UPD);
  await status("P3 1,000 resting again", (v) => field(v, "jing-resting") === `u${FUND}` && field(v, "sbtc-balance") === "u0");
  await ev("P3 open region 40 again", MKT_ID, OPEN, "u40");
  const NEW1 = FILLERS[40], NEW2 = FILLERS[41];
  await sbtcXfer("P3 fund a fresh maker", standardPrincipalCV(NEW1), 5_000n);
  await tx("P3 a fresh 5,000-sat peg: the size rule parks the smallest, the vault", NEW1, MKT_ID, "deposit-token-x", PEG(5_000n), "(ok u5000)");
  await settleX("P3 settle the full-side entrant", NEW1, "(ok u5000)");
  await status("P3 parked 1,000 once more", (v) => field(v, "jing-parked") === `u${FUND}` && field(v, "jing-resting") === "u0");

  // ---- P4 a stranger readmits the vault's parked sats ----
  await tx("P4 stranger readmit-token-x(vault) on a full side submits", STRANGER, MKT_ID, "readmit-token-x", [P(VAULT_ID)], `(ok u${FUND})`);
  await tx("P4 settle full-side readmit refuses without moving parked funds", STRANGER, MKT_ID, "settle-token-x-readmit", [P(VAULT_ID), UPD], "(ok u0)");
  await tx("P4 filler 1 cancels: room", FILLERS[0], MKT_ID, "cancel-token-x-deposit", [sbtcT, stringAsciiCV("sbtc-token")], ok);
  await tx("P4 stranger readmit-token-x(vault): back on the book, nobody asked the vault", STRANGER, MKT_ID, "readmit-token-x", [P(VAULT_ID)], ok);
  await tx("P4 settle readmit into the free seat", STRANGER, MKT_ID, "settle-token-x-readmit", [P(VAULT_ID), UPD], `(ok u${FUND})`);
  await status("P4 resting 1,000 again, parked 0 (harmless: the peg rests at mid + 1 bp)", (v) => field(v, "jing-resting") === `u${FUND}` && field(v, "jing-parked") === "u0");
  await ev("P4 still the vault's peg (some u1)", MKT_ID, `(get-token-x-order '${VAULT_ID})`, (v) => field(v, "spread-bps") === "(some u1)");

  // ---- P5 park again, elapse, permissionless reclaim of a PARKED amount ----
  await sbtcXfer("P5 fund another fresh maker", standardPrincipalCV(NEW2), 5_000n);
  await tx("P5 another fresh 5,000-sat peg: the vault is parked a third time", NEW2, MKT_ID, "deposit-token-x", PEG(5_000n), "(ok u5000)");
  await settleX("P5 settle the full-side entrant", NEW2, "(ok u5000)");
  await status("P5 parked 1,000", (v) => field(v, "jing-parked") === `u${FUND}`);
  await tx("P5 proxy set-window-blocks 1", DEP, PROXY_ID, "set-window", [uintCV(1)], "(ok true)");
  await advance(2);
  await clock("P5 window elapsed", (v) => field(v, "window-elapsed") === "true");
  await tx("P5 stranger jing-reclaim: the PARKED amount comes home", STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], (v) => ok(v) && v.includes(`(amount u${FUND})`));
  await status("P5 1,000 home, nothing parked, nothing resting, not empty", (v) => field(v, "sbtc-balance") === `u${FUND}` && field(v, "jing-parked") === "u0" && field(v, "jing-resting") === "u0" && field(v, "empty") === "false");
  await tx("P5 jing-reclaim again -> nothing remains, amount zero", STRANGER, VAULT_ID, "jing-reclaim", [noneCV()], (v) => ok(v) && String(v).includes("(amount u0)"));
  await tx("P5 stranger router-swap the 1,000 sats at the floor (fresh update) -> unsold 0, empty", STRANGER, VAULT_ID, "router-swap", [UPD], (v) => ok(v) && v.includes(`(amount u${FUND})`) && v.includes("(unsold u0)"));
  await status("P5 empty", (v) => field(v, "empty") === "true");
  await clock("P5 clock cleared", (v) => field(v, "batch-start") === "none");
  writeResult("parked", st, S, { mid: String(MID), liveOpenMakers: String(open0), fillers: NFILL });
}
main().catch((e) => { console.error(e); process.exit(1); });
