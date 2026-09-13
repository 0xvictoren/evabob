// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IdentityRegistryV2} from "../src/IdentityRegistryV2.sol";
import {PaymentEscrowV2} from "../src/PaymentEscrowV2.sol";

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/**
 *  Deploy a 2-of-3 Safe, role-separated registry, and empty replacement escrow.
 */
contract DeployRoleSeparated is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    function run() external {
        require(block.chainid == 5_042_002, "Arc Testnet only");
        require(SAFE_SINGLETON.code.length > 0 && SAFE_PROXY_FACTORY.code.length > 0, "Safe contracts missing");

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address owner1 = vm.envAddress("SAFE_OWNER_1");
        address owner2 = vm.envAddress("SAFE_OWNER_2");
        address owner3 = vm.envAddress("SAFE_OWNER_3");
        address linker = vm.envAddress("IDENTITY_LINKER_ADDRESS");
        address attestor = vm.envAddress("ESCROW_ATTESTOR_ADDRESS");
        uint256 saltNonce = vm.envUint("SAFE_SALT_NONCE");

        require(owner1 != address(0) && owner2 != address(0) && owner3 != address(0), "zero owner");
        require(owner1 != owner2 && owner1 != owner3 && owner2 != owner3, "duplicate owner");
        require(linker != address(0) && attestor != address(0) && linker != attestor, "bad hot roles");

        address[] memory owners = new address[](3);
        owners[0] = owner1;
        owners[1] = owner2;
        owners[2] = owner3;
        bytes memory initializer = abi.encodeCall(
            ISafe.setup, (owners, 2, address(0), bytes(""), SAFE_FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );

        vm.startBroadcast(deployerKey);
        address safe =
            ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON, initializer, saltNonce);
        IdentityRegistryV2 registry = new IdentityRegistryV2(safe, linker);
        PaymentEscrowV2 escrow = new PaymentEscrowV2(ARC_USDC, address(registry), attestor, safe);
        vm.stopBroadcast();

        console2.log("AdminSafe:", safe);
        console2.log("IdentityRegistryV2:", address(registry));
        console2.log("PaymentEscrowV2:", address(escrow));
        console2.log("IdentityLinker:", linker);
        console2.log("EscrowAttestor:", attestor);
    }
}
