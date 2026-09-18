// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MoneyCircles} from "../src/MoneyCircles.sol";
import {GroupPots} from "../src/GroupPots.sol";

/**
 * @notice Deploy MoneyCircles and GroupPots.
 *
 * Neither contract has an admin: there is no role to hand to the Safe, and
 * nothing the deployer can do afterwards. The platform fee recipient and rate
 * are fixed at deployment.
 *
 * Env:
 *   PRIVATE_KEY          — deployer (ops signer; pays gas in USDC on Arc)
 *   PLATFORM_FEE_ADDRESS — where the platform fee goes
 *   PLATFORM_FEE_BPS     — fee in basis points (default 5 = 0.05%)
 *
 * forge script script/DeployGroupMoney.s.sol:DeployGroupMoney \
 *   --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 */
contract DeployGroupMoney is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        require(block.chainid == 5_042_002, "Arc Testnet only");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address feeRecipient = vm.envAddress("PLATFORM_FEE_ADDRESS");
        uint16 feeBps = uint16(vm.envOr("PLATFORM_FEE_BPS", uint256(5)));
        require(feeRecipient != address(0), "PLATFORM_FEE_ADDRESS");

        vm.startBroadcast(pk);
        MoneyCircles circles = new MoneyCircles(ARC_USDC, feeRecipient, feeBps);
        GroupPots pots = new GroupPots(ARC_USDC, feeRecipient, feeBps);
        vm.stopBroadcast();

        console2.log("MoneyCircles:", address(circles));
        console2.log("GroupPots:", address(pots));
        console2.log("Fee recipient:", feeRecipient);
        console2.log("Fee bps:", feeBps);
        console2.log("Deployer:", vm.addr(pk));
    }
}
