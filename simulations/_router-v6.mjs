// Router swap-router-sbtc-stx-jing-v6 is not on mainnet yet: the ccd016 sims
// deploy it on the fork from the jing repo bytes, as its real deployer
// (SPV9K21...), before the vault that binds it. Clarity 5, as the jing repo's
// own v6 sims deploy it. Zest pool u3 does not exist on mainnet: the vault
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
