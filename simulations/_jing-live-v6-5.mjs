// The Jing stack the ccd016 vault binds on this branch (fork only, nothing
// broadcast): the LIVE markets-sbtc-stx-jing-v6-5 (real principal, deployed
// bytes, live state) and swap-router-sbtc-stx-jing-v6, LIVE since block 9525511
// (used as-is when the fork has it; older forks deploy the jing repo bytes,
// routerDeploy below). Vault and book deploy
// from the repo bytes, sha256 pinned below (env-overridable: VAULT_SHA,
// BOOK_SHA). Ported from citycoins-protocol-ccip028-pr _jing-live-v6-4.mjs.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {routerV6Source, ROUTER_V6, ROUTER_V6_CLARITY, ROUTER_V6_SHA, ROUTER_V6_LIVE, routerV6LiveAt, routerV6Note} from './_router-v6.mjs';
export {routerV6LiveAt, routerV6Note};

export const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
export const MKT = 'markets-sbtc-stx-jing-v6-5', ROUTER = ROUTER_V6;
export const MKT_ID = `${DEP}.${MKT}`, ROUTER_ID = `${DEP}.${ROUTER}`;
export const STX_HOLDER = 'SP2XXSW2KPPTY7KJDYS9RQ868D7JH58QSZKK8KXAV';
export const SBTC_HOLDER = 'SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2';
// Deployed bytes (GET /v2/contracts/source/<id>), checked at run time.
export const LIVE_SHA = {
  [MKT]: '2e838afd3bac2e3de72f9e512912231c57c1c1f2120d41a6772ebbb4ed18b96f',
};
// router v6 from the jing repo (sha pinned in _router-v6.mjs): deploy it as DEP first,
// unless the fork height already has the live router (block 9525511): then null
export function routerDeploy(height) { if (routerV6LiveAt(height)) return null; const {source} = routerV6Source(); return {contract_name: ROUTER, source_code: source, clarity_version: ROUTER_V6_CLARITY}; }
export const VAULT_FILE = 'contracts/extensions/ccd016-swap-vault-mia-v2.clar';
export const BOOK_FILE = 'contracts/extensions/ccd015-redemption-book-mia-stx.clar';
// vault: router-v6 rebind (zest leg); book: feat/ccd015-redemption-book 2440559 (bounty mw4761 fixes)
export const VAULT_SHA = process.env.VAULT_SHA || '237e2f007825b40a1b6f62fab6aae0e154eb11f0d0ac026a53df5a7a830f8382';
export const BOOK_SHA = process.env.BOOK_SHA || '8982d30e17db7f92cd8cdb902464d508aaa65ca389dac6bd0920a3e694c3f34a';
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function exactSources() {
  const vault = readFileSync(VAULT_FILE, 'utf8'), book = readFileSync(BOOK_FILE, 'utf8');
  if (sha(vault) !== VAULT_SHA) throw new Error(`vault sha ${sha(vault)} != pinned ${VAULT_SHA}`);
  if (sha(book) !== BOOK_SHA) throw new Error(`book sha ${sha(book)} != pinned ${BOOK_SHA}`);
  if (!vault.includes(`'${MKT_ID})`) || !vault.includes(`'${ROUTER_ID})`)) throw new Error('vault does not bind live market v6-5 / router v6');
  return {vault, book, vaultSha: VAULT_SHA, bookSha: BOOK_SHA};
}

export async function liveJingHashes(node) {
  const out = {};
  out[ROUTER] = ROUTER_V6_LIVE ? `live ${ROUTER_V6_LIVE.sha256} (code-equal to repo ${routerV6Source().sha})` : `repo ${routerV6Source().sha}`;
  for (const name of [MKT]) {
    const r = await fetch(`${node}/v2/contracts/source/${DEP}/${name}?proof=0`);
    if (!r.ok) throw new Error(`source ${name}: ${r.status}`);
    const h = sha((await r.json()).source);
    if (h !== LIVE_SHA[name]) throw new Error(`${name} deployed sha ${h} != ${LIVE_SHA[name]}`);
    out[name] = h;
  }
  return out;
}

const JING_SIM = process.env.JING_SIM || resolve(homedir(), 'projects/jing-contracts-v3/simulations');
export const {lazerFeedTimes} = await import(resolve(JING_SIM, '_lazer.js'));
