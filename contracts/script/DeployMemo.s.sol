// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {EvabobMemo} from "../src/EvabobMemo.sol";

/**
 * @notice Deploy EvabobMemo. It has no owner, no roles and holds no funds, so
 * any funded key can deploy it; the ops signer is the usual choice.
 *
 * After deploying, set MEMO_CONTRACT_ADDRESS on the API. Until then memos are
 * kept with the payment record only, not written on chain.
 *
 * Env:
 *   PRIVATE_KEY — deployer (pays gas in USDC on Arc)
 *
 * forge script script/DeployMemo.s.sol:DeployMemo \
 *   --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 */
contract DeployMemo is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        EvabobMemo memo = new EvabobMemo();
        vm.stopBroadcast();

        console2.log("EvabobMemo:", address(memo));
    }
}
