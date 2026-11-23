// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

contract Raffle is VRFConsumerBaseV2Plus {
    struct Entry {
        address player;
        uint256 amount;
        uint256 startWeight;
        uint256 endWeight;
    }

    IERC20 public immutable token;
    AggregatorV3Interface public immutable priceFeed;
    uint256 public immutable drawTime;

    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint32 public immutable callbackGasLimit;
    uint16 public constant REQUEST_CONFIRMATIONS = 3;
    uint32 public constant NUM_WORDS = 1;

    uint256 public constant MAX_PRICE_AGE = 1 hours;

    Entry[] public entries;
    uint256 public totalWeight;
    uint256 public totalPot;
    uint256 public requestId;
    uint256 public randomWord;
    bool public fulfilled;
    bool public claimed;

    error InvalidClaim();
    error InvalidAmount();
    error RaffleClosed();
    error InvalidPrice();
    error StalePrice();
    error DrawNotReady();
    error DrawAlreadyRequested();
    error NoEntries();
    error InvalidRequestId();
    error TransferFailed();

    event Deposited(address indexed who, uint256 amount, uint256 weight);
    event DrawRequested(uint256 requestId);
    event WinnerPicked(address indexed winner);
    event Claimed(address indexed winner, uint256 amount);

    constructor(
        IERC20 _token,
        AggregatorV3Interface _priceFeed,
        uint256 _drawTime,
        address _coordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit
    ) VRFConsumerBaseV2Plus(_coordinator) {
        token = _token;
        priceFeed = _priceFeed;
        drawTime = _drawTime;
        subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        callbackGasLimit = _callbackGasLimit;
    }

    function deposit(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        if (block.timestamp >= drawTime || requestId != 0) revert RaffleClosed();

        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = priceFeed.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) revert InvalidPrice();
        if (block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();

        uint8 decimals = priceFeed.decimals();
        uint256 weight = (amount * uint256(answer)) / (10 ** decimals);
        if (weight == 0) revert InvalidAmount();

        uint256 startWeight = totalWeight;
        uint256 endWeight = startWeight + weight;

        entries.push(
            Entry({
                player: msg.sender,
                amount: amount,
                startWeight: startWeight,
                endWeight: endWeight
            })
        );

        totalWeight = endWeight;
        totalPot += amount;

        bool ok = token.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        emit Deposited(msg.sender, amount, weight);
    }

    function drawWinner() external returns (uint256) {
        if (block.timestamp < drawTime) revert DrawNotReady();
        if (entries.length == 0) revert NoEntries();
        if (requestId != 0) revert DrawAlreadyRequested();

        uint256 reqId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: callbackGasLimit,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );

        requestId = reqId;
        emit DrawRequested(reqId);
        return reqId;
    }

    function fulfillRandomWords(uint256 _requestId, uint256[] calldata randomWords) internal override {
        if (_requestId != requestId || randomWords.length == 0) revert InvalidRequestId();
        randomWord = randomWords[0];
        fulfilled = true;
    }

    function claim(uint256 entryIndex) external {
        if (!fulfilled || claimed || entryIndex >= entries.length) {
            revert InvalidClaim();
        }

        Entry memory entry = entries[entryIndex];
        if (entry.player != msg.sender) revert InvalidClaim();

        uint256 winningTicket = randomWord % totalWeight;
        if (winningTicket < entry.startWeight || winningTicket >= entry.endWeight) {
            revert InvalidClaim();
        }

        claimed = true;
        uint256 prize = totalPot;

        bool ok = token.transfer(msg.sender, prize);
        if (!ok) revert TransferFailed();

        emit WinnerPicked(msg.sender);
        emit Claimed(msg.sender, prize);
    }

    function entriesLength() external view returns (uint256) {
        return entries.length;
    }
}
