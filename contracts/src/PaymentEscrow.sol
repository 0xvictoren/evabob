// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title PaymentEscrow
 * @notice Holds USDC for recipients who are not yet registered ("protected transfer").
 * @dev Product copy: "protected transfer" / "claim link" — never surface "escrow" in UI.
 *
 * Flow:
 *  1. Sender creates a transfer with recipient identity hash (+ optional password hash).
 *  2. USDC is pulled from sender (approve + create) into this contract.
 *  3. Recipient claims with identity proof (backend-attested claimer) or password.
 *  4. After `expiry`, sender (or keeper) refunds unclaimed funds.
 *
 * Arc notes:
 *  - USDC ERC-20: 0x3600000000000000000000000000000000000000 (6 decimals)
 *  - Gas is also USDC (native view, 18 decimals) — do not mix decimal systems.
 */
contract PaymentEscrow {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint64 public constant DEFAULT_EXPIRY = 3 days;
    uint64 public constant MAX_EXPIRY = 14 days;

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
        bytes32 recipientKey; // IdentityRegistry key (hashed contact)
        uint128 amount; // USDC 6-decimal raw units
        uint64 createdAt;
        uint64 expiresAt;
        bytes32 passwordHash; // bytes32(0) = no password
        Status status;
        string memo; // short user memo (keep small)
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    IERC20 public immutable usdc;
    address public claimAttestor; // backend signer / relayer that validates OTP claim
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
        bool passwordProtected
    );

    event TransferClaimed(
        uint256 indexed transferId,
        address indexed claimer,
        uint128 amount
    );

    event TransferRefunded(
        uint256 indexed transferId,
        address indexed sender,
        uint128 amount
    );

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
    error TransferExpired();
    error TransferNotExpired();
    error BadPassword();
    error NotSender();
    error TransferFailed();

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

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @param usdc_ Arc USDC ERC-20 address
     * @param claimAttestor_ Backend/relayer authorized to complete OTP claims
     * @param admin_ Admin for config updates
     */
    constructor(address usdc_, address claimAttestor_, address admin_) {
        if (usdc_ == address(0) || claimAttestor_ == address(0) || admin_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20(usdc_);
        claimAttestor = claimAttestor_;
        admin = admin_;
    }

    // -------------------------------------------------------------------------
    // Create
    // -------------------------------------------------------------------------

    /**
     * @notice Create a protected transfer. Sender must have approved `amount` USDC.
     * @param recipientKey Identity hash of intended recipient
     * @param amount USDC amount in 6-decimal base units
     * @param expirySeconds Duration until auto-refund (default 3 days if 0)
     * @param passwordHash Optional keccak256(password); bytes32(0) for none
     * @param memo Short description (e.g. "Food money")
     */
    function createTransfer(
        bytes32 recipientKey,
        uint128 amount,
        uint64 expirySeconds,
        bytes32 passwordHash,
        string calldata memo
    ) external returns (uint256 transferId) {
        if (amount == 0) revert ZeroAmount();
        if (expirySeconds == 0) expirySeconds = DEFAULT_EXPIRY;
        if (expirySeconds > MAX_EXPIRY) revert InvalidExpiry();

        // Pull USDC from sender
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
            passwordHash: passwordHash,
            status: Status.Pending,
            memo: memo
        });

        emit TransferCreated(
            transferId,
            msg.sender,
            recipientKey,
            amount,
            exp,
            passwordHash != bytes32(0)
        );
    }

    // -------------------------------------------------------------------------
    // Claim
    // -------------------------------------------------------------------------

    /**
     * @notice Claim via backend attestor after off-chain identity verification.
     * @dev Attestor is a trusted relayer that has verified OTP/email/social.
     *      `claimer` receives the USDC (their smart account).
     */
    function claimWithAttestation(uint256 transferId, address claimer)
        external
        onlyAttestor
    {
        if (claimer == address(0)) revert ZeroAddress();
        Transfer storage t = transfers[transferId];
        if (t.status != Status.Pending) revert TransferNotPending();
        if (block.timestamp > t.expiresAt) revert TransferExpired();

        t.status = Status.Claimed;
        uint128 amount = t.amount;

        bool ok = usdc.transfer(claimer, amount);
        if (!ok) revert TransferFailed();

        emit TransferClaimed(transferId, claimer, amount);
    }

    /**
     * @notice Claim with password if the send was password-protected.
     * @dev Caller should be the recipient's account; password checked on-chain.
     */
    function claimWithPassword(uint256 transferId, string calldata password)
        external
    {
        Transfer storage t = transfers[transferId];
        if (t.status != Status.Pending) revert TransferNotPending();
        if (block.timestamp > t.expiresAt) revert TransferExpired();
        if (t.passwordHash == bytes32(0)) revert BadPassword();
        if (keccak256(bytes(password)) != t.passwordHash) revert BadPassword();

        t.status = Status.Claimed;
        uint128 amount = t.amount;

        bool ok = usdc.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit TransferClaimed(transferId, msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // Refund
    // -------------------------------------------------------------------------

    /**
     * @notice Refund sender after expiry. Callable by sender or anyone (keeper).
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
    // Admin
    // -------------------------------------------------------------------------

    function setClaimAttestor(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        address prev = claimAttestor;
        claimAttestor = next;
        emit ClaimAttestorUpdated(prev, next);
    }

    function setAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        address prev = admin;
        admin = next;
        emit AdminUpdated(prev, next);
    }
}
