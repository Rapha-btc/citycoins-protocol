// Router swap-router-sbtc-stx-jing-v6 went LIVE at SPV9K21... on 2026-11-19
// (block 9525511, comment-stripped and re-wrapped). When the fork height is at
// or past its publish block the sims use the live contract (redeploying is
// "Duplicate contract"), after proving its code equals the jing repo bytes
// modulo comments and whitespace (ROUTER_V6_LIVE below); on an older fork they
// deploy the exact repo bytes as its real deployer, before the vault that binds
// it. Clarity 5, as the jing repo's own v6 sims deploy it. Zest pool u3 does not exist on mainnet: the vault
// passes zest u0 + an empty tick list and the router skips the leg
// (jing-contracts-v3 simulations/verify-router-sbtc-stx-v6-zest-nopool.mjs).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const ROUTER_DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
export const ROUTER_V6 = 'swap-router-sbtc-stx-jing-v6';
export const ROUTER_V6_ID = `${ROUTER_DEP}.${ROUTER_V6}`;
export const ROUTER_V6_CLARITY = 5;
const JING = process.env.JING_REPO || resolve(homedir(), 'projects/jing-contracts-v3');
export const ROUTER_V6_FILE = resolve(JING, `contracts/sbtc-stx/${ROUTER_V6}.clar`);
// jing-contracts-v3 4593bbb (Zest pool u3: x = wstx, y = sBTC)
export const ROUTER_V6_SHA = process.env.ROUTER_SHA || '8325e0c5300b3c9b65dc6d89ba70c1f4067add9515640efd2ca325c32b4e7a84';

export function routerV6Source() {
  const source = readFileSync(ROUTER_V6_FILE, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  if (ROUTER_V6_SHA !== 'skip' && hash !== ROUTER_V6_SHA) throw new Error(`router v6 sha ${hash} != pinned ${ROUTER_V6_SHA} (${ROUTER_V6_FILE})`);
  return { source, sha: hash };
}

// Live router v6 at ROUTER_DEP, checked code-equal to the repo bytes (comments
// and whitespace aside); null if not published. Same check as
// fastpool-pox-5 simulations/_jing-v6-3.mjs liveContract/codeTokens.
const NODE_API = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const codeTokens = (src) => src.replace(/;;[^\n]*/g, ' ').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
async function liveRouterV6() {
  let meta;
  for (let i = 0; ; i++) {
    try { meta = await fetch(`${NODE_API}/extended/v1/contract/${ROUTER_V6_ID}`, { signal: AbortSignal.timeout(20000) }); if (meta.status === 404 || meta.ok || i >= 4) break; }
    catch (e) { if (i >= 4) throw e; }
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  if (meta.status === 404) return null;
  if (!meta.ok) throw new Error(`${ROUTER_V6}: contract lookup HTTP ${meta.status}`);
  const { block_height: height, tx_id: txid, source_code: source } = await meta.json();
  if (codeTokens(source) !== codeTokens(routerV6Source().source)) throw new Error(`${ROUTER_V6}: live code at ${ROUTER_V6_ID} (tx ${txid}) differs from repo bytes`);
  return { height, txid, sha256: createHash('sha256').update(source).digest('hex') };
}
export const ROUTER_V6_LIVE = await liveRouterV6();
// true when the fork (parent) height already has the live router: skip the deploy
export function routerV6LiveAt(height) { return !!ROUTER_V6_LIVE && (height === undefined || Number(height) >= ROUTER_V6_LIVE.height); }
export function routerV6Note(height) {
  return routerV6LiveAt(height)
    ? `${ROUTER_V6_ID} LIVE (block ${ROUTER_V6_LIVE.height}, tx ${ROUTER_V6_LIVE.txid}, deployed sha ${ROUTER_V6_LIVE.sha256}), code-equal to jing repo bytes ${routerV6Source().sha} modulo comments/whitespace; not redeployed`
    : `${ROUTER_V6_ID} deployed on the fork from jing repo bytes (sha ${routerV6Source().sha})`;
}
