// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {EvabobMemo} from "../src/EvabobMemo.sol";

/// Stands in for a Circle smart contract account: runs calls in order as itself.
contract MockWallet {
    function executeBatch(address[] calldata targets, bytes[] calldata data) external {
        for (uint256 i = 0; i < targets.length; i++) {
            (bool ok, bytes memory ret) = targets[i].call(data[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract EvabobMemoTest is Test {
    EvabobMemo memo;
    MockWallet wallet;
    MockToken usdc;
    address payee = address(0xBEEF);

    bytes32 constant ARC_MEMO_TOPIC =
        keccak256("Memo(address,address,bytes32,bytes32,bytes,uint256)");

    function setUp() public {
        memo = new EvabobMemo();
        wallet = new MockWallet();
        usdc = new MockToken();
        usdc.mint(address(wallet), 10_000_000);
    }

    function _transfer(uint256 amount) internal view returns (bytes memory) {
        return abi.encodeCall(MockToken.transfer, (payee, amount));
    }

    function test_emitsArcsMemoEventWithTheWalletAsSender() public {
        bytes memory data = _transfer(1_000_000);
        bytes32 memoId = keccak256("evabob:activity-1");

        vm.recordLogs();
        vm.prank(address(wallet));
        memo.record(address(usdc), keccak256(data), memoId, bytes("Rent, second half"));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], ARC_MEMO_TOPIC, "same event as Arc's memo contract");
        assertEq(address(uint160(uint256(logs[0].topics[1]))), address(wallet));
        assertEq(address(uint160(uint256(logs[0].topics[2]))), address(usdc));
        assertEq(logs[0].topics[3], memoId);
        (bytes32 callDataHash, bytes memory text, uint256 index) =
            abi.decode(logs[0].data, (bytes32, bytes, uint256));
        assertEq(callDataHash, keccak256(data));
        assertEq(string(text), "Rent, second half");
        assertEq(index, 0);
    }

    function test_memoAndPaymentLandTogetherInOneBatch() public {
        bytes memory data = _transfer(2_500_000);
        address[] memory targets = new address[](2);
        bytes[] memory calls = new bytes[](2);
        targets[0] = address(usdc);
        calls[0] = data;
        targets[1] = address(memo);
        calls[1] = abi.encodeCall(
            EvabobMemo.record, (address(usdc), keccak256(data), bytes32("id"), bytes("Dinner"))
        );

        wallet.executeBatch(targets, calls);

        assertEq(usdc.balanceOf(payee), 2_500_000);
        assertEq(memo.memoCount(), 1);
    }

    function test_aRejectedMemoUndoesThePayment() public {
        bytes memory data = _transfer(2_500_000);
        address[] memory targets = new address[](2);
        bytes[] memory calls = new bytes[](2);
        targets[0] = address(usdc);
        calls[0] = data;
        targets[1] = address(memo);
        calls[1] = abi.encodeCall(
            EvabobMemo.record, (address(usdc), keccak256(data), bytes32("id"), bytes(""))
        );

        vm.expectRevert(EvabobMemo.EmptyMemo.selector);
        wallet.executeBatch(targets, calls);

        assertEq(usdc.balanceOf(payee), 0, "no payment without its memo");
    }

    function test_indicesIncrease() public {
        memo.record(address(usdc), bytes32("a"), bytes32(0), bytes("one"));
        uint256 second = memo.record(address(usdc), bytes32("b"), bytes32(0), bytes("two"));
        assertEq(second, 1);
        assertEq(memo.memoCount(), 2);
    }

    function test_rejectsAnEmptyMemo() public {
        vm.expectRevert(EvabobMemo.EmptyMemo.selector);
        memo.record(address(usdc), bytes32("a"), bytes32(0), bytes(""));
    }

    function test_rejectsAMemoOverTheLimit() public {
        bytes memory long = new bytes(513);
        vm.expectRevert(abi.encodeWithSelector(EvabobMemo.MemoTooLong.selector, 513));
        memo.record(address(usdc), bytes32("a"), bytes32(0), long);
    }

    function test_acceptsAMemoAtTheLimit() public {
        memo.record(address(usdc), bytes32("a"), bytes32(0), new bytes(512));
        assertEq(memo.memoCount(), 1);
    }

    function test_rejectsAMissingTarget() public {
        vm.expectRevert(EvabobMemo.MissingTarget.selector);
        memo.record(address(0), bytes32("a"), bytes32(0), bytes("x"));
    }

    function test_rejectsAMissingCallDataHash() public {
        vm.expectRevert(EvabobMemo.MissingCallDataHash.selector);
        memo.record(address(usdc), bytes32(0), bytes32(0), bytes("x"));
    }
}
