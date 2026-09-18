// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentEscrowV3} from "../src/PaymentEscrowV3.sol";
import {MockUSDC, MockRegistry} from "./PaymentEscrowV2.t.sol";

/**
 * V3 keeps every V2 guarantee and adds two attestor functions. The tests for
 * the new functions are weighted towards what must never change because of
 * them: an early refund can only ever reach the payer, and an extension can
 * only ever delay a refund by a bounded amount.
 */
contract PaymentEscrowV3Test is Test {
    MockUSDC usdc;
    MockRegistry registry;
    PaymentEscrowV3 escrow;

    address payer = address(0xA11CE);
    address worker = address(0xB0B);
    address attacker = address(0xBAD);
    address attestor = address(0xA77E);
    address admin = address(0xAD11);

    bytes32 constant WORKER_KEY = keccak256("email:worker@example.com");
    uint128 constant AMOUNT = 25_000_000; // 25 USDC
    uint256 constant START = 1_000_000_000;

    function setUp() public {
        usdc = new MockUSDC();
        registry = new MockRegistry();
        escrow = new PaymentEscrowV3(address(usdc), address(registry), attestor, admin);

        usdc.mint(payer, START);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _create(uint64 expiry) internal returns (uint256 id) {
        vm.prank(payer);
        id = escrow.createTransfer(WORKER_KEY, AMOUNT, expiry, "logo work");
    }

    function _expiresAt(uint256 id) internal view returns (uint64 expiresAt) {
        (,,,, expiresAt,,) = escrow.transfers(id);
    }

    function _status(uint256 id) internal view returns (PaymentEscrowV3.Status status) {
        (,,,,, status,) = escrow.transfers(id);
    }

    // ------------------------------------------------------- V2 guarantees

    function test_claimPaysOnlyTheRegisteredRecipient() public {
        uint256 id = _create(7 days);
        registry.link(WORKER_KEY, worker);

        vm.prank(attestor);
        vm.expectRevert(PaymentEscrowV3.ClaimerNotRecipient.selector);
        escrow.claimWithAttestation(id, attacker);

        vm.prank(attestor);
        escrow.claimWithAttestation(id, worker);
        assertEq(usdc.balanceOf(worker), AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_claimStillWorksAfterExpiry() public {
        uint256 id = _create(7 days);
        registry.link(WORKER_KEY, worker);
        vm.warp(block.timestamp + 30 days);

        vm.prank(attestor);
        escrow.claimWithAttestation(id, worker);
        assertEq(usdc.balanceOf(worker), AMOUNT);
    }

    function test_anyoneCanRefundAfterExpiryButOnlyThePayerIsPaid() public {
        uint256 id = _create(7 days);
        vm.expectRevert(PaymentEscrowV3.TransferNotExpired.selector);
        escrow.refund(id);

        vm.warp(block.timestamp + 8 days);
        vm.prank(attacker);
        escrow.refund(id);
        assertEq(usdc.balanceOf(payer), START);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_createRejectsAnExpiryBeyondTheCeiling() public {
        vm.prank(payer);
        vm.expectRevert(PaymentEscrowV3.InvalidExpiry.selector);
        escrow.createTransfer(WORKER_KEY, AMOUNT, 366 days, "");
    }

    // ------------------------------------------------------- early refund

    function test_attestorCanReturnAHoldToThePayerBeforeExpiry() public {
        // The reason V3 exists: a cancelled cooling-off payment or a conceded
        // job no longer waits for the hold's expiry to go home.
        uint256 id = _create(90 days);

        vm.expectEmit(true, true, false, true);
        emit PaymentEscrowV3.TransferRefundedEarly(id, payer, AMOUNT);
        vm.prank(attestor);
        escrow.refundWithAttestation(id);

        assertEq(usdc.balanceOf(payer), START);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(_status(id)), uint8(PaymentEscrowV3.Status.Refunded));
    }

    function test_onlyTheAttestorCanRefundEarly() public {
        uint256 id = _create(90 days);
        vm.prank(payer);
        vm.expectRevert(PaymentEscrowV3.NotAttestor.selector);
        escrow.refundWithAttestation(id);

        vm.prank(attacker);
        vm.expectRevert(PaymentEscrowV3.NotAttestor.selector);
        escrow.refundWithAttestation(id);
    }

    function test_anEarlyRefundNeverPaysTheWorkerOrTheAttestor() public {
        uint256 id = _create(90 days);
        registry.link(WORKER_KEY, worker);

        vm.prank(attestor);
        escrow.refundWithAttestation(id);

        assertEq(usdc.balanceOf(worker), 0);
        assertEq(usdc.balanceOf(attestor), 0);
        assertEq(usdc.balanceOf(payer), START);
    }

    function test_aClaimedHoldCannotBeRefundedEarly() public {
        uint256 id = _create(90 days);
        registry.link(WORKER_KEY, worker);
        vm.startPrank(attestor);
        escrow.claimWithAttestation(id, worker);
        vm.expectRevert(PaymentEscrowV3.TransferNotPending.selector);
        escrow.refundWithAttestation(id);
        vm.stopPrank();
    }

    function test_anEarlyRefundedHoldCannotBeClaimedOrRefundedAgain() public {
        uint256 id = _create(90 days);
        registry.link(WORKER_KEY, worker);
        vm.startPrank(attestor);
        escrow.refundWithAttestation(id);
        vm.expectRevert(PaymentEscrowV3.TransferNotPending.selector);
        escrow.claimWithAttestation(id, worker);
        vm.expectRevert(PaymentEscrowV3.TransferNotPending.selector);
        escrow.refundWithAttestation(id);
        vm.stopPrank();

        vm.warp(block.timestamp + 91 days);
        vm.expectRevert(PaymentEscrowV3.TransferNotPending.selector);
        escrow.refund(id);
        assertEq(usdc.balanceOf(payer), START, "paid back exactly once");
    }

    // ------------------------------------------------------------- extend

    function test_extendingExpiryKeepsARefundClosedDuringReview() public {
        // A payer who cancels after delivery goes to manual review. Without an
        // extension they could wait out the review and refund at expiry.
        uint256 id = _create(7 days);
        uint64 later = _expiresAt(id) + 14 days;

        vm.prank(attestor);
        escrow.extendExpiry(id, later);
        assertEq(_expiresAt(id), later);

        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(PaymentEscrowV3.TransferNotExpired.selector);
        escrow.refund(id);

        vm.warp(uint256(later) + 1);
        escrow.refund(id);
        assertEq(usdc.balanceOf(payer), START);
    }

    function test_expiryCanOnlyMoveLater() public {
        uint256 id = _create(7 days);
        uint64 current = _expiresAt(id);

        vm.startPrank(attestor);
        vm.expectRevert(PaymentEscrowV3.InvalidExpiry.selector);
        escrow.extendExpiry(id, current);
        vm.expectRevert(PaymentEscrowV3.InvalidExpiry.selector);
        escrow.extendExpiry(id, current - 1);
        vm.stopPrank();
    }

    function test_expiryCannotPassTheCeilingMeasuredFromCreation() public {
        uint256 id = _create(90 days);
        (,,, uint64 createdAt,,,) = escrow.transfers(id);
        // Read before expectRevert: the cheatcode applies to the next call,
        // and a view call in the argument list would otherwise be that call.
        uint64 ceiling = createdAt + escrow.MAX_EXPIRY();

        vm.startPrank(attestor);
        vm.expectRevert(PaymentEscrowV3.InvalidExpiry.selector);
        escrow.extendExpiry(id, ceiling + 1);

        escrow.extendExpiry(id, ceiling);
        vm.stopPrank();
        assertEq(_expiresAt(id), ceiling);
    }

    function test_onlyTheAttestorCanExtend() public {
        uint256 id = _create(7 days);
        uint64 later = _expiresAt(id) + 1 days;
        vm.prank(payer);
        vm.expectRevert(PaymentEscrowV3.NotAttestor.selector);
        escrow.extendExpiry(id, later);
    }

    function test_aSettledHoldCannotBeExtended() public {
        uint256 id = _create(7 days);
        uint64 later = _expiresAt(id) + 1 days;
        vm.startPrank(attestor);
        escrow.refundWithAttestation(id);
        vm.expectRevert(PaymentEscrowV3.TransferNotPending.selector);
        escrow.extendExpiry(id, later);
        vm.stopPrank();
    }

    function test_anExpiredHoldCanStillBeExtendedUntilSomeoneRefundsIt() public {
        // Expiry only opens the refund; the hold stays pending until a refund
        // actually runs, so a review that runs late can still protect it.
        uint256 id = _create(7 days);
        vm.warp(block.timestamp + 8 days);
        vm.prank(attestor);
        escrow.extendExpiry(id, uint64(block.timestamp) + 7 days);

        vm.expectRevert(PaymentEscrowV3.TransferNotExpired.selector);
        escrow.refund(id);
    }

    // --------------------------------------------------------------- admin

    function test_onlyAdminRotatesTheAttestor() public {
        vm.prank(attacker);
        vm.expectRevert(PaymentEscrowV3.NotAdmin.selector);
        escrow.setClaimAttestor(attacker);

        vm.prank(admin);
        escrow.setClaimAttestor(address(0xFEED));
        assertEq(escrow.claimAttestor(), address(0xFEED));
    }

    // ---------------------------------------------------------------- fuzz

    /// Whatever the attestor does, money ends with the worker or the payer.
    function testFuzz_moneyOnlyEverReachesTheWorkerOrThePayer(
        uint128 amount,
        uint64 expiry,
        uint8 path,
        uint64 extendBy
    ) public {
        amount = uint128(bound(amount, 1, START));
        expiry = uint64(bound(expiry, 1, escrow.MAX_EXPIRY()));
        path = uint8(bound(path, 0, 2));

        vm.prank(payer);
        uint256 id = escrow.createTransfer(WORKER_KEY, amount, expiry, "");
        registry.link(WORKER_KEY, worker);
        (,,, uint64 createdAt, uint64 expiresAt,,) = escrow.transfers(id);

        uint64 room = createdAt + escrow.MAX_EXPIRY() - expiresAt;
        if (room > 0) {
            extendBy = uint64(bound(extendBy, 1, room));
            vm.prank(attestor);
            escrow.extendExpiry(id, expiresAt + extendBy);
        }

        uint256 payerBefore = usdc.balanceOf(payer);
        if (path == 0) {
            vm.prank(attestor);
            escrow.claimWithAttestation(id, worker);
            assertEq(usdc.balanceOf(worker), amount);
        } else if (path == 1) {
            vm.prank(attestor);
            escrow.refundWithAttestation(id);
            assertEq(usdc.balanceOf(payer), payerBefore + amount);
        } else {
            vm.warp(uint256(_expiresAt(id)) + 1);
            escrow.refund(id);
            assertEq(usdc.balanceOf(payer), payerBefore + amount);
        }
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(attestor), 0);
        assertEq(usdc.balanceOf(attacker), 0);
    }
}
