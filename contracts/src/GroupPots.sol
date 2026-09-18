// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title GroupPots
 * @notice One-off collections with a target and a deadline: a funeral, a
 *         wedding gift, a teammate's leaving present, school fees.
 *
 * The organizer of a collection usually ends up holding everyone's money in
 * their own account, and giving it back when the plan falls through is a
 * favour, not a rule. Here the contract holds it:
 *  - Reach the target and it goes to the beneficiary, in the same transaction
 *    that reached it.
 *  - Miss the deadline and every contributor can be refunded exactly what they
 *    put in. Anyone may trigger a refund; it can only ever go back to the
 *    person who paid.
 *  - The organizer may call a pot off early, which also refunds everyone.
 *
 * There is no admin, and no path for money to reach anyone but the
 * beneficiary or the contributors.
 */
contract GroupPots {
    IERC20 public immutable usdc;
    address public immutable feeRecipient;
    /// Platform fee on the amount released to the beneficiary, in basis points (at most 1%).
    uint16 public immutable feeBps;

    uint64 public constant MAX_DURATION = 365 days;

    enum State {
        None,
        Open,
        Released,
        Refunding
    }

    struct Pot {
        address organizer;
        address beneficiary;
        uint128 target;
        uint128 raised;
        uint64 deadline;
        State state;
    }

    uint256 public nextPotId = 1;
    mapping(uint256 => Pot) public pots;
    mapping(uint256 => mapping(address => uint128)) public contributed;

    uint256 private _lock = 1;

    event PotCreated(
        uint256 indexed potId, address indexed organizer, address indexed beneficiary, uint128 target, uint64 deadline
    );
    event Contributed(uint256 indexed potId, address indexed contributor, uint128 amount, uint128 raised);
    event Released(uint256 indexed potId, address indexed beneficiary, uint256 amount, uint256 fee);
    event Refunded(uint256 indexed potId, address indexed contributor, uint256 amount);
    event CalledOff(uint256 indexed potId);

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address usdc_, address feeRecipient_, uint16 feeBps_) {
        require(usdc_ != address(0), "usdc");
        require(feeBps_ <= 100, "fee too high");
        require(feeBps_ == 0 || feeRecipient_ != address(0), "fee recipient");
        usdc = IERC20(usdc_);
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    function createPot(address beneficiary, uint128 target, uint64 deadline) external returns (uint256 potId) {
        require(beneficiary != address(0), "beneficiary");
        require(target > 0, "target");
        require(deadline > block.timestamp, "deadline passed");
        require(deadline <= block.timestamp + MAX_DURATION, "deadline too far");
        potId = nextPotId++;
        pots[potId] = Pot({
            organizer: msg.sender,
            beneficiary: beneficiary,
            target: target,
            raised: 0,
            deadline: deadline,
            state: State.Open
        });
        emit PotCreated(potId, msg.sender, beneficiary, target, deadline);
    }

    /// Adds to a pot. Reaching the target releases it at once.
    function contribute(uint256 potId, uint128 amount) external nonReentrant {
        Pot storage p = pots[potId];
        require(p.state == State.Open, "not open");
        require(block.timestamp < p.deadline, "deadline passed");
        require(amount > 0, "amount");
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer");
        contributed[potId][msg.sender] += amount;
        p.raised += amount;
        emit Contributed(potId, msg.sender, amount, p.raised);
        if (p.raised >= p.target) _release(potId);
    }

    /// Releases a pot that has reached its target. Anyone may call it.
    function release(uint256 potId) external nonReentrant {
        Pot storage p = pots[potId];
        require(p.state == State.Open, "not open");
        require(p.raised >= p.target, "target not reached");
        _release(potId);
    }

    /// The organizer calls a pot off before it is released; everyone is refunded.
    function callOff(uint256 potId) external {
        Pot storage p = pots[potId];
        require(p.state == State.Open, "not open");
        require(msg.sender == p.organizer, "organizer only");
        p.state = State.Refunding;
        emit CalledOff(potId);
    }

    /**
     * Returns one contributor's money after the deadline passed short of the
     * target, or after the pot was called off. Anyone may call it; the money
     * only ever goes back to the contributor.
     */
    function refund(uint256 potId, address contributor) external nonReentrant returns (uint256 amount) {
        Pot storage p = pots[potId];
        if (p.state == State.Open) {
            require(block.timestamp >= p.deadline, "still open");
            require(p.raised < p.target, "target reached");
            p.state = State.Refunding;
        }
        require(p.state == State.Refunding, "not refunding");
        amount = contributed[potId][contributor];
        require(amount > 0, "nothing to refund");
        contributed[potId][contributor] = 0;
        require(usdc.transfer(contributor, amount), "refund transfer");
        emit Refunded(potId, contributor, amount);
    }

    function _release(uint256 potId) internal {
        Pot storage p = pots[potId];
        p.state = State.Released;
        uint256 amount = p.raised;
        uint256 fee = (amount * feeBps) / 10_000;
        if (fee > 0) require(usdc.transfer(feeRecipient, fee), "fee transfer");
        require(usdc.transfer(p.beneficiary, amount - fee), "release transfer");
        emit Released(potId, p.beneficiary, amount - fee, fee);
    }
}
