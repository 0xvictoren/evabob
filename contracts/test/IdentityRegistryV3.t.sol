// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistryV2} from "../src/IdentityRegistryV2.sol";
import {IdentityRegistryV3} from "../src/IdentityRegistryV3.sol";

contract IdentityRegistryV3Test is Test {
    IdentityRegistryV2 v2;
    IdentityRegistryV3 v3;
    address admin = address(0xA11CE);
    address linker = address(0x11A);
    address person = address(0xB0B);
    address agentWallet = address(0xA6E);

    function setUp() public {
        v2 = new IdentityRegistryV2(admin, linker);
        v3 = new IdentityRegistryV3(admin, linker);
    }

    /// Appending must not move any existing ordinal, or every key hashed
    /// from one would change and existing links would stop resolving.
    function test_existingOrdinalsAreUnchanged() public pure {
        assertEq(uint8(IdentityRegistryV3.IdType.Phone), uint8(IdentityRegistryV2.IdType.Phone));
        assertEq(uint8(IdentityRegistryV3.IdType.Email), uint8(IdentityRegistryV2.IdType.Email));
        assertEq(uint8(IdentityRegistryV3.IdType.Handle), uint8(IdentityRegistryV2.IdType.Handle));
        assertEq(uint8(IdentityRegistryV3.IdType.Agent), 3);
    }

    function test_existingKeysAreIdentical() public view {
        bytes memory handle = bytes("ada");
        assertEq(
            v3.identityKey(IdentityRegistryV3.IdType.Handle, handle),
            v2.identityKey(IdentityRegistryV2.IdType.Handle, handle)
        );
        bytes memory email = bytes("ada@example.com");
        assertEq(
            v3.identityKey(IdentityRegistryV3.IdType.Email, email),
            v2.identityKey(IdentityRegistryV2.IdType.Email, email)
        );
    }

    /// An agent named "ada-research" and a person with the same text as a
    /// handle are different identities: the type is part of the key.
    function test_agentIsItsOwnIdentityType() public {
        bytes memory name = bytes("research");
        vm.startPrank(linker);
        v3.adminLink(agentWallet, IdentityRegistryV3.IdType.Agent, name);
        v3.adminLink(person, IdentityRegistryV3.IdType.Handle, name);
        vm.stopPrank();

        (address a, bool aActive) = v3.resolveIdentifier(IdentityRegistryV3.IdType.Agent, name);
        (address h, bool hActive) = v3.resolveIdentifier(IdentityRegistryV3.IdType.Handle, name);
        assertEq(a, agentWallet);
        assertEq(h, person);
        assertTrue(aActive && hActive);
        assertTrue(
            v3.identityKey(IdentityRegistryV3.IdType.Agent, name)
                != v3.identityKey(IdentityRegistryV3.IdType.Handle, name)
        );
    }

    function test_agentKeyMatchesOffchainHash() public view {
        bytes memory name = bytes("research");
        assertEq(
            v3.identityKey(IdentityRegistryV3.IdType.Agent, name),
            keccak256(abi.encodePacked(uint8(3), name))
        );
    }

    /// V2 has no Agent type, so the server never links agents there.
    function test_v2RejectsTheAgentOrdinal() public {
        vm.prank(linker);
        (bool ok,) = address(v2).call(
            abi.encodeWithSignature("adminLink(address,uint8,bytes)", agentWallet, uint8(3), bytes("research"))
        );
        assertFalse(ok);
    }

    function test_onlyLinkerLinksAgents() public {
        vm.prank(person);
        vm.expectRevert(IdentityRegistryV3.NotLinker.selector);
        v3.adminLink(agentWallet, IdentityRegistryV3.IdType.Agent, bytes("research"));
    }
}
