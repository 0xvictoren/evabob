// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GroupPots} from "../src/GroupPots.sol";
import {MockUSDC} from "./PaymentEscrowV2.t.sol";

contract GroupPotsTest is Test {
    MockUSDC usdc;
    GroupPots pots;

    address organizer = address(0x0A);
    address family = address(0xFA);
    address ada = address(0xA1);
    address bola = address(0xB2);
    address feeWallet = address(0xFEE);
    address stranger = address(0xBAD);

    uint16 constant FEE_BPS = 5;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        pots = new GroupPots(address(usdc), feeWallet, FEE_BPS);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? ada : bola;
            usdc.mint(who, 100e6);
            vm.prank(who);
            usdc.approve(address(pots), type(uint256).max);
        }
    }

    function _pot(uint128 target) internal returns (uint256 id) {
        vm.prank(organizer);
        id = pots.createPot(family, target, uint64(block.timestamp + 7 days));
    }

    function test_reachingTheTarget_releasesAtOnce() public {
        uint256 id = _pot(50e6);
        vm.prank(ada);
        pots.contribute(id, 30e6);
        assertEq(usdc.balanceOf(family), 0);
        vm.prank(bola);
        pots.contribute(id, 25e6); // crosses the target
        uint256 fee = (55e6 * FEE_BPS) / 10_000;
        assertEq(usdc.balanceOf(family), 55e6 - fee);
        assertEq(usdc.balanceOf(feeWallet), fee);
        assertEq(usdc.balanceOf(address(pots)), 0);

        vm.prank(ada);
        vm.expectRevert("not open");
        pots.contribute(id, 1e6);
    }

    function test_missedDeadline_refundsEveryoneExactly() public {
        uint256 id = _pot(100e6);
        vm.prank(ada);
        pots.contribute(id, 30e6);
        vm.prank(bola);
        pots.contribute(id, 20e6);

        vm.prank(stranger);
        vm.expectRevert("still open");
        pots.refund(id, ada);

        vm.warp(block.timestamp + 7 days);
        vm.prank(bola);
        vm.expectRevert("deadline passed");
        pots.contribute(id, 1e6);

        // Anyone may trigger a refund; it only ever goes back to the payer.
        vm.prank(stranger);
        pots.refund(id, ada);
        vm.prank(stranger);
        pots.refund(id, bola);
        assertEq(usdc.balanceOf(ada), 100e6);
        assertEq(usdc.balanceOf(bola), 100e6);
        assertEq(usdc.balanceOf(stranger), 0);

        vm.expectRevert("nothing to refund");
        pots.refund(id, ada);
        vm.expectRevert("not open");
        pots.release(id);
    }

    function test_organizerCanCallItOff_andEveryoneIsRefunded() public {
        uint256 id = _pot(100e6);
        vm.prank(ada);
        pots.contribute(id, 30e6);
        vm.prank(ada);
        vm.expectRevert("organizer only");
        pots.callOff(id);
        vm.prank(organizer);
        pots.callOff(id);
        pots.refund(id, ada);
        assertEq(usdc.balanceOf(ada), 100e6);
    }

    function test_cannotReleaseShortOfTheTarget() public {
        uint256 id = _pot(100e6);
        vm.prank(ada);
        pots.contribute(id, 30e6);
        vm.expectRevert("target not reached");
        pots.release(id);
    }

    function test_rejectsBadPots() public {
        vm.expectRevert("deadline passed");
        pots.createPot(family, 1e6, uint64(block.timestamp));
        vm.expectRevert("deadline too far");
        pots.createPot(family, 1e6, uint64(block.timestamp + 400 days));
        vm.expectRevert("beneficiary");
        pots.createPot(address(0), 1e6, uint64(block.timestamp + 1 days));
    }
}
