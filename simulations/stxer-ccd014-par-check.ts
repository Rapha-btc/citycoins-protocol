// Stxer mainnet-fork simulation for CCD014 - MiamiCoin Redemption Book.
//
// Purpose: settle whether PAR_SCALED (u1710000 = 17,100 STX per 1M MIA) matches
// reality, using the CONTRACT'S OWN math against live mainnet state rather than
// arithmetic done outside the chain.
//
// Deployer must be the CityCoins DAO deployer: ccd014 references .base-dao and
// .ccd002-treasury-mia-* as local contract refs, so they only resolve under
// SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH.
//
// NOT covered here: credit-rewards and cross-book are gated by
// is-dao-or-extension, which needs ccd014 enabled as an extension by a passed
// proposal. ccd001-direct-execute has sunset on mainnet, so there is no way to
// simulate the money path without first running a real token-weighted vote.
// That gap is itself a finding, not an oversight.

import { AnchorMode, PostConditionMode, uintCV } from "@stacks/transactions";
import { SimulationBuilder } from "stxer";
import fs from "fs";

const DAO_DEPLOYER = "SP8A9HZ3PKST0S42VM9523Z9NV42SZ026V4K39WH";
const CONTRACT_NAME = "ccd014-redemption-book-mia";
const CONTRACT_ID = `${DAO_DEPLOYER}.${CONTRACT_NAME}`;

let nonce = 42;

const common = {
  publicKey: "",
  postConditionMode: PostConditionMode.Allow,
  anchorMode: AnchorMode.Any,
  fee: 10000,
};

function call(function_name: string, function_args: any[] = []) {
  return {
    contract_id: CONTRACT_ID,
    function_name,
    function_args,
    nonce: nonce++,
    sender: DAO_DEPLOYER,
    ...common,
  };
}

// A realistic market-priced offer: 1,000,000 MIA (1e12 micro-MIA) asked at
// ~238,650 sats, which is roughly where MIA trades. If below-par? returns true
// for this, par is not a binding constraint.
const ONE_MILLION_MIA = 1_000_000_000_000n;
const MARKET_ASK_SATS = 238_650n;

// The same offer priced AT the hardcoded par: 17,100 STX per 1M MIA.
// At the contract's native price this should sit right on the boundary.
const PAR_ASK_SATS = 2_724_000n;

function main() {
  return SimulationBuilder.new()
    .useBlockHeight(8662241)
    .addContractDeploy({
      contract_name: CONTRACT_NAME,
      source_code: fs.readFileSync(
        `./contracts/extensions/${CONTRACT_NAME}.clar`,
        "utf8"
      ),
      deployer: DAO_DEPLOYER,
      // Clarity 5: as-contract? and current-contract are unresolved below this.
      // Confirmed against SPV9K21...mia-orderbook-faktory, deployed at version 5.
      // The enum in @stacks/transactions v7 only lists 1-3, so pass the raw number.
      clarity_version: 5 as any,
    })
    // 1. Does the inlined miner-commit price work on real tenure data at
    //    coinbase 1000 STX? Expect ~62,786,463,238,524 (2x the RFQ's value).
    .addContractCall(call("get-native-price"))
    // 2. What does the contract compute as LIVE backing per micro-MIA?
    //    Expect ~u214830 vs the hardcoded u1710000 -> the 8x gap.
    .addContractCall(call("calculate-par"))
    // 3. Round-trip the constant back to human units. Expect 17,100,000,000 uSTX.
    .addContractCall(call("get-par-ustx-per-1m-mia"))
    // 4. Live treasury total across all five ccd002 MIA treasuries.
    .addContractCall(call("get-treasury-balance"))
    // 5. Supply denominator actually used by calculate-par.
    .addContractCall(call("get-mia-total-supply"))
    // 6. Everything at once.
    .addContractCall(call("get-info"))
    // 7. THE key question: does a market-priced offer clear par?
    //    If true, the par ceiling admits offers ~15x above market.
    .addContractCall(
      call("below-par?", [
        uintCV(ONE_MILLION_MIA),
        uintCV(MARKET_ASK_SATS),
        uintCV(62_786_463_238_524n),
      ])
    )
    // 8. And an offer priced at par itself - boundary behaviour.
    .addContractCall(
      call("below-par?", [
        uintCV(ONE_MILLION_MIA),
        uintCV(PAR_ASK_SATS),
        uintCV(62_786_463_238_524n),
      ])
    )
    .run()
    .catch(console.error);
}

main();
