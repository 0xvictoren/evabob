// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title MoneyCircles
 * @notice Rotating savings circles (ajo, esusu, tontine, chama) where the
 *         contract, not a person, runs the pot.
 *
 * The classic failure of a savings circle is the collector: one member holds
 * everyone's money and can disappear with it. Here nobody holds it. Members
 * approve the contract once for their whole commitment and join; each round,
 * anyone may trigger the collection, which pulls every member's contribution
 * and pays the round's recipient in the same transaction.
 *
 * Missed contributions follow the rules the product owner chose:
 *  - The round still pays out whatever was collected. Nobody waits.
 *  - A member who could not pay is marked behind, owing the shortfall to the
 *    member whose round it was. They can catch up at any time; catching up
 *    pays that member directly.
 *  - If a member's own payout turn comes while they are behind, they are
 *    moved to the end of the order instead of stalling everyone.
 *  - If only behind members are left, the next one is paid anyway, and what
 *    they owe is settled from their payout first.
 *
 * There is no admin. The organizer can only cancel a circle that has not
 * started, when no money has moved.
 */
contract MoneyCircles {
    IERC20 public immutable usdc;
    address public immutable feeRecipient;
    /// Platform fee on each round's payout, in basis points (at most 1%).
    uint16 public immutable feeBps;

    uint256 public constant MAX_MEMBERS = 20;
    uint64 public constant MIN_ROUND_SECONDS = 60;
    uint64 public constant MAX_START_DELAY = 365 days;

    enum State {
        None,
        Forming,
        Running,
        Finished,
        Cancelled
    }

    struct Circle {
        address organizer;
        uint128 contribution;
        uint64 roundSeconds;
        /// Earliest first collection; fixed to the real start when the last member joins.
        uint64 startAt;
        uint32 memberCount;
        uint32 joined;
        uint32 roundsCollected;
        State state;
    }

    struct Debt {
        address creditor;
        uint128 amount;
    }

    uint256 public nextCircleId = 1;
    mapping(uint256 => Circle) public circles;
    mapping(uint256 => address[]) internal _members;
    mapping(uint256 => mapping(address => bool)) public isMember;
    mapping(uint256 => mapping(address => bool)) public hasJoined;
    mapping(uint256 => mapping(address => bool)) public paidOut;

    /// Members still waiting for their payout, in order, from `queueHead`.
    mapping(uint256 => address[]) internal _queue;
    mapping(uint256 => uint256) public queueHead;

    /// What a behind member owes, and to whom, oldest first from `debtHead`.
    mapping(uint256 => mapping(address => Debt[])) internal _debts;
    mapping(uint256 => mapping(address => uint256)) public debtHead;
    mapping(uint256 => mapping(address => uint256)) public arrears;

    uint256 private _lock = 1;

    event CircleCreated(
        uint256 indexed circleId,
        address indexed organizer,
        uint128 contribution,
        uint64 roundSeconds,
        uint64 startAt,
        address[] members
    );
    event Joined(uint256 indexed circleId, address indexed member);
    event Left(uint256 indexed circleId, address indexed member);
    event Started(uint256 indexed circleId, uint64 startAt);
    event Contributed(uint256 indexed circleId, uint32 indexed round, address indexed member, uint128 amount);
    event Missed(uint256 indexed circleId, uint32 indexed round, address indexed member, uint128 amount);
    event MovedToEnd(uint256 indexed circleId, uint32 indexed round, address indexed member);
    event PaidOut(
        uint256 indexed circleId, uint32 indexed round, address indexed recipient, uint256 amount, uint256 fee
    );
    event DebtPaid(uint256 indexed circleId, address indexed member, address indexed creditor, uint256 amount);
    event Finished(uint256 indexed circleId);
    event Cancelled(uint256 indexed circleId);

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

    // ─── Setting up ──────────────────────────────────────────────────────

    /// @param memberList Everyone in the circle, in payout order.
    function createCircle(uint128 contribution, uint64 roundSeconds, uint64 startAt, address[] calldata memberList)
        external
        returns (uint256 circleId)
    {
        uint256 n = memberList.length;
        require(n >= 2 && n <= MAX_MEMBERS, "2 to 20 members");
        require(contribution > 0, "contribution");
        require(roundSeconds >= MIN_ROUND_SECONDS, "round too short");
        require(startAt <= block.timestamp + MAX_START_DELAY, "start too far");

        circleId = nextCircleId++;
        for (uint256 i = 0; i < n; i++) {
            address m = memberList[i];
            require(m != address(0), "member");
            require(!isMember[circleId][m], "duplicate member");
            isMember[circleId][m] = true;
            _members[circleId].push(m);
            _queue[circleId].push(m);
        }
        circles[circleId] = Circle({
            organizer: msg.sender,
            contribution: contribution,
            roundSeconds: roundSeconds,
            startAt: startAt,
            memberCount: uint32(n),
            joined: 0,
            roundsCollected: 0,
            state: State.Forming
        });
        emit CircleCreated(circleId, msg.sender, contribution, roundSeconds, startAt, memberList);
    }

    /**
     * Join after approving this contract for the whole commitment:
     * contribution × members. The circle starts when the last member joins.
     */
    function join(uint256 circleId) external {
        Circle storage c = circles[circleId];
        require(c.state == State.Forming, "not forming");
        require(isMember[circleId][msg.sender], "not a member");
        require(!hasJoined[circleId][msg.sender], "already joined");
        require(
            usdc.allowance(msg.sender, address(this)) >= commitment(circleId), "approve your full commitment first"
        );
        hasJoined[circleId][msg.sender] = true;
        c.joined += 1;
        emit Joined(circleId, msg.sender);
        if (c.joined == c.memberCount) {
            c.state = State.Running;
            if (c.startAt < block.timestamp) c.startAt = uint64(block.timestamp);
            emit Started(circleId, c.startAt);
        }
    }

    /// Changes one's mind before the circle starts. Nothing has been paid.
    function leave(uint256 circleId) external {
        Circle storage c = circles[circleId];
        require(c.state == State.Forming, "not forming");
        require(hasJoined[circleId][msg.sender], "not joined");
        hasJoined[circleId][msg.sender] = false;
        c.joined -= 1;
        emit Left(circleId, msg.sender);
    }

    /// The organizer calls off a circle that has not started. No money has moved.
    function cancel(uint256 circleId) external {
        Circle storage c = circles[circleId];
        require(c.state == State.Forming, "not forming");
        require(msg.sender == c.organizer, "organizer only");
        c.state = State.Cancelled;
        emit Cancelled(circleId);
    }

    // ─── Rounds ──────────────────────────────────────────────────────────

    /**
     * Collects this round's contributions and pays the round's recipient.
     * Anyone may call it once the round is due; it can run once per round.
     */
    function collect(uint256 circleId) external nonReentrant {
        Circle storage c = circles[circleId];
        require(c.state == State.Running, "not running");
        require(block.timestamp >= nextCollectionAt(circleId), "not due yet");
        uint32 round = c.roundsCollected;
        uint128 each = c.contribution;
        address[] storage everyone = _members[circleId];
        uint256 n = everyone.length;

        uint256 pot;
        address[] memory missed = new address[](n);
        uint256 missedCount;
        for (uint256 i = 0; i < n; i++) {
            address m = everyone[i];
            if (_tryPull(m, address(this), each)) {
                pot += each;
                emit Contributed(circleId, round, m, each);
            } else {
                missed[missedCount++] = m;
                // Counted before choosing the recipient, so a member who
                // cannot pay this round does not collect this round.
                arrears[circleId][m] += each;
                emit Missed(circleId, round, m, each);
            }
        }

        address recipient = _takeNext(circleId, round);

        for (uint256 i = 0; i < missedCount; i++) {
            address m = missed[i];
            if (m == recipient) {
                // Nobody owes themselves: their share is simply not in their pot.
                arrears[circleId][m] -= each;
            } else {
                _debts[circleId][m].push(Debt({creditor: recipient, amount: each}));
            }
        }

        // A recipient who is still behind settles what they owe first.
        if (arrears[circleId][recipient] > 0) {
            pot -= _settleFrom(circleId, recipient, pot);
        }

        paidOut[circleId][recipient] = true;
        c.roundsCollected = round + 1;
        uint256 fee = (pot * feeBps) / 10_000;
        if (fee > 0) require(usdc.transfer(feeRecipient, fee), "fee transfer");
        if (pot - fee > 0) require(usdc.transfer(recipient, pot - fee), "payout transfer");
        emit PaidOut(circleId, round, recipient, pot - fee, fee);

        if (c.roundsCollected == c.memberCount) {
            c.state = State.Finished;
            emit Finished(circleId);
        }
    }

    /**
     * Pays what a behind member owes, oldest first, straight to the members
     * they shorted. Anyone may call it: the member, or a keeper that tries on
     * their behalf. Each debt is paid whole or not at all.
     */
    function catchUp(uint256 circleId, address member) external nonReentrant returns (uint256 paid) {
        Debt[] storage debts = _debts[circleId][member];
        uint256 head = debtHead[circleId][member];
        while (head < debts.length) {
            Debt storage d = debts[head];
            if (!_tryPull(member, d.creditor, d.amount)) break;
            paid += d.amount;
            arrears[circleId][member] -= d.amount;
            emit DebtPaid(circleId, member, d.creditor, d.amount);
            head++;
        }
        debtHead[circleId][member] = head;
    }

    // ─── Views ───────────────────────────────────────────────────────────

    function commitment(uint256 circleId) public view returns (uint256) {
        Circle storage c = circles[circleId];
        return uint256(c.contribution) * c.memberCount;
    }

    function nextCollectionAt(uint256 circleId) public view returns (uint256) {
        Circle storage c = circles[circleId];
        return uint256(c.startAt) + uint256(c.roundsCollected) * c.roundSeconds;
    }

    function members(uint256 circleId) external view returns (address[] memory) {
        return _members[circleId];
    }

    /// Members still waiting for their payout, next first.
    function payoutQueue(uint256 circleId) external view returns (address[] memory out) {
        address[] storage q = _queue[circleId];
        uint256 head = queueHead[circleId];
        out = new address[](q.length - head);
        for (uint256 i = head; i < q.length; i++) {
            out[i - head] = q[i];
        }
    }

    /// What a member still owes, and to whom, oldest first.
    function debtsOf(uint256 circleId, address member) external view returns (Debt[] memory out) {
        Debt[] storage debts = _debts[circleId][member];
        uint256 head = debtHead[circleId][member];
        out = new Debt[](debts.length - head);
        for (uint256 i = head; i < debts.length; i++) {
            out[i - head] = debts[i];
        }
    }

    // ─── Internals ───────────────────────────────────────────────────────

    /**
     * Next recipient: the first waiting member who is not behind. Behind
     * members whose turn comes are moved to the end. If everyone left is
     * behind, the first of them is paid (and settles their debts from it).
     */
    function _takeNext(uint256 circleId, uint32 round) internal returns (address) {
        address[] storage q = _queue[circleId];
        uint256 remaining = q.length - queueHead[circleId];
        for (uint256 i = 0; i < remaining; i++) {
            uint256 head = queueHead[circleId];
            address candidate = q[head];
            queueHead[circleId] = head + 1;
            if (arrears[circleId][candidate] == 0 || i == remaining - 1) {
                return candidate;
            }
            q.push(candidate);
            emit MovedToEnd(circleId, round, candidate);
        }
        revert("no one waiting");
    }

    /// Pays `member`'s debts from money this contract already holds for them.
    function _settleFrom(uint256 circleId, address member, uint256 available) internal returns (uint256 used) {
        Debt[] storage debts = _debts[circleId][member];
        uint256 head = debtHead[circleId][member];
        while (head < debts.length && available > used) {
            Debt storage d = debts[head];
            uint256 part = d.amount <= available - used ? d.amount : available - used;
            require(usdc.transfer(d.creditor, part), "debt transfer");
            used += part;
            arrears[circleId][member] -= part;
            emit DebtPaid(circleId, member, d.creditor, part);
            if (part == d.amount) {
                head++;
            } else {
                d.amount -= uint128(part);
            }
        }
        debtHead[circleId][member] = head;
    }

    /// transferFrom that reports failure instead of reverting.
    function _tryPull(address from, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) =
            address(usdc).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }
}
