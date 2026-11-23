// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/*
 * REFLECTION: What would break if voters could withdraw their locked tokens
 * DURING the voting period, before votingEnd?
 *
 * Specifically, the tracked leader state variables (`_leaderPrice` and
 * `_leaderWeight`) would become stale and inaccurate. Because the option space
 * of proposed prices is unbounded (`uint256`), the contract cannot iterate over
 * all proposed prices in a loop to find the new highest-weighted price without
 * hitting the block gas limit.
 *
 * If the current leading price had 500 tokens and second place had 400 tokens,
 * and a voter withdrew 200 tokens from the leading price mid-vote, `_weightOf[leaderPrice]`
 * would drop to 300. However, `_leaderPrice` and `_leaderWeight` would still
 * point to the old leader (or fail to know that 400 is now the true maximum)
 * because the contract maintains no sorted list or max-heap of all candidate prices.
 */
contract PriceVoting {
    IERC20 private immutable _token;
    uint256 private immutable _votingEnd;

    mapping(uint256 => uint256) private _weightOf;
    mapping(address => uint256) private _lockedOf;

    uint256 private _leaderPrice;
    uint256 private _leaderWeight;
    bool private _hasTie;

    uint256 private _currentTokenPrice;
    bool private _finalized;

    error VotingEnded();
    error VotingActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error NothingToClaim();
    error TransferFailed();

    event Voted(address indexed voter, uint256 indexed price, uint256 amount);
    event PriceFinalized(uint256 indexed price, uint256 weight);
    event Claimed(address indexed voter, uint256 amount);

    constructor(IERC20 token_, uint256 votingEnd_) {
        _token = token_;
        _votingEnd = votingEnd_;
    }

    // ----- write -----

    function vote(uint256 price, uint256 amount) external {
        if (block.timestamp >= _votingEnd) revert VotingEnded();
        if (amount == 0) revert ZeroAmount();

        bool ok = _token.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        _lockedOf[msg.sender] += amount;
        uint256 newWeight = _weightOf[price] + amount;
        _weightOf[price] = newWeight;

        if (newWeight > _leaderWeight) {
            _leaderPrice = price;
            _leaderWeight = newWeight;
            _hasTie = false;
        } else if (newWeight == _leaderWeight && price != _leaderPrice) {
            _hasTie = true;
        }

        emit Voted(msg.sender, price, amount);
    }

    function finalize() external {
        if (block.timestamp < _votingEnd) revert VotingActive();
        if (_finalized) revert AlreadyFinalized();

        _finalized = true;

        if (_leaderWeight > 0 && !_hasTie) {
            _currentTokenPrice = _leaderPrice;
            emit PriceFinalized(_leaderPrice, _leaderWeight);
        } else {
            emit PriceFinalized(0, 0);
        }
    }

    function claim() external {
        if (block.timestamp < _votingEnd) revert VotingActive();

        uint256 amount = _lockedOf[msg.sender];
        if (amount == 0) revert NothingToClaim();

        _lockedOf[msg.sender] = 0;

        bool ok = _token.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Claimed(msg.sender, amount);
    }

    // ----- read -----

    function token() external view returns (IERC20) {
        return _token;
    }

    function votingEnd() external view returns (uint256) {
        return _votingEnd;
    }

    function weightOf(uint256 price) external view returns (uint256) {
        return _weightOf[price];
    }

    function lockedOf(address voter) external view returns (uint256) {
        return _lockedOf[voter];
    }

    function leader() external view returns (uint256 price, uint256 weight) {
        return (_leaderPrice, _leaderWeight);
    }

    function currentTokenPrice() external view returns (uint256) {
        return _currentTokenPrice;
    }

    function finalized() external view returns (bool) {
        return _finalized;
    }
}
