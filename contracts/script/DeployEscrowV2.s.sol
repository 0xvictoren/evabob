// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PaymentEscrowV2} from "../src/PaymentEscrowV2.sol";

/**
 * @notice Deploy PaymentEscrowV2 against the IdentityRegistry already on Arc.
 *
 * The registry address is required rather than defaulted, and a new one is
 * never deployed here: every identity link written so far lives in the
 * existing registry, and a fresh one would resolve nothing, which would make
 * every claim revert with RecipientNotRegistered.
 *
 * Env:
 *   PRIVATE_KEY        — deployer, becomes admin
 *   CLAIM_ATTESTOR     — backend address allowed to authorise claims
 *   IDENTITY_REGISTRY  — the live registry to resolve recipients against
 *
 * forge script script/DeployEscrowV2.s.sol:DeployEscrowV2 \
 *   --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 */
contract DeployEscrowV2 is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address attestor = vm.envAddress("CLAIM_ATTESTOR");
        address registry = vm.envAddress("IDENTITY_REGISTRY");
        address admin = vm.addr(pk);

        require(registry.code.length > 0, "IDENTITY_REGISTRY has no contract code");

        vm.startBroadcast(pk);
        PaymentEscrowV2 escrow = new PaymentEscrowV2(ARC_USDC, registry, attestor, admin);
        vm.stopBroadcast();

        console2.log("PaymentEscrowV2:", address(escrow));
        console2.log("IdentityRegistry:", registry);
        console2.log("Admin:", admin);
        console2.log("Attestor:", attestor);
        console2.log("USDC:", ARC_USDC);
    }
}
