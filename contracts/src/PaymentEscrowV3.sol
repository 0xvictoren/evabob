// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

interface IIdentityRegistryV3 {
    function resolve(bytes32 key) external view returns (address account, bool active);
}

/**
 * @title PaymentEscrowV3
 * @notice Holds USDC until it is claimed by the identity it was locked for, or
 *         returned to the sender.
 *
 * Everything in PaymentEscrowV2 is unchanged: the registry decides who a claim
 * pays, a claim stays valid for as long as the hold is pending, and anyone may
 * refund an expired hold because a refund only ever pays the original sender.
 *
 * V2 had one gap the product could not work around. Money could only go back
 * to the payer once a hold expired, so every "give it back now" waited for the
 * clock: a sender cancelling a first-time payment inside its cooling-off
 * window, a worker agreeing to refund a job, or a reviewed dispute decided for
 * the payer. For a 90-day job hold that is up to three months of someone's
 * money locked after everyone has agreed where it goes.
 *
 * Two attestor functions close it, and neither widens who can be paid:
 *
 *  - refundWithAttestation returns a pending hold to its sender before
 *    expiry. The destination is fixed to the original sender, exactly as for
 *    refund, so the worst a compromised attestor can do is return held money
 *    to the people who paid it.
 *
 *  - extendExpiry pushes a pending hold's expiry later, never earlier, and
 *    never beyond MAX_EXPIRY after it was created. A payer who cancels after
 *    the work was marked delivered goes to manual review; without this they
 *    could simply wait out the review and take the refund at expiry. The cap
 *    bounds the worst case of a compromised attestor to delaying a refund.
 *
 * Arc notes:
 *  - USDC ERC-20: 0x3600000000000000000000000000000000000000 (6 decimals)
 *  - Gas is also USDC (native view, 18 decimals) — do not mix decimal systems.
 */
contract PaymentEscrowV3 {
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
    IIdentityRegistryV3 public immutable registry;
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
    /// @notice A pending hold returned to its sender before expiry.
    event TransferRefundedEarly(uint256 indexed transferId, address indexed sender, uint128 amount);
    event ExpiryExtended(uint256 indexed transferId, uint64 previousExpiresAt, uint64 expiresAt);
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
        registry = IIdentityRegistryV3(registry_);
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
     *      destination. Deliberately still valid after `expiresAt`: a job
     *      delivered on time but released late must remain payable.
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
        _refund(transferId, t);
        emit TransferRefunded(transferId, t.sender, t.amount);
    }

    /**
     * @notice Return a pending transfer to its sender now, before it expires.
     * @dev Attestor only. The destination is the original sender and nobody
     *      else, the same as `refund`; the attestor chooses only the moment.
     */
    function refundWithAttestation(uint256 transferId) external onlyAttestor {
        Transfer storage t = transfers[transferId];
        if (t.status != Status.Pending) revert TransferNotPending();
        _refund(transferId, t);
        emit TransferRefundedEarly(transferId, t.sender, t.amount);
    }

    function _refund(uint256, Transfer storage t) private {
        t.status = Status.Refunded;
        bool ok = usdc.transfer(t.sender, t.amount);
        if (!ok) revert TransferFailed();
    }

    // -------------------------------------------------------------------------
    // Expiry
    // -------------------------------------------------------------------------

    /**
     * @notice Move a pending transfer's expiry later, while it is under review.
     * @dev Attestor only. Later only, and never past MAX_EXPIRY after creation,
     *      so no hold can be kept from its sender for longer than the longest
     *      hold anyone could have created in the first place.
     */
    function extendExpiry(uint256 transferId, uint64 newExpiresAt) external onlyAttestor {
        Transfer storage t = transfers[transferId];
        if (t.status != Status.Pending) revert TransferNotPending();
        if (newExpiresAt <= t.expiresAt) revert InvalidExpiry();
        if (newExpiresAt > t.createdAt + MAX_EXPIRY) revert InvalidExpiry();

        uint64 previous = t.expiresAt;
        t.expiresAt = newExpiresAt;
        emit ExpiryExtended(transferId, previous, newExpiresAt);
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
