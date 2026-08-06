// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BinaryMarket.sol";

/// @notice Permissionless deployer. `resolutionSpecHash` and `sourcesHash` bind a market to immutable off-chain text.
/// @dev The challenge economics are factory-wide policy rather than a per-market argument,
///      so the minimum stake the UI advertises is the minimum the chain actually enforces.
contract MarketFactory {
    address public immutable resolutionAuthority;
    address public immutable feeRecipient;
    /// @notice Minimum challenge stake in native GEN wei.
    uint256 public immutable minChallengeStake;
    /// @notice How long after close a market may sit unresolved before anyone can void it.
    uint32 public immutable emergencyVoidDelay;

    mapping(address => bool) public isMarket;
    event MarketCreated(address indexed market, address indexed creator, bytes32 indexed resolutionSpecHash, uint64 closesAt);

    constructor(address resolver, address fees, uint256 minStake, uint32 voidDelay) {
        require(resolver != address(0) && fees != address(0), "zero address");
        require(minStake > 0 && voidDelay > 0, "bad policy");
        resolutionAuthority = resolver; feeRecipient = fees;
        minChallengeStake = minStake; emergencyVoidDelay = voidDelay;
    }

    function createMarket(address genLayerResolver, bytes32 specHash, bytes32 sourcesHash, uint64 closesAt, uint32 feeBps, uint32 challengeSeconds) external payable returns (address market) {
        require(emergencyVoidDelay > challengeSeconds, "challenge period too long");
        require(msg.value > 0, "initial GEN required");
        BinaryMarket.MarketConfig memory cfg = BinaryMarket.MarketConfig({
            marketCreator: msg.sender, resolutionAuthority: resolutionAuthority,
            genLayerResolver: genLayerResolver, feeRecipient: feeRecipient, resolutionSpecHash: specHash,
            sourcesHash: sourcesHash, closesAt: closesAt, feeBps: feeBps, challengePeriod: challengeSeconds,
            initialLiquidity: msg.value, minChallengeStake: minChallengeStake, emergencyVoidDelay: emergencyVoidDelay
        });
        BinaryMarket deployed = new BinaryMarket{value: msg.value}(cfg);
        market = address(deployed); isMarket[market] = true;
        emit MarketCreated(market, msg.sender, specHash, closesAt);
    }
}
