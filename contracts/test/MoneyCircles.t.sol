// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MoneyCircles} from "../src/MoneyCircles.sol";
import {MockUSDC} from "./PaymentEscrowV2.t.sol";

/**
 * The rules for missed contributions were chosen by the product owner: the
 * round pays out what was collected, the member who missed is behind and owes
 * the member they shorted, and a behind member whose turn comes is moved to
 * the end. These tests pin those rules and that nobody can take the pot.
 */
contract MoneyCirclesTest is Test {
    MockUSDC usdc;
    MoneyCircles circles;

    address ada = address(0xA1);
    address bola = address(0xB2);
    address chidi = address(0xC3);
    address feeWallet = address(0xFEE);
    address stranger = address(0xBAD);

    uint128 constant EACH = 10_000_000; // 10 USDC
    uint64 constant WEEK = 7 days;
    uint16 constant FEE_BPS = 5; // 0.05%

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        circles = new MoneyCircles(address(usdc), feeWallet, FEE_BPS);
    }

    function _members() internal view returns (address[] memory m) {
        m = new address[](3);
        m[0] = ada;
        m[1] = bola;
        m[2] = chidi;
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(circles), uint256(EACH) * 3);
    }

    /// A running circle where everyone could pay [balances] in total.
    function _running(uint256 aBal, uint256 bBal, uint256 cBal) internal returns (uint256 id) {
        vm.prank(ada);
        id = circles.createCircle(EACH, WEEK, uint64(block.timestamp), _members());
        _fund(ada, aBal);
        _fund(bola, bBal);
        _fund(chidi, cBal);
        vm.prank(ada);
        circles.join(id);
        vm.prank(bola);
        circles.join(id);
        vm.prank(chidi);
        circles.join(id);
    }

    function _net(uint256 gross) internal pure returns (uint256) {
        return gross - (gross * FEE_BPS) / 10_000;
    }

    function test_everyonePays_eachGetsThePotInTurn() public {
        uint256 id = _running(30e6, 30e6, 30e6);
        (,,,,,,, MoneyCircles.State state) = circles.circles(id);
        assertEq(uint8(state), uint8(MoneyCircles.State.Running));

        circles.collect(id);
        assertEq(usdc.balanceOf(ada), 20e6 + _net(30e6));

        vm.expectRevert("not due yet");
        circles.collect(id);

        vm.warp(block.timestamp + WEEK);
        circles.collect(id);
        assertEq(usdc.balanceOf(bola), 10e6 + _net(30e6), "paid in twice, received the pot");

        vm.warp(block.timestamp + WEEK);
        vm.prank(stranger); // anyone may trigger a round
        circles.collect(id);
        assertEq(usdc.balanceOf(chidi), _net(30e6), "paid in three times, received the pot");

        (,,,,,,, state) = circles.circles(id);
        assertEq(uint8(state), uint8(MoneyCircles.State.Finished));
        assertEq(usdc.balanceOf(address(circles)), 0, "nothing left in the contract");
        assertEq(usdc.balanceOf(feeWallet), 3 * ((30e6 * FEE_BPS) / 10_000));
    }

    function test_joiningNeedsTheWholeCommitmentApproved() public {
        vm.prank(ada);
        uint256 id = circles.createCircle(EACH, WEEK, uint64(block.timestamp), _members());
        usdc.mint(bola, 30e6);
        vm.prank(bola);
        usdc.approve(address(circles), EACH); // one round only
        vm.prank(bola);
        vm.expectRevert("approve your full commitment first");
        circles.join(id);

        vm.prank(stranger);
        vm.expectRevert("not a member");
        circles.join(id);
    }

    function test_onlyTheOrganizerCancels_andOnlyBeforeItStarts() public {
        vm.prank(ada);
        uint256 id = circles.createCircle(EACH, WEEK, uint64(block.timestamp), _members());
        vm.prank(bola);
        vm.expectRevert("organizer only");
        circles.cancel(id);
        vm.prank(ada);
        circles.cancel(id);

        uint256 running = _running(30e6, 30e6, 30e6);
        vm.prank(ada);
        vm.expectRevert("not forming");
        circles.cancel(running);
    }

    function test_missedRound_paysOutAnyway_andTheMemberIsBehind() public {
        // Bola has nothing in round 1 (Ada's turn).
        uint256 id = _running(30e6, 0, 30e6);
        circles.collect(id);
        assertEq(usdc.balanceOf(ada), 20e6 + _net(20e6), "Ada gets what was collected");
        assertEq(circles.arrears(id, bola), EACH);
        MoneyCircles.Debt[] memory debts = circles.debtsOf(id, bola);
        assertEq(debts.length, 1);
        assertEq(debts[0].creditor, ada);
    }

    function test_behindWhenTheirTurnComes_movesToTheEnd_thenCatchesUp() public {
        uint256 id = _running(30e6, 0, 30e6);
        circles.collect(id); // Ada's round; Bola misses

        // Round 2 is Bola's turn, but Bola is behind: Chidi goes instead.
        usdc.mint(bola, 10e6); // enough for this round, not the arrears
        vm.warp(block.timestamp + WEEK);
        circles.collect(id);
        assertEq(usdc.balanceOf(chidi), 10e6 + _net(30e6), "Chidi went in Bola's place");
        address[] memory queue = circles.payoutQueue(id);
        assertEq(queue.length, 1);
        assertEq(queue[0], bola);

        // Bola catches up; the money goes straight to Ada, who was shorted.
        usdc.mint(bola, 10e6);
        uint256 adaBefore = usdc.balanceOf(ada);
        vm.prank(stranger); // a keeper may trigger it
        circles.catchUp(id, bola);
        assertEq(usdc.balanceOf(ada), adaBefore + EACH);
        assertEq(circles.arrears(id, bola), 0);

        // Last round: Bola pays in and is paid in full.
        usdc.mint(bola, 10e6);
        vm.warp(block.timestamp + WEEK);
        circles.collect(id);
        assertEq(usdc.balanceOf(bola), _net(30e6));
    }

    function test_stillBehindAtTheEnd_debtsComeOutOfTheirPayout() public {
        uint256 id = _running(30e6, 0, 30e6);
        circles.collect(id); // Bola misses Ada's round

        vm.warp(block.timestamp + WEEK);
        circles.collect(id); // Bola misses again; Chidi paid instead
        assertEq(circles.arrears(id, bola), 2 * EACH);

        // Last round, only Bola left. Bola pays this round, and the pot
        // settles what Bola owes Ada and Chidi before Bola gets the rest.
        usdc.mint(bola, 10e6);
        uint256 adaBefore = usdc.balanceOf(ada);
        uint256 chidiBefore = usdc.balanceOf(chidi);
        vm.warp(block.timestamp + WEEK);
        circles.collect(id);
        assertEq(usdc.balanceOf(ada), adaBefore - EACH + EACH, "Ada pays in and is repaid");
        assertEq(usdc.balanceOf(chidi), chidiBefore - EACH + EACH, "Chidi pays in and is repaid");
        assertEq(usdc.balanceOf(bola), _net(10e6), "Bola gets what is left");
        assertEq(circles.arrears(id, bola), 0);
        assertEq(usdc.balanceOf(address(circles)), 0);
    }

    function test_missingYourOwnRound_isNotADebtToYourself() public {
        // Ada cannot pay in her own round, and she is the first in line; with
        // others not behind, she is moved to the end.
        uint256 id = _running(0, 30e6, 30e6);
        circles.collect(id);
        assertEq(usdc.balanceOf(bola), 20e6 + _net(20e6), "Bola went first");
        MoneyCircles.Debt[] memory debts = circles.debtsOf(id, ada);
        assertEq(debts.length, 1);
        assertEq(debts[0].creditor, bola);
    }

    function test_noOneCanTakeThePot() public {
        uint256 id = _running(30e6, 30e6, 30e6);
        vm.prank(stranger);
        circles.collect(id);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(address(circles)), 0);
        // A stranger triggering a catch-up moves nobody's money to themselves.
        vm.prank(stranger);
        assertEq(circles.catchUp(id, bola), 0);
    }
}
