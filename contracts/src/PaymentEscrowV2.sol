// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

interface IIdentityRegistry {
    function resolve(bytes32 key) external view returns (address account, bool active);
}

/**
 * @title PaymentEscrowV2
 * @notice Holds USDC until it is claimed by the identity it was locked for, or
 *         returned to the sender.
 *
 * Backs two product flows that differ only in what makes the backend attest:
 * paying someone who has no account yet, and holding payment for work until
 * the payer says it arrived.
 *
 * Three things are fixed here relative to the first version, each because of
 * something that actually happened or was found on Arc.
 *
 * 1. The recipient binding is real. V1 stored `recipientKey` and then never
 *    looked at it: `claimWithAttestation` paid whatever address the attestor
 *    passed. The fingerprint was a label, not a lock, so a compromised
 *    attestor key could redirect every pending transfer. Here the claimer must
 *    be the address the IdentityRegistry resolves that key to. The attestor
 *    still decides when a claim happens; it can no longer decide who is paid.
 *
 * 2. Claiming no longer stops at expiry. In V1 claim reverted and refund
 *    opened at the same instant, so a job delivered on the last day but
 *    released a day late became refundable with the work already done. A claim
 *    is now valid for as long as the transfer is still pending. Refund remains
 *    available after expiry, and since it only ever pays the sender, the worst
 *    outcome of the two racing is that the payer gets their own money back.
 *
 * 3. claimWithPassword is gone. It took the password as plaintext calldata and
 *    paid msg.sender, so anyone watching the mempool could read it and
 *    front-run the claim.
 *
 * MAX_EXPIRY is also raised from 14 days, which was too short to hold payment
 * for real work and could not be changed without redeploying.
 *
 * Arc notes:
 *  - USDC ERC-20: 0x3600000000000000000000000000000000000000 (6 decimals)
 *  - Gas is also USDC (native view, 18 decimals) — do not mix decimal systems.
 */
contract PaymentEscrowV2 {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint64 public constant DEFAULT_EXPIRY = 7 days;
    uint64 public constant MAX_EXPIRY = 365 days;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum Status {
        None,
        Pending,
        Claimed,
        Refunded
    }

    struct Transfer {
        address sender;
        bytes32 recipientKey;
        uint128 amount;
        uint64 createdAt;
        uint64 expiresAt;
        Status status;
        string memo;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    IERC20 public immutable usdc;
    IIdentityRegistry public immutable registry;
    address public claimAttestor;
    address public admin;

    uint256 public nextTransferId = 1;
    mapping(uint256 => Transfer) public transfers;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event TransferCreated(
        uint256 indexed transferId,
        address indexed sender,
        bytes32 indexed recipientKey,
        uint128 amount,
        uint64 expiresAt,
        string memo
    );

    event TransferClaimed(uint256 indexed transferId, address indexed claimer, uint128 amount);
    event TransferRefunded(uint256 indexed transferId, address indexed sender, uint128 amount);
    event ClaimAttestorUpdated(address indexed previous, address indexed next);
    event AdminUpdated(address indexed previous, address indexed next);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotAdmin();
    error NotAttestor();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidExpiry();
    error TransferNotPending();
    error TransferNotExpired();
    error TransferFailed();
    error RecipientNotRegistered();
    error ClaimerNotRecipient();

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAttestor() {
        if (msg.sender != claimAttestor) revert NotAttestor();
        _;
    }

    constructor(address usdc_, address registry_, address claimAttestor_, address admin_) {
        if (
            usdc_ == address(0) || registry_ == address(0) || claimAttestor_ == address(0)
                || admin_ == address(0)
        ) {
            revert ZeroAddress();
        }
        usdc = IERC20(usdc_);
        registry = IIdentityRegistry(registry_);
        claimAttestor = claimAttestor_;
        admin = admin_;
    }

    // -------------------------------------------------------------------------
    // Create
    // -------------------------------------------------------------------------

    /**
     * @notice Lock USDC for an identity. Sender must have approved `amount`.
     * @param recipientKey IdentityRegistry key of the intended recipient
     * @param amount USDC in 6-decimal base units
     * @param expirySeconds Seconds until refundable (DEFAULT_EXPIRY if 0)
     * @param memo Short description
     */
    function createTransfer(
        bytes32 recipientKey,
        uint128 amount,
        uint64 expirySeconds,
        string calldata memo
    ) external returns (uint256 transferId) {
        if (amount == 0) revert ZeroAmount();
        if (recipientKey == bytes32(0)) revert ZeroAddress();
        if (expirySeconds == 0) expirySeconds = DEFAULT_EXPIRY;
        if (expirySeconds > MAX_EXPIRY) revert InvalidExpiry();

        bool ok = usdc.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        transferId = nextTransferId++;
        uint64 nowTs = uint64(block.timestamp);
        uint64 exp = nowTs + expirySeconds;

        transfers[transferId] = Transfer({
            sender: msg.sender,
            recipientKey: recipientKey,
            amount: amount,
            createdAt: nowTs,
            expiresAt: exp,
            status: Status.Pending,
            memo: memo
        });

        emit TransferCreated(transferId, msg.sender, recipientKey, amount, exp, memo);
    }

    // -------------------------------------------------------------------------
    // Claim
    // -------------------------------------------------------------------------

    /**
     * @notice Release a held transfer to the identity it was locked for.
     * @dev The attestor authorises the moment; the registry decides the
     *      destination. `claimer` is passed so the caller states its intent
     *      explicitly and a changed registry entry cannot silently redirect
     *      funds, but it must equal what the registry resolves.
     *
     *      Deliberately still valid after `expiresAt`: a job delivered on time
     *      but released late must remain payable.
     */
    function claimWithAttestation(uint256 transferId, address claimer) external onlyAttestor {
        if (claimer == address(0)) revert ZeroAddress();
        Transfer storage t = transfers[transferId];
        if (t.status != Status.Pending) revert TransferNotPending();

        (address account, bool active) = registry.resolve(t.recipientKey);
        if (account == address(0) || !active) revert RecipientNotRegistered();
        if (account != claimer) revert ClaimerNotRecipient();

        t.status = Status.Claimed;
        uint128 amount = t.amount;

        bool ok = usdc.transfer(claimer, amount);
        if (!ok) revert TransferFailed();

        emit TransferClaimed(transferId, claimer, amount);
    }

    // -------------------------------------------------------------------------
    // Refund
    // -------------------------------------------------------------------------

    /**
     * @notice Return an expired transfer to its sender.
     * @dev Callable by anyone so a keeper can sweep, which is safe because the
     *      money can only go back to whoever funded it.
     */
    function refund(uint256 transferId) external {
        Transfer storage t = transfers[transferId];
        if (t.status != Status.Pending) revert TransferNotPending();
        if (block.timestamp <= t.expiresAt) revert TransferNotExpired();

        t.status = Status.Refunded;
        uint128 amount = t.amount;
        address sender = t.sender;

        bool ok = usdc.transfer(sender, amount);
        if (!ok) revert TransferFailed();

        emit TransferRefunded(transferId, sender, amount);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Where a claim would pay, and whether it would succeed right now.
    function claimTarget(uint256 transferId)
        external
        view
        returns (address account, bool claimable)
    {
        Transfer storage t = transfers[transferId];
        if (t.status != Status.Pending) return (address(0), false);
        bool active;
        (account, active) = registry.resolve(t.recipientKey);
        claimable = account != address(0) && active;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setClaimAttestor(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        emit ClaimAttestorUpdated(claimAttestor, next);
        claimAttestor = next;
    }

    function setAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        emit AdminUpdated(admin, next);
        admin = next;
    }
}
