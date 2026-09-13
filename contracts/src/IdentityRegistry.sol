// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IdentityRegistry
 * @notice Maps hashed contact identifiers (phone / email / handle) to smart accounts.
 * @dev Identifiers are NEVER stored in cleartext — only keccak256 hashes.
 *      On Arc Testnet, settlement asset is USDC (native gas). This contract is identity-only.
 *
 * User-facing product language: "account" — never expose this contract name in the UI.
 */
contract IdentityRegistry {
    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /**
     * @dev Identity keys are keccak256(abi.encodePacked(uint8(idType), id)),
     *      so these ordinals are baked into every key already written.
     *      NEVER remove or reorder a member: dropping `Phone` would renumber
     *      Email to 0 and Handle to 1, and every existing link would resolve
     *      to nothing or to the wrong account. Add new types at the end only.
     *
     *      `Phone` is retired — the product links email and handle only — but
     *      the slot stays reserved.
     */
    enum IdType {
        Phone, // retired, reserved
        Email,
        Handle
    }

    struct Identity {
        address account; // Circle user-controlled smart account (SCA)
        IdType idType;
        uint64 linkedAt;
        bool active;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    /// @dev keccak256(abi.encodePacked(idType, normalizedIdentifier)) => Identity
    mapping(bytes32 => Identity) private _identities;

    /// @dev account => list of identity keys (for reverse lookup)
    mapping(address => bytes32[]) private _accountKeys;

    /// @dev Optional admin for emergency unlink (multisig recommended in prod)
    address public admin;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event IdentityLinked(
        bytes32 indexed identityKey,
        address indexed account,
        IdType idType,
        uint64 linkedAt
    );

    event IdentityUnlinked(
        bytes32 indexed identityKey,
        address indexed account
    );

    event AdminUpdated(address indexed previousAdmin, address indexed newAdmin);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotAdmin();
    error ZeroAddress();
    error AlreadyLinked();
    error NotLinked();
    error EmptyIdentifier();

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /**
     * @notice Build the storage key for an identifier.
     * @param idType Type of contact identifier
     * @param normalizedIdentifier Lowercased/trimmed identifier bytes (UTF-8)
     */
    function identityKey(IdType idType, bytes calldata normalizedIdentifier)
        public
        pure
        returns (bytes32)
    {
        if (normalizedIdentifier.length == 0) revert EmptyIdentifier();
        return keccak256(abi.encodePacked(uint8(idType), normalizedIdentifier));
    }

    /**
     * @notice Resolve an identifier hash to an account address (address(0) if none).
     */
    function resolve(bytes32 key) external view returns (address account, bool active) {
        Identity memory id = _identities[key];
        return (id.account, id.active);
    }

    /**
     * @notice Resolve from type + normalized identifier in one call.
     */
    function resolveIdentifier(IdType idType, bytes calldata normalizedIdentifier)
        external
        view
        returns (address account, bool active)
    {
        bytes32 key = identityKey(idType, normalizedIdentifier);
        Identity memory id = _identities[key];
        return (id.account, id.active);
    }

    function keysOf(address account) external view returns (bytes32[] memory) {
        return _accountKeys[account];
    }

    // -------------------------------------------------------------------------
    // Writes
    // -------------------------------------------------------------------------

    /**
     * @notice Link an identity after backend verification.
     * @dev Restricted to the registry admin; callers must not be able to squat
     *      arbitrary email or handle keys before ownership is proven.
     */
    function link(IdType idType, bytes calldata normalizedIdentifier) external onlyAdmin {
        _linkTo(msg.sender, idType, normalizedIdentifier);
    }

    /**
     * @notice Backend/admin links a verified contact to a user wallet (after OTP/OAuth).
     * @dev Prefer multisig admin in production. Identity still stored only as hash.
     */
    function adminLink(
        address account,
        IdType idType,
        bytes calldata normalizedIdentifier
    ) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        _linkTo(account, idType, normalizedIdentifier);
    }

    function _linkTo(
        address account,
        IdType idType,
        bytes calldata normalizedIdentifier
    ) internal {
        bytes32 key = identityKey(idType, normalizedIdentifier);
        Identity storage existing = _identities[key];
        if (existing.active && existing.account != address(0)) revert AlreadyLinked();

        uint64 ts = uint64(block.timestamp);
        _identities[key] = Identity({
            account: account,
            idType: idType,
            linkedAt: ts,
            active: true
        });
        _accountKeys[account].push(key);

        emit IdentityLinked(key, account, idType, ts);
    }

    /**
     * @notice Unlink an identity owned by msg.sender.
     */
    function unlink(bytes32 key) external {
        Identity storage id = _identities[key];
        if (!id.active || id.account != msg.sender) revert NotLinked();
        id.active = false;
        emit IdentityUnlinked(key, msg.sender);
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        address prev = admin;
        admin = newAdmin;
        emit AdminUpdated(prev, newAdmin);
    }

    /**
     * @notice Admin emergency unlink (support / abuse). Prefer multisig admin.
     */
    function adminUnlink(bytes32 key) external onlyAdmin {
        Identity storage id = _identities[key];
        if (!id.active) revert NotLinked();
        address account = id.account;
        id.active = false;
        emit IdentityUnlinked(key, account);
    }
}
