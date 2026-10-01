// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal hookless Uniswap v4 closed-cycle executor used only for
/// state-override paper simulation. This repository does not deploy it.
contract AtomicCycleExecutor {
    address internal constant POOL_MANAGER = 0x8366a39cc670b4001a1121b8f6a443a643e40951;
    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;

    error NotPoolManager();
    error EmptyPath();
    error InvalidAmount();
    error InvalidHop();
    error HooksUnsupported();
    error HookDataUnsupported();
    error PartialFill(uint256 hop, uint256 requested, uint256 consumed);
    error InvalidDelta(uint256 hop, int128 inputDelta, int128 outputDelta);
    error CycleNotClosed(address expectedBase, address finalCurrency);
    error NoProfit(uint256 amountIn, uint256 amountOut);
    error ProfitBelowMinimum(uint256 profit, uint256 minProfit);

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    struct PathHop {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    interface IPoolManager {
        function unlock(bytes calldata data) external returns (bytes memory result);
        function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
            external
            returns (int256 swapDelta);
        function take(address currency, address to, uint256 amount) external;
    }

    /// @notice Executes a flash-accounted exact-input closed cycle.
    /// @dev The selector intentionally matches the representative calldata used
    /// by v0.8.3 Nitro calibration. minProfit is semantic; parameter names do
    /// not affect the selector.
    function executeCycle(
        address base,
        uint128 amountIn,
        uint128 minProfit,
        PathHop[] calldata path
    ) external returns (uint256 amountOut, uint256 profit) {
        if (amountIn == 0 || amountIn > uint128(type(int128).max)) revert InvalidAmount();
        if (path.length == 0) revert EmptyPath();

        bytes memory result = IPoolManager(POOL_MANAGER).unlock(
            abi.encode(base, amountIn, minProfit, path)
        );
        (amountOut, profit) = abi.decode(result, (uint256, uint256));
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != POOL_MANAGER) revert NotPoolManager();

        (address base, uint128 initialAmount, uint128 minProfit, PathHop[] memory path) =
            abi.decode(rawData, (address, uint128, uint128, PathHop[]));

        address current = base;
        uint256 amount = initialAmount;

        for (uint256 i = 0; i < path.length; ++i) {
            PathHop memory hop = path[i];
            address next = hop.intermediateCurrency;

            if (next == current) revert InvalidHop();
            if (hop.hooks != address(0)) revert HooksUnsupported();
            if (hop.hookData.length != 0) revert HookDataUnsupported();
            if (amount == 0 || amount > uint256(uint128(type(int128).max))) revert InvalidAmount();

            bool zeroForOne = current < next;
            PoolKey memory key = zeroForOne
                ? PoolKey(current, next, hop.fee, hop.tickSpacing, address(0))
                : PoolKey(next, current, hop.fee, hop.tickSpacing, address(0));

            int256 packed = IPoolManager(POOL_MANAGER).swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(amount),
                    sqrtPriceLimitX96: zeroForOne
                        ? MIN_SQRT_PRICE_PLUS_ONE
                        : MAX_SQRT_PRICE_MINUS_ONE
                }),
                bytes("")
            );

            int128 amount0;
            int128 amount1;
            assembly ("memory-safe") {
                amount0 := sar(128, packed)
                amount1 := signextend(15, packed)
            }

            int128 inputDelta = zeroForOne ? amount0 : amount1;
            int128 outputDelta = zeroForOne ? amount1 : amount0;
            if (inputDelta >= 0 || outputDelta <= 0) {
                revert InvalidDelta(i, inputDelta, outputDelta);
            }

            uint256 consumed = uint256(-int256(inputDelta));
            if (consumed != amount) revert PartialFill(i, amount, consumed);

            amount = uint256(int256(outputDelta));
            current = next;
        }

        if (current != base) revert CycleNotClosed(base, current);
        if (amount <= initialAmount) revert NoProfit(initialAmount, amount);

        uint256 profit = amount - initialAmount;
        if (profit < minProfit) revert ProfitBelowMinimum(profit, minProfit);

        // Exact chaining guarantees every intermediate delta is zero. The net
        // base delta is profit; taking exactly that amount settles the final
        // non-zero PoolManager delta. If this invariant is wrong, PoolManager
        // unlock itself reverts with CurrencyNotSettled.
        IPoolManager(POOL_MANAGER).take(base, address(this), profit);

        return abi.encode(amount, profit);
    }

    receive() external payable {}
}
