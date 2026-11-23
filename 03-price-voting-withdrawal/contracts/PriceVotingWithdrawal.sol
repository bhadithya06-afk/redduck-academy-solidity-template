// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/*
 * CALL ORDER & SETTLEMENT DESIGN:
 * 1. During voting (`block.timestamp < votingEnd`):
 *    - Voters approve this contract and call `vote(price, amount)` to lock tokens behind a price.
 *    - Voters may call `withdraw(price, amount)` at any time (during or after voting) to unlock
 *      and reclaim up to their staked amount on that price, and may vote again on another price.
 * 2. After voting ends (`block.timestamp >= votingEnd`):
 *    - Anyone calls `finalize(uint256[] calldata candidatePrices)` once with the proposed candidate
 *      prices (discovered off-chain via `Voted` events). The contract verifies each candidate's
 *      on-chain `weightOf[price]` and sets `currentTokenPrice` to the unique winner (or leaves it
 *      at 0 if there are no positive votes or if there is a tie).
 *    - Anyone can read the winning price via `currentTokenPrice()` or `winningPrice()`.
 *
 * REFLECTION: What implementation strategy did you pick for handling withdrawal-induced leader
 * changes, and why? What would go wrong with the simpler pattern from the previous task?
 *
 * Strategy: Off-chain computation with on-chain verification (`finalize(uint256[] calldata candidatePrices)`),
 * paired with per-(voter, price) stake tracking (`stakeOf[voter][price]`).
 *
 * Why: Because proposed prices span the unbounded `uint256` space, maintaining a single running
 * `_leaderPrice` / `_leaderWeight` as in Task 02 breaks as soon as a voter withdraws from the
 * leading price: `_weightOf[_leaderPrice]` drops, but the contract has no sorted structure to
 * know which other price is now second-highest without iterating over all historical proposals
 * (which could exceed the block gas limit). By dropping live leader tracking during voting and
 * letting callers supply candidate prices at finalization for deterministic on-chain verification,
 * both `vote` and `withdraw` run in O(1) gas while `finalize` accurately resolves the true winner.
 */
contract PriceVotingWithdrawal {
    IERC20 private immutable _token;
    uint256 private immutable _votingEnd;

    mapping(uint256 => uint256) private _weightOf;
    mapping(address => uint256) private _lockedOf;
    mapping(address => mapping(uint256 => uint256)) private _stakeOf;

    uint256 private _currentTokenPrice;
    bool private _finalized;

    error VotingEnded();
    error VotingActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error InsufficientStake();
    error DuplicateCandidate();
    error TransferFailed();

    event Voted(address indexed voter, uint256 indexed price, uint256 amount);
    event Withdrawn(address indexed voter, uint256 indexed price, uint256 amount);
    event PriceFinalized(uint256 indexed price, uint256 weight);

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
        _stakeOf[msg.sender][price] += amount;
        _weightOf[price] += amount;

        emit Voted(msg.sender, price, amount);
    }

    function withdraw(uint256 price, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (_stakeOf[msg.sender][price] < amount) revert InsufficientStake();

        _stakeOf[msg.sender][price] -= amount;
        _lockedOf[msg.sender] -= amount;
        _weightOf[price] -= amount;

        bool ok = _token.transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Withdrawn(msg.sender, price, amount);
    }

    function finalize(uint256[] calldata candidatePrices) external {
        if (block.timestamp < _votingEnd) revert VotingActive();
        if (_finalized) revert AlreadyFinalized();

        _finalized = true;

        uint256 bestPrice = 0;
        uint256 bestWeight = 0;
        bool hasTie = false;

        for (uint256 i = 0; i < candidatePrices.length; i++) {
            uint256 candidate = candidatePrices[i];

            for (uint256 j = 0; j < i; j++) {
                if (candidatePrices[j] == candidate) revert DuplicateCandidate();
            }

            uint256 w = _weightOf[candidate];
            if (w == 0) continue;

            if (w > bestWeight) {
                bestWeight = w;
                bestPrice = candidate;
                hasTie = false;
            } else if (w == bestWeight) {
                hasTie = true;
            }
        }

        if (bestWeight > 0 && !hasTie) {
            _currentTokenPrice = bestPrice;
            emit PriceFinalized(bestPrice, bestWeight);
        } else {
            emit PriceFinalized(0, 0);
        }
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

    function stakeOf(address voter, uint256 price) external view returns (uint256) {
        return _stakeOf[voter][price];
    }

    function currentTokenPrice() external view returns (uint256) {
        return _currentTokenPrice;
    }

    function winningPrice() external view returns (uint256) {
        return _currentTokenPrice;
    }

    function finalized() external view returns (bool) {
        return _finalized;
    }
}
