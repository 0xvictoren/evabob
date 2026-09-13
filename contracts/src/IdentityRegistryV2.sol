// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Identity registry with a cold administrator and a narrowly scoped hot linker.
 * Identifiers remain hashed exactly as in V1 so migrations preserve keys.
 */
contract IdentityRegistryV2 {
    enum IdType {
        Phone,
        Email,
        Handle
    }

    struct Identity {
        address account;
        IdType idType;
        uint64 linkedAt;
        bool active;
    }

    mapping(bytes32 => Identity) private _identities;
    mapping(address => bytes32[]) private _accountKeys;

    /**
     * Safe multisig: rotates the linker and handles emergency unlinking.
     */
    address public admin;
    /**
     * Hot server EOA: links verified identities but cannot change roles.
     */
    address public linker;

    event IdentityLinked(bytes32 indexed identityKey, address indexed account, IdType idType, uint64 linkedAt);
    event IdentityUnlinked(bytes32 indexed identityKey, address indexed account);
    event AdminUpdated(address indexed previousAdmin, address indexed newAdmin);
    event LinkerUpdated(address indexed previousLinker, address indexed newLinker);

    error NotAdmin();
    error NotLinker();
    error ZeroAddress();
    error AlreadyLinked();
    error NotLinked();
    error EmptyIdentifier();
    error IdentityOwnedByAnotherAccount();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyLinker() {
        if (msg.sender != linker) revert NotLinker();
        _;
    }

    constructor(address admin_, address linker_) {
        if (admin_ == address(0) || linker_ == address(0)) revert ZeroAddress();
        admin = admin_;
        linker = linker_;
    }

    function identityKey(IdType idType, bytes calldata normalizedIdentifier) public pure returns (bytes32) {
        if (normalizedIdentifier.length == 0) revert EmptyIdentifier();
        return keccak256(abi.encodePacked(uint8(idType), normalizedIdentifier));
    }

    function resolve(bytes32 key) external view returns (address account, bool active) {
        Identity memory id = _identities[key];
        return (id.account, id.active);
    }

    function resolveIdentifier(IdType idType, bytes calldata normalizedIdentifier)
        external
        view
        returns (address account, bool active)
    {
        Identity memory id = _identities[identityKey(idType, normalizedIdentifier)];
        return (id.account, id.active);
    }

    function keysOf(address account) external view returns (bytes32[] memory) {
        return _accountKeys[account];
    }

    /**
     * Link only after the application has verified the email or handle.
     */
    function adminLink(address account, IdType idType, bytes calldata normalizedIdentifier) external onlyLinker {
        if (account == address(0)) revert ZeroAddress();
        bytes32 key = identityKey(idType, normalizedIdentifier);
        Identity storage existing = _identities[key];
        if (existing.active) revert AlreadyLinked();
        // Once an identifier has belonged to an account, a compromised linker
        // cannot recycle it to an attacker after first deactivating it.
        if (existing.account != address(0) && existing.account != account) {
            revert IdentityOwnedByAnotherAccount();
        }

        uint64 ts = uint64(block.timestamp);
        bool firstLink = existing.account == address(0);
        _identities[key] = Identity({account: account, idType: idType, linkedAt: ts, active: true});
        if (firstLink) _accountKeys[account].push(key);
        emit IdentityLinked(key, account, idType, ts);
    }

    /**
     * Routine handle retirement. The linker can disable an exact account/key
     * pair but cannot assign that historical key to another account.
     */
    function linkerUnlink(address account, bytes32 key) external onlyLinker {
        Identity storage id = _identities[key];
        if (!id.active || id.account != account) revert NotLinked();
        id.active = false;
        emit IdentityUnlinked(key, account);
    }

    function unlink(bytes32 key) external {
        Identity storage id = _identities[key];
        if (!id.active || id.account != msg.sender) revert NotLinked();
        id.active = false;
        emit IdentityUnlinked(key, msg.sender);
    }

    function adminUnlink(bytes32 key) external onlyAdmin {
        Identity storage id = _identities[key];
        if (!id.active) revert NotLinked();
        id.active = false;
        emit IdentityUnlinked(key, id.account);
    }

    function setLinker(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        emit LinkerUpdated(linker, next);
        linker = next;
    }

    function setAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        emit AdminUpdated(admin, next);
        admin = next;
    }
}
