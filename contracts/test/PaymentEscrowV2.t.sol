// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentEscrowV2} from "../src/PaymentEscrowV2.sol";

/// Minimal USDC: 6 decimals, returns bool, no hooks — like the real one on Arc.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Stands in for IdentityRegistry: a key resolves to an account, or it does not.
contract MockRegistry {
    mapping(bytes32 => address) public account;
    mapping(bytes32 => bool) public active;

    function link(bytes32 key, address who) external {
        account[key] = who;
        active[key] = true;
    }

    function deactivate(bytes32 key) external {
        active[key] = false;
    }

    function resolve(bytes32 key) external view returns (address, bool) {
        return (account[key], active[key]);
    }
}

/**
 * The first tests these contracts have ever had.
 *
 * Weighted towards the three things V1 got wrong, because those are the ones
 * that cost real money on Arc: an unenforced recipient binding, a claim that
 * died at expiry, and holds too short to cover real work.
 */
contract PaymentEscrowV2Test is Test {
    MockUSDC usdc;
    MockRegistry registry;
    PaymentEscrowV2 escrow;

    address payer = address(0xA11CE);
    address worker = address(0xB0B);
    address attacker = address(0xBAD);
    address attestor = address(0xA77E);
    address admin = address(0xAD11);

    bytes32 constant WORKER_KEY = keccak256("email:worker@example.com");
    uint128 constant AMOUNT = 25_000_000; // 25 USDC

    function setUp() public {
        usdc = new MockUSDC();
        registry = new MockRegistry();
        escrow = new PaymentEscrowV2(address(usdc), address(registry), attestor, admin);

        usdc.mint(payer, 1_000_000_000);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _create(uint64 expiry) internal returns (uint256 id) {
        vm.prank(payer);
        id = escrow.createTransfer(WORKER_KEY, AMOUNT, expiry, "logo work");
    }

    // ---------------------------------------------------------------- create

    function test_createPullsFundsAndRecordsTheHold() public {
        uint256 id = _create(7 days);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - AMOUNT);
        (address sender,, uint128 amount,,, PaymentEscrowV2.Status status,) = escrow.transfers(id);
        assertEq(sender, payer);
        assertEq(amount, AMOUNT);
        assertEq(uint8(status), uint8(PaymentEscrowV2.Status.Pending));
    }

    function test_createRejectsZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(PaymentEscrowV2.ZeroAmount.selector);
        escrow.createTransfer(WORKER_KEY, 0, 7 days, "");
    }

    function test_createRejectsAnEmptyRecipientKey() public {
        // Without this, a hold could be created that no identity can ever
        // claim — which is how the first stranded transfer happened.
        vm.prank(payer);
        vm.expectRevert(PaymentEscrowV2.ZeroAddress.selector);
        escrow.createTransfer(bytes32(0), AMOUNT, 7 days, "");
    }

    function test_holdsCanNowLastLongerThanTwoWeeks() public {
        // The V1 ceiling was 14 days, which is too short for real work and
        // could not be raised without redeploying.
        uint256 id = _create(90 days);
        (,,,, uint64 expiresAt,,) = escrow.transfers(id);
        assertEq(expiresAt, uint64(block.timestamp) + 90 days);
    }

    function test_createRejectsAnExpiryBeyondTheCeiling() public {
        vm.prank(payer);
        vm.expectRevert(PaymentEscrowV2.InvalidExpiry.selector);
        escrow.createTransfer(WORKER_KEY, AMOUNT, 366 days, "");
    }

    function test_zeroExpiryFallsBackToTheDefault() public {
        uint256 id = _create(0);
        (,,,, uint64 expiresAt,,) = escrow.transfers(id);
        assertEq(expiresAt, uint64(block.timestamp) + escrow.DEFAULT_EXPIRY());
    }

    // ----------------------------------------------------------------- claim

    function test_claimPaysTheRegisteredRecipient() public {
        uint256 id = _create(7 days);
        registry.link(WORKER_KEY, worker);

        vm.prank(attestor);
        escrow.claimWithAttestation(id, worker);

        assertEq(usdc.balanceOf(worker), AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_attestorCannotRedirectFundsToAnyoneElse() public {
        // The V1 hole: claimWithAttestation paid whatever address it was
        // handed and never looked at recipientKey, so a compromised attestor
        // key could drain every pending transfer.
        uint256 id = _create(7 days);
        registry.link(WORKER_KEY, worker);

        vm.prank(attestor);
        vm.expectRevert(PaymentEscrowV2.ClaimerNotRecipient.selector);
        escrow.claimWithAttestation(id, attacker);

        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function test_claimFailsUntilTheRecipientHasRegistered() public {
        // The claim-link case: money waits until they sign up and prove the
        // identity it was locked for.
        uint256 id = _create(7 days);
        vm.prank(attestor);
        vm.expectRevert(PaymentEscrowV2.RecipientNotRegistered.selector);
        escrow.claimWithAttestation(id, worker);
    }

    function test_claimFailsOnAnIdentityThatHasBeenDeactivated() public {
        uint256 id = _create(7 days);
        registry.link(WORKER_KEY, worker);
        registry.deactivate(WORKER_KEY);

        vm.prank(attestor);
        vm.expectRevert(PaymentEscrowV2.RecipientNotRegistered.selector);
        escrow.claimWithAttestation(id, worker);
    }

    function test_onlyTheAttestorCanRelease() public {
        uint256 id = _create(7 days);
        registry.link(WORKER_KEY, worker);

        vm.prank(attacker);
        vm.expectRevert(PaymentEscrowV2.NotAttestor.selector);
        escrow.claimWithAttestation(id, worker);
    }

    function test_aHoldCannotBeClaimedTwice() public {
        uint256 id = _create(7 days);
        registry.link(WORKER_KEY, worker);

        vm.startPrank(attestor);
        escrow.claimWithAttestation(id, worker);
        vm.expectRevert(PaymentEscrowV2.TransferNotPending.selector);
        escrow.claimWithAttestation(id, worker);
        vm.stopPrank();
    }

    function test_workDeliveredOnTimeIsStillPayableAfterTheDeadline() public {
        // The V1 cliff: claim reverted the instant a hold expired, so a job
        // delivered on the last day but released a day late became refundable
        // with the work already done.
        uint256 id = _create(7 days);
        registry.link(WORKER_KEY, worker);
        vm.warp(block.timestamp + 30 days);

        vm.prank(attestor);
        escrow.claimWithAttestation(id, worker);
        assertEq(usdc.balanceOf(worker), AMOUNT);
    }

    // ---------------------------------------------------------------- refund

    function test_refundReturnsTheMoneyToThePayerAfterExpiry() public {
        uint256 id = _create(7 days);
        vm.warp(block.timestamp + 8 days);

        escrow.refund(id);
        assertEq(usdc.balanceOf(payer), 1_000_000_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_refundIsRejectedBeforeExpiry() public {
        uint256 id = _create(7 days);
        vm.expectRevert(PaymentEscrowV2.TransferNotExpired.selector);
        escrow.refund(id);
    }

    function test_anyoneMayTriggerARefundButOnlyThePayerReceivesIt() public {
        // Permissionless so a keeper can sweep. Safe because the destination
        // is the original sender, not the caller.
        uint256 id = _create(7 days);
        vm.warp(block.timestamp + 8 days);

        vm.prank(attacker);
        escrow.refund(id);

        assertEq(usdc.balanceOf(payer), 1_000_000_000);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_aClaimedHoldCannotThenBeRefunded() public {
        uint256 id = _create(7 days);
        registry.link(WORKER_KEY, worker);
        vm.prank(attestor);
        escrow.claimWithAttestation(id, worker);

        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(PaymentEscrowV2.TransferNotPending.selector);
        escrow.refund(id);
    }

    function test_aRefundedHoldCannotThenBeClaimed() public {
        uint256 id = _create(7 days);
        registry.link(WORKER_KEY, worker);
        vm.warp(block.timestamp + 8 days);
        escrow.refund(id);

        vm.prank(attestor);
        vm.expectRevert(PaymentEscrowV2.TransferNotPending.selector);
        escrow.claimWithAttestation(id, worker);
    }

    // ----------------------------------------------------------------- views

    function test_claimTargetReportsWhereAClaimWouldGo() public {
        uint256 id = _create(7 days);
        (address who, bool claimable) = escrow.claimTarget(id);
        assertEq(who, address(0));
        assertFalse(claimable, "not claimable before the recipient registers");

        registry.link(WORKER_KEY, worker);
        (who, claimable) = escrow.claimTarget(id);
        assertEq(who, worker);
        assertTrue(claimable);
    }

    // ----------------------------------------------------------------- admin

    function test_onlyAdminRotatesTheAttestor() public {
        vm.prank(attacker);
        vm.expectRevert(PaymentEscrowV2.NotAdmin.selector);
        escrow.setClaimAttestor(attacker);

        vm.prank(admin);
        escrow.setClaimAttestor(address(0xFEED));
        assertEq(escrow.claimAttestor(), address(0xFEED));
    }

    function test_transferIdsDoNotCollide() public {
        uint256 a = _create(7 days);
        uint256 b = _create(7 days);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT * 2);
    }

    // ----------------------------------------------------------------- fuzz

    function testFuzz_everyHoldIsEitherClaimedByItsRecipientOrReturned(
        uint128 amount,
        uint64 expiry,
        bool claimIt
    ) public {
        amount = uint128(bound(amount, 1, 1_000_000_000));
        expiry = uint64(bound(expiry, 1, escrow.MAX_EXPIRY()));

        vm.prank(payer);
        uint256 id = escrow.createTransfer(WORKER_KEY, amount, expiry, "");
        registry.link(WORKER_KEY, worker);

        uint256 payerBefore = usdc.balanceOf(payer);
        if (claimIt) {
            vm.prank(attestor);
            escrow.claimWithAttestation(id, worker);
            assertEq(usdc.balanceOf(worker), amount);
        } else {
            vm.warp(block.timestamp + expiry + 1);
            escrow.refund(id);
            assertEq(usdc.balanceOf(payer), payerBefore + amount);
        }
        // Either way the contract keeps nothing.
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }
}
