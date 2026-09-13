// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {PaymentEscrowV2} from "../src/PaymentEscrowV2.sol";

/** Deploy the verified-identity registry and a V2 escrow wired to it. */
contract DeployHardened is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(deployerKey);
        address attestor = vm.envOr("CLAIM_ATTESTOR", admin);

        require(block.chainid == 5_042_002, "Arc Testnet only");

        vm.startBroadcast(deployerKey);
        IdentityRegistry registry = new IdentityRegistry(admin);
        PaymentEscrowV2 escrow = new PaymentEscrowV2(
            ARC_USDC,
            address(registry),
            attestor,
            admin
        );
        vm.stopBroadcast();

        console2.log("IdentityRegistry:", address(registry));
        console2.log("PaymentEscrowV2:", address(escrow));
        console2.log("Admin:", admin);
        console2.log("Attestor:", attestor);
    }
}
