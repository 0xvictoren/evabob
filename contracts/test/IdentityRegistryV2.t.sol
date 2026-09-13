// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistryV2} from "../src/IdentityRegistryV2.sol";

contract IdentityRegistryV2Test is Test {
    IdentityRegistryV2 registry;
    address admin = address(0xA11CE);
    address linker = address(0x11A);
    address nextLinker = address(0x11B);
    address user = address(0xB0B);
    address attacker = address(0xBAD);
    bytes email = bytes("person@example.com");

    function setUp() public {
        registry = new IdentityRegistryV2(admin, linker);
    }

    function test_onlyLinkerCanCreateVerifiedLinks() public {
        vm.prank(admin);
        vm.expectRevert(IdentityRegistryV2.NotLinker.selector);
        registry.adminLink(user, IdentityRegistryV2.IdType.Email, email);

        vm.prank(linker);
        registry.adminLink(user, IdentityRegistryV2.IdType.Email, email);
        (address account, bool active) = registry.resolveIdentifier(IdentityRegistryV2.IdType.Email, email);
        assertEq(account, user);
        assertTrue(active);
    }

    function test_linkerCannotRotateItsOwnPrivilege() public {
        vm.prank(linker);
        vm.expectRevert(IdentityRegistryV2.NotAdmin.selector);
        registry.setLinker(attacker);

        vm.prank(admin);
        registry.setLinker(nextLinker);
        assertEq(registry.linker(), nextLinker);
    }

    function test_compromisedLinkerCannotRecycleAnExistingIdentityToAttacker() public {
        vm.startPrank(linker);
        registry.adminLink(user, IdentityRegistryV2.IdType.Email, email);
        bytes32 key = registry.identityKey(IdentityRegistryV2.IdType.Email, email);
        registry.linkerUnlink(user, key);
        vm.expectRevert(IdentityRegistryV2.IdentityOwnedByAnotherAccount.selector);
        registry.adminLink(attacker, IdentityRegistryV2.IdType.Email, email);
        registry.adminLink(user, IdentityRegistryV2.IdType.Email, email);
        vm.stopPrank();
    }

    function test_linkerCannotUnlinkAKeyUsingTheWrongOwner() public {
        vm.prank(linker);
        registry.adminLink(user, IdentityRegistryV2.IdType.Email, email);
        bytes32 key = registry.identityKey(IdentityRegistryV2.IdType.Email, email);

        vm.prank(linker);
        vm.expectRevert(IdentityRegistryV2.NotLinked.selector);
        registry.linkerUnlink(attacker, key);
    }

    function test_adminCanEmergencyUnlinkButCannotRedirectThroughLinkerPath() public {
        vm.prank(linker);
        registry.adminLink(user, IdentityRegistryV2.IdType.Email, email);
        bytes32 key = registry.identityKey(IdentityRegistryV2.IdType.Email, email);

        vm.prank(admin);
        registry.adminUnlink(key);
        (, bool active) = registry.resolve(key);
        assertFalse(active);

        vm.prank(admin);
        vm.expectRevert(IdentityRegistryV2.NotLinker.selector);
        registry.adminLink(attacker, IdentityRegistryV2.IdType.Email, email);
    }
}
