// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IdentityRegistryV3} from "../src/IdentityRegistryV3.sol";

/**
 * @notice Deploy IdentityRegistryV3 (V2 plus the appended Agent type).
 *
 * Same roles as V2: the 2-of-3 Safe is admin, the hot identity linker links.
 * PaymentEscrowV3 keeps resolving against V2 (its registry is immutable), so
 * the server links people in both until the escrow is next replaced; agents
 * are linked in V3 only.
 *
 * Env:
 *   PRIVATE_KEY          — deployer (ops signer; pays gas in USDC on Arc)
 *   ADMIN_SAFE_ADDRESS   — admin (the Safe)
 *   IDENTITY_LINKER      — linker address (the hot identity linker)
 *
 * forge script script/DeployIdentityV3.s.sol:DeployIdentityV3 \
 *   --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 */
contract DeployIdentityV3 is Script {
    function run() external {
        require(block.chainid == 5_042_002, "Arc Testnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_SAFE_ADDRESS");
        address linker = vm.envAddress("IDENTITY_LINKER");

        vm.startBroadcast(pk);
        IdentityRegistryV3 registry = new IdentityRegistryV3(admin, linker);
        vm.stopBroadcast();

        console2.log("IdentityRegistryV3:", address(registry));
        console2.log("Admin:", admin);
        console2.log("Linker:", linker);
        console2.log("Deployer:", vm.addr(pk));
    }
}
