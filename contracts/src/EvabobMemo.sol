// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Records a payment memo on chain for a smart contract wallet.
 *
 * Arc's own memo contract (0x5294E9927c3306DcBaDb03fe70b92e01cCede505) wraps
 * the payment call and replays it with the caller as the sender. That replay
 * uses Arc's sender-preserving call, which requires msg.sender == tx.origin.
 * A Circle smart contract account is relayed — tx.origin is the relayer, not
 * the wallet — so the wrapper reverts with "sender spoofing requires tx.origin
 * as sender". Every Evabob wallet is such an account, so the documented
 * wrapper cannot be used from the app. Checked against Arc Testnet on
 * 2026-09-15 with a forwarding contract standing in for the wallet.
 *
 * This contract does not wrap anything; if it made the transfer it would
 * become the sender. Instead the wallet makes the transfer itself and calls
 * `record` in the same `executeBatch`, which is atomic: the memo exists only
 * if the payment landed, and the payment cannot land without its memo.
 *
 * It emits Arc's `Memo` event with the same signature, so one decoder reads
 * memos from either contract. `callDataHash` is keccak256 of the transfer
 * calldata, which lets a reader match the memo to the exact payment in the
 * transaction.
 *
 * A memo is public. Anyone can read it from the chain, forever.
 */
contract EvabobMemo {
    /// Room for 120 characters of any script, emoji included.
    uint256 public constant MAX_MEMO_BYTES = 512;

    uint256 public memoCount;

    event Memo(
        address indexed sender,
        address indexed target,
        bytes32 callDataHash,
        bytes32 indexed memoId,
        bytes memo,
        uint256 memoIndex
    );

    error EmptyMemo();
    error MemoTooLong(uint256 length);
    error MissingTarget();
    error MissingCallDataHash();

    function record(address target, bytes32 callDataHash, bytes32 memoId, bytes calldata memoData)
        external
        returns (uint256 memoIndex)
    {
        if (target == address(0)) revert MissingTarget();
        if (callDataHash == bytes32(0)) revert MissingCallDataHash();
        if (memoData.length == 0) revert EmptyMemo();
        if (memoData.length > MAX_MEMO_BYTES) revert MemoTooLong(memoData.length);

        memoIndex = memoCount++;
        emit Memo(msg.sender, target, callDataHash, memoId, memoData, memoIndex);
    }
}
