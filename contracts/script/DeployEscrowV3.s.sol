// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PaymentEscrowV3} from "../src/PaymentEscrowV3.sol";

/**
 * @notice Deploy PaymentEscrowV3 against the live IdentityRegistryV2, with the
 * admin Safe as admin from the first block.
 *
 * Unlike the V2 script, the deployer never holds the admin role even briefly:
 * the Safe is passed to the constructor, so there is no handover transaction
 * to forget. The deployer only pays gas.
 *
 * PaymentEscrowV2 is not touched. Holds created there finish there — the
 * server keeps releasing, refunding and sweeping V2 by its own address — and
 * only new holds go to V3 once PAYMENT_ESCROW points here.
 *
 * Env:
 *   PRIVATE_KEY             — deployer (ops signer; pays gas in USDC on Arc)
 *   IDENTITY_REGISTRY       — the live registry to resolve recipients against
 *   ESCROW_ATTESTOR_ADDRESS — the hot attestor the server signs claims with
 *   ADMIN_SAFE_ADDRESS      — the 2-of-3 Safe that owns every admin role
 *
 * forge script script/DeployEscrowV3.s.sol:DeployEscrowV3 \
 *   --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 */
contract DeployEscrowV3 is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        require(block.chainid == 5_042_002, "Arc Testnet only");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address registry = vm.envAddress("IDENTITY_REGISTRY");
        address attestor = vm.envAddress("ESCROW_ATTESTOR_ADDRESS");
        address safe = vm.envAddress("ADMIN_SAFE_ADDRESS");
        address deployer = vm.addr(pk);

        require(registry.code.length > 0, "IDENTITY_REGISTRY has no contract code");
        require(safe.code.length > 0, "ADMIN_SAFE_ADDRESS has no contract code");
        require(attestor != address(0) && attestor != deployer, "attestor must be its own key");
        require(safe != deployer && safe != attestor, "admin must be the Safe");

        vm.startBroadcast(pk);
        PaymentEscrowV3 escrow = new PaymentEscrowV3(ARC_USDC, registry, attestor, safe);
        vm.stopBroadcast();

        require(escrow.admin() == safe, "admin mismatch");
        require(escrow.claimAttestor() == attestor, "attestor mismatch");

        console2.log("PaymentEscrowV3:", address(escrow));
        console2.log("IdentityRegistry:", registry);
        console2.log("Admin (Safe):", safe);
        console2.log("Attestor:", attestor);
        console2.log("Deployer:", deployer);
    }
}
