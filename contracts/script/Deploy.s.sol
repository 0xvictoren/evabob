// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";

/**
 * @notice Deploy IdentityRegistry + PaymentEscrow to Arc Testnet.
 *
 * Env:
 *   PRIVATE_KEY       — deployer
 *   CLAIM_ATTESTOR     — backend attestor address
 *   ARC_TESTNET_RPC_URL
 *
 * Arc USDC ERC-20: 0x3600000000000000000000000000000000000000
 *
 * forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 */
contract Deploy is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address attestor = vm.envAddress("CLAIM_ATTESTOR");
        address admin = vm.addr(pk);

        vm.startBroadcast(pk);

        IdentityRegistry registry = new IdentityRegistry(admin);
        PaymentEscrow escrow = new PaymentEscrow(ARC_USDC, attestor, admin);

        vm.stopBroadcast();

        console2.log("IdentityRegistry:", address(registry));
        console2.log("PaymentEscrow:", address(escrow));
        console2.log("Admin:", admin);
        console2.log("Attestor:", attestor);
        console2.log("USDC:", ARC_USDC);
    }
}
