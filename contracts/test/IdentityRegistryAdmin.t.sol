// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";

/**
 * Whether handing over registry admin is a one-way door.
 *
 * It matters because PaymentEscrowV2 pays whoever this registry resolves a
 * recipient to, so admin is the key that decides where held money can go. The
 * question worth settling before rotating it is what "permanent" actually
 * means: is the slot spent after one handover, or only stuck when nobody holds
 * the key any more?
 *
 * These are also the first tests IdentityRegistry has ever had.
 */
contract IdentityRegistryAdminTest is Test {
    IdentityRegistry registry;

    address deployer = address(0xD3919E4);
    address second = address(0x5EC0AD);
    address third = address(0x7413D);
    address stranger = address(0xBAD);

    function setUp() public {
        registry = new IdentityRegistry(deployer);
    }

    function test_adminCanBeHandedOverAgainAndAgain() public {
        // The reassuring half: holding the current key means you are never
        // stuck with it. Nothing about the first handover spends the slot.
        assertEq(registry.admin(), deployer);

        vm.prank(deployer);
        registry.setAdmin(second);
        assertEq(registry.admin(), second);

        vm.prank(second);
        registry.setAdmin(third);
        assertEq(registry.admin(), third);

        vm.prank(third);
        registry.setAdmin(deployer);
        assertEq(registry.admin(), deployer, "and it can come back");
    }

    function test_theOldAdminLosesEveryPowerImmediately() public {
        vm.prank(deployer);
        registry.setAdmin(second);

        // Handing over is total: the previous holder cannot take it back, and
        // cannot touch identities either.
        vm.prank(deployer);
        vm.expectRevert(IdentityRegistry.NotAdmin.selector);
        registry.setAdmin(deployer);

        vm.prank(deployer);
        vm.expectRevert(IdentityRegistry.NotAdmin.selector);
        registry.adminLink(stranger, IdentityRegistry.IdType.Email, bytes("a@b.com"));
    }

    function test_aStrangerCannotTakeAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(IdentityRegistry.NotAdmin.selector);
        registry.setAdmin(stranger);
        assertEq(registry.admin(), deployer);
    }

    function test_adminCannotBeSentToNowhereByAccident() public {
        // The only guard the contract offers against freezing itself.
        vm.prank(deployer);
        vm.expectRevert(IdentityRegistry.ZeroAddress.selector);
        registry.setAdmin(address(0));
        assertEq(registry.admin(), deployer);
    }

    function test_thereIsNoRecoveryOnceTheKeyIsGone() public {
        // The sobering half, and the reason a backup is not optional. Nothing
        // here is a bug — it is simply that `onlyAdmin` has no exception, so an
        // address nobody can sign for holds the registry forever.
        address unreachable = address(0xDEAD);
        vm.prank(deployer);
        registry.setAdmin(unreachable);

        for (uint160 i = 1; i < 6; i++) {
            address anyone = address(i);
            vm.prank(anyone);
            vm.expectRevert(IdentityRegistry.NotAdmin.selector);
            registry.setAdmin(anyone);
        }

        // Identities can no longer be linked or corrected by anyone.
        vm.prank(deployer);
        vm.expectRevert(IdentityRegistry.NotAdmin.selector);
        registry.adminLink(stranger, IdentityRegistry.IdType.Email, bytes("a@b.com"));

        assertEq(registry.admin(), unreachable, "and it stays there");
    }

    function test_unverifiedUsersCannotSquatIdentities() public {
        vm.prank(deployer);
        registry.setAdmin(address(0xDEAD));

        vm.prank(stranger);
        vm.expectRevert(IdentityRegistry.NotAdmin.selector);
        registry.link(IdentityRegistry.IdType.Email, bytes("stranger@example.com"));
    }

    function test_adminCanLinkAfterVerification() public {
        vm.prank(deployer);
        registry.adminLink(stranger, IdentityRegistry.IdType.Email, bytes("stranger@example.com"));

        (address account, bool active) =
            registry.resolveIdentifier(IdentityRegistry.IdType.Email, bytes("stranger@example.com"));
        assertEq(account, stranger);
        assertTrue(active);
    }
}
