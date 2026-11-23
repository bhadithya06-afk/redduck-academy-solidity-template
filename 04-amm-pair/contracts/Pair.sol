// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract Pair is ERC20 {
    using SafeERC20 for IERC20;

    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;

    error InvalidToken();
    error InsufficientAmount();
    error InsufficientLiquidity();
    error InsufficientOutput();

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event LiquidityRemoved(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swapped(address indexed sender, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 _token0, IERC20 _token1) ERC20("Pair LP", "PAIR-LP") {
        if (address(_token0) == address(0) || address(_token1) == address(0) || _token0 == _token1) {
            revert InvalidToken();
        }
        token0 = _token0;
        token1 = _token1;
    }

    function _syncReserves() private {
        reserve0 = token0.balanceOf(address(this));
        reserve1 = token1.balanceOf(address(this));
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountIn == 0) revert InsufficientAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * 1000) + amountInWithFee;

        return numerator / denominator;
    }

    function addLiquidity(uint256 amount0, uint256 amount1) external returns (uint256 liquidity) {
        if (amount0 == 0 || amount1 == 0) revert InsufficientAmount();

        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        uint256 supply = totalSupply();
        if (supply == 0) {
            uint256 root = Math.sqrt(amount0 * amount1);
            if (root <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();

            _mint(DEAD, MINIMUM_LIQUIDITY);
            liquidity = root - MINIMUM_LIQUIDITY;
        } else {
            liquidity = Math.min(
                (amount0 * supply) / reserve0,
                (amount1 * supply) / reserve1
            );
            if (liquidity == 0) revert InsufficientLiquidity();
        }

        _mint(msg.sender, liquidity);
        _syncReserves();

        emit LiquidityAdded(msg.sender, amount0, amount1, liquidity);
    }

    function removeLiquidity(uint256 liquidity) external returns (uint256 amount0, uint256 amount1) {
        if (liquidity == 0) revert InsufficientAmount();

        uint256 supply = totalSupply();
        if (supply == 0 || balanceOf(msg.sender) < liquidity) revert InsufficientLiquidity();

        amount0 = (liquidity * reserve0) / supply;
        amount1 = (liquidity * reserve1) / supply;

        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();

        _burn(msg.sender, liquidity);

        token0.safeTransfer(msg.sender, amount0);
        token1.safeTransfer(msg.sender, amount1);
        _syncReserves();

        emit LiquidityRemoved(msg.sender, amount0, amount1, liquidity);
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) external returns (uint256 amountOut) {
        if (tokenIn != address(token0) && tokenIn != address(token1)) revert InvalidToken();

        bool isToken0 = tokenIn == address(token0);
        (IERC20 inToken, IERC20 outToken, uint256 resIn, uint256 resOut) = isToken0
            ? (token0, token1, reserve0, reserve1)
            : (token1, token0, reserve1, reserve0);

        amountOut = getAmountOut(amountIn, resIn, resOut);
        if (amountOut < minAmountOut) revert InsufficientOutput();

        inToken.safeTransferFrom(msg.sender, address(this), amountIn);
        outToken.safeTransfer(msg.sender, amountOut);
        _syncReserves();

        emit Swapped(msg.sender, tokenIn, amountIn, amountOut);
    }
}
