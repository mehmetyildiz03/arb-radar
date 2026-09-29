// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

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

struct Hop {
    address output;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct CallbackData {
    bool requireProfit;
    address recipient;
    uint128 amountIn;
    uint128 minProfit;
    Hop[] hops;
}

/// @notice Minimal research-only hookless V4 closed-cycle executor.
/// @dev Designed for state-override simulation. No admin, storage, approvals or deployment flow.
contract AtomicCycleExecutor {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    error NotPoolManager();
    error InvalidCycle();
    error HooksUnsupported();
    error PartialSwap(uint256 hop);
    error NotProfitable(uint256 amountIn, uint256 amountOut, uint256 minProfit);
    error InsufficientProbeBalance(uint256 needed, uint256 available);

    function executeNative(uint128 amountIn, uint128 minProfit, Hop[] calldata hops, address recipient)
        external
        returns (uint256 profit)
    {
        if (recipient == address(0)) recipient = msg.sender;
        bytes memory result = IPoolManagerLite(POOL_MANAGER).unlock(
            abi.encode(CallbackData(true, recipient, amountIn, minProfit, hops))
        );
        profit = abi.decode(result, (uint256));
    }

    /// @notice Research helper: completes an unprofitable native cycle by paying the loss
    /// from this contract's overridden balance. Never intended for transaction submission.
    function probeNative(uint128 amountIn, Hop[] calldata hops) external returns (uint256 amountOut) {
        bytes memory result = IPoolManagerLite(POOL_MANAGER).unlock(
            abi.encode(CallbackData(false, address(this), amountIn, 0, hops))
        );
        amountOut = abi.decode(result, (uint256));
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != POOL_MANAGER) revert NotPoolManager();
        CallbackData memory data = abi.decode(rawData, (CallbackData));
        if (data.amountIn == 0 || data.hops.length == 0) revert InvalidCycle();

        uint128 amount = data.amountIn;
        address input = address(0);

        for (uint256 i = 0; i < data.hops.length; i++) {
            Hop memory hop = data.hops[i];
            if (hop.hooks != address(0)) revert HooksUnsupported();
            if (hop.output == input) revert InvalidCycle();

            bool zeroForOne = uint160(input) < uint160(hop.output);
            PoolKey memory key = zeroForOne
                ? PoolKey(input, hop.output, hop.fee, hop.tickSpacing, address(0))
                : PoolKey(hop.output, input, hop.fee, hop.tickSpacing, address(0));

            int256 packed = IPoolManagerLite(POOL_MANAGER).swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(uint256(amount)),
                    sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
                }),
                ""
            );

            int128 inputDelta = zeroForOne ? _amount0(packed) : _amount1(packed);
            int128 outputDelta = zeroForOne ? _amount1(packed) : _amount0(packed);
            if (inputDelta != -int128(amount) || outputDelta <= 0) revert PartialSwap(i);

            amount = uint128(outputDelta);
            input = hop.output;
        }

        if (input != address(0)) revert InvalidCycle();

        if (amount >= data.amountIn) {
            uint256 profit = uint256(amount) - uint256(data.amountIn);
            if (data.requireProfit && profit < data.minProfit) {
                revert NotProfitable(data.amountIn, amount, data.minProfit);
            }
            if (profit > 0) {
                IPoolManagerLite(POOL_MANAGER).take(address(0), data.recipient, profit);
            }
            return data.requireProfit ? abi.encode(profit) : abi.encode(uint256(amount));
        }

        if (data.requireProfit) revert NotProfitable(data.amountIn, amount, data.minProfit);

        uint256 loss = uint256(data.amountIn) - uint256(amount);
        if (address(this).balance < loss) revert InsufficientProbeBalance(loss, address(this).balance);
        IPoolManagerLite(POOL_MANAGER).settle{value: loss}();
        return abi.encode(uint256(amount));
    }

    function _amount0(int256 packed) private pure returns (int128 amount0) {
        assembly ("memory-safe") {
            amount0 := sar(128, packed)
        }
    }

    function _amount1(int256 packed) private pure returns (int128 amount1) {
        assembly ("memory-safe") {
            amount1 := signextend(15, packed)
        }
    }

    receive() external payable {}
}


interface IPoolManagerLite {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(
        PoolKey memory key,
        SwapParams memory params,
        bytes calldata hookData
    ) external returns (int256 swapDelta);
    function take(address currency, address to, uint256 amount) external;
    function settle() external payable returns (uint256 paid);
}
