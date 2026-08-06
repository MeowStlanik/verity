// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Collateral and payout contract for one binary Verity market.
/// @dev Resolution is deliberately separate: a GenLayer relay is the only resolutionAuthority.
///      Every outcome, VOID included, goes through the challenge window, so a mistaken
///      VOID stays disputable instead of settling instantly.
contract BinaryMarket {
    enum State { Trading, Closed, ChallengeWindow, Disputed, ResolvedYes, ResolvedNo, Void }
    enum Outcome { Yes, No, Void }
    struct MarketConfig {
        address marketCreator;
        address resolutionAuthority;
        address genLayerResolver;
        address feeRecipient;
        bytes32 resolutionSpecHash;
        bytes32 sourcesHash;
        uint64 closesAt;
        uint32 feeBps;
        uint32 challengePeriod;
        uint256 initialLiquidity;
        uint256 minChallengeStake;
        uint32 emergencyVoidDelay;
    }

    address public immutable creator;
    address public immutable resolutionAuthority;
    address public immutable genLayerResolver;
    address public immutable feeRecipient;
    bytes32 public immutable resolutionSpecHash;
    bytes32 public immutable sourcesHash;
    uint64 public immutable closesAt;
    uint32 public immutable feeBps;
    uint32 public immutable challengePeriod;
    uint256 public immutable minChallengeStake;
    /// @notice After this instant anyone may void a market the resolver never settled,
    ///         so a silent or lost relay cannot lock collateral up forever.
    uint64 public immutable emergencyVoidAt;

    State public state;
    Outcome public preliminaryOutcome;
    uint64 public challengeEndsAt;
    address public challenger;
    uint256 public challengeStake;

    uint256 public yesReserve;
    uint256 public noReserve;
    uint256 public collateral;
    uint256 public totalYesShares;
    uint256 public totalNoShares;
    uint256 public totalLpShares;
    /// @notice Fees owed to `feeRecipient`, payable only if the market resolves YES or NO.
    ///         A VOID refunds gross cost, so on that path the fees go back to traders.
    uint256 public accruedFees;
    /// @notice Sum of every trader's gross spend: exactly what a VOID has to hand back.
    uint256 public refundLiability;
    /// @notice Collateral left over for liquidity providers once payouts are fixed at finalization.
    uint256 public lpResidual;
    bool public feesClaimed;

    mapping(address => uint256) public yesShares;
    mapping(address => uint256) public noShares;
    mapping(address => uint256) public yesPaidCost;
    mapping(address => uint256) public noPaidCost;
    mapping(address => uint256) public lpShares;
    mapping(address => bool) public claimed;
    mapping(address => bool) public lpClaimed;

    uint256 private _entered;

    event Trade(address indexed trader, bool indexed sideYes, uint256 amount, uint256 shares, uint256 fee);
    event Sold(address indexed trader, bool indexed sideYes, uint256 shares, uint256 amountOut, uint256 fee);
    event Liquidity(address indexed provider, bool indexed added, uint256 amount, uint256 lpShares);
    event Closed();
    event Preliminary(Outcome indexed outcome, bytes32 evidenceHash, uint64 challengeEndsAt);
    event Challenged(address indexed challenger, uint256 stake, bytes32 reasonHash);
    event Finalized(State indexed result, bytes32 evidenceHash, uint256 lpResidual);
    event Claimed(address indexed user, uint256 amount, bool refund);
    event LiquidityClaimed(address indexed provider, uint256 amount);
    event FeesClaimed(address indexed recipient, uint256 amount);

    modifier onlyResolver() { require(msg.sender == resolutionAuthority, "resolver only"); _; }
    modifier onlyTrading() { require(state == State.Trading, "market not trading"); _; }
    modifier nonReentrant() { require(_entered == 0, "reentrant"); _entered = 1; _; _entered = 0; }

    constructor(MarketConfig memory cfg) payable {
        require(cfg.marketCreator != address(0) && cfg.resolutionAuthority != address(0) && cfg.genLayerResolver != address(0) && cfg.feeRecipient != address(0), "zero address");
        require(cfg.closesAt > block.timestamp && cfg.initialLiquidity > 0 && cfg.feeBps <= 1_000, "bad config");
        require(msg.value == cfg.initialLiquidity, "initial GEN mismatch");
        require(cfg.minChallengeStake > 0 && cfg.emergencyVoidDelay > cfg.challengePeriod, "bad challenge config");
        creator = cfg.marketCreator; resolutionAuthority = cfg.resolutionAuthority; genLayerResolver = cfg.genLayerResolver; feeRecipient = cfg.feeRecipient;
        resolutionSpecHash = cfg.resolutionSpecHash; sourcesHash = cfg.sourcesHash; closesAt = cfg.closesAt; feeBps = cfg.feeBps; challengePeriod = cfg.challengePeriod;
        minChallengeStake = cfg.minChallengeStake; emergencyVoidAt = cfg.closesAt + cfg.emergencyVoidDelay;
        state = State.Trading; collateral = cfg.initialLiquidity; yesReserve = cfg.initialLiquidity; noReserve = cfg.initialLiquidity;
        totalLpShares = cfg.initialLiquidity; lpShares[cfg.marketCreator] = cfg.initialLiquidity;
    }

    /// @notice YES price in 1e18, derived from the two virtual CPMM reserves.
    function yesPrice() public view returns (uint256) { return noReserve * 1e18 / (yesReserve + noReserve); }

    /// @notice Everything the collateral must still be able to cover, whichever way this market lands.
    /// @dev Every payout path is bounded by this figure, so LP withdrawals can never drain
    ///      the collateral below what a YES, a NO, or a VOID would owe.
    function liability() public view returns (uint256) {
        uint256 yesSide = totalYesShares + accruedFees;
        uint256 noSide = totalNoShares + accruedFees;
        uint256 top = yesSide > noSide ? yesSide : noSide;
        return top > refundLiability ? top : refundLiability;
    }

    /// @notice Quote for `amount` of collateral, using exactly the pricing `buy` applies.
    /// @dev The net collateral mints a complete set (one YES and one NO per unit); the
    ///      trader keeps the side they bought and sells the other into the constant-product
    ///      pool. `fromPool` is what that swap returns, so `shares = net + fromPool`.
    ///      A plain `2 * outReserve * net / (inReserve + net)` only matches the quoted price
    ///      at 50/50 and badly under-pays on any skewed market.
    function quote(bool sideYes, uint256 amount) public view returns (uint256 shares, uint256 fee, uint256 fromPool) {
        fee = amount * feeBps / 10_000;
        uint256 net = amount - fee;
        uint256 outReserve = sideYes ? yesReserve : noReserve;
        uint256 inReserve = sideYes ? noReserve : yesReserve;
        fromPool = outReserve * net / (inReserve + net);
        shares = net + fromPool;
    }

    function close() external onlyTrading {
        require(block.timestamp >= closesAt, "close time not reached"); state = State.Closed; emit Closed();
    }

    function buy(bool sideYes, uint256 minSharesOut, uint256 deadline)
        external payable onlyTrading nonReentrant returns (uint256 shares)
    {
        uint256 amount = msg.value;
        require(block.timestamp <= deadline, "quote expired");
        require(block.timestamp < closesAt && amount > 0, "trade unavailable");
        uint256 fee;
        uint256 fromPool;
        (shares, fee, fromPool) = quote(sideYes, amount);
        require(shares >= minSharesOut, "slippage");
        require(shares > 0 && fromPool < (sideYes ? yesReserve : noReserve), "insufficient liquidity");
        uint256 net = amount - fee;
        if (sideYes) {
            yesReserve -= fromPool; noReserve += net; totalYesShares += shares; yesShares[msg.sender] += shares;
        } else {
            noReserve -= fromPool; yesReserve += net; totalNoShares += shares; noShares[msg.sender] += shares;
        }
        collateral += amount; refundLiability += amount; accruedFees += fee;
        if (sideYes) yesPaidCost[msg.sender] += amount; else noPaidCost[msg.sender] += amount;
        require(liability() <= collateral, "insufficient collateral backing");
        emit Trade(msg.sender, sideYes, amount, shares, fee);
    }

    function quoteSell(bool sideYes, uint256 shares) public view returns (uint256 amountOut, uint256 fee, uint256 gross) {
        uint256 outReserve = sideYes ? yesReserve : noReserve;
        uint256 inReserve = sideYes ? noReserve : yesReserve;
        uint256 sum = outReserve + inReserve + shares;
        uint256 discriminant = sum * sum - 4 * inReserve * shares;
        gross = (sum - _sqrt(discriminant)) / 2;
        fee = gross * feeBps / 10_000;
        amountOut = gross - fee;
    }

    function sell(bool sideYes, uint256 shares, uint256 minAmountOut, uint256 deadline)
        external onlyTrading nonReentrant returns (uint256 amountOut)
    {
        require(block.timestamp <= deadline && block.timestamp < closesAt, "trade unavailable");
        uint256 owned = sideYes ? yesShares[msg.sender] : noShares[msg.sender];
        require(shares > 0 && shares <= owned, "insufficient shares");
        uint256 fee; uint256 gross;
        (amountOut, fee, gross) = quoteSell(sideYes, shares);
        require(amountOut >= minAmountOut && gross > 0, "slippage");
        uint256 cost = (sideYes ? yesPaidCost[msg.sender] : noPaidCost[msg.sender]) * shares / owned;
        if (sideYes) {
            yesShares[msg.sender] -= shares; totalYesShares -= shares; yesPaidCost[msg.sender] -= cost;
            yesReserve += shares - gross; noReserve -= gross;
        } else {
            noShares[msg.sender] -= shares; totalNoShares -= shares; noPaidCost[msg.sender] -= cost;
            noReserve += shares - gross; yesReserve -= gross;
        }
        refundLiability -= cost; accruedFees += fee; collateral -= amountOut;
        require(liability() <= collateral, "insufficient collateral backing");
        _safeTransfer(msg.sender, amountOut); emit Sold(msg.sender, sideYes, shares, amountOut, fee);
    }

    function addLiquidity() external payable onlyTrading nonReentrant returns (uint256 minted) {
        uint256 amount = msg.value;
        require(block.timestamp < closesAt && amount > 0, "liquidity unavailable");
        minted = amount * totalLpShares / collateral;
        uint256 newCollateral = collateral + amount;
        yesReserve = yesReserve * newCollateral / collateral; noReserve = noReserve * newCollateral / collateral;
        collateral = newCollateral; totalLpShares += minted; lpShares[msg.sender] += minted;
        emit Liquidity(msg.sender, true, amount, minted);
    }

    function removeLiquidity(uint256 shares) external onlyTrading nonReentrant returns (uint256 payout) {
        require(block.timestamp < closesAt && shares > 0 && shares <= lpShares[msg.sender], "bad LP shares");
        payout = collateral * shares / totalLpShares;
        uint256 newCollateral = collateral - payout;
        // Withdrawals must leave enough behind for a VOID refund of every trader's gross
        // spend, not merely for the outstanding YES/NO shares.
        require(newCollateral >= liability(), "collateral still backing liabilities");
        yesReserve = yesReserve * (totalLpShares - shares) / totalLpShares;
        noReserve = noReserve * (totalLpShares - shares) / totalLpShares;
        collateral = newCollateral; totalLpShares -= shares; lpShares[msg.sender] -= shares;
        _safeTransfer(msg.sender, payout); emit Liquidity(msg.sender, false, payout, shares);
    }

    /// @notice Publish the resolver's proposed outcome. VOID is a proposal like any other and
    ///         opens the same challenge window.
    function publishPreliminary(Outcome outcome, bytes32 evidenceHash) external onlyResolver {
        require(state == State.Closed, "market must be closed");
        preliminaryOutcome = outcome; state = State.ChallengeWindow;
        challengeEndsAt = uint64(block.timestamp + challengePeriod);
        emit Preliminary(outcome, evidenceHash, challengeEndsAt);
    }

    function challenge(bytes32 reasonHash) external payable nonReentrant {
        uint256 stake = msg.value;
        require(state == State.ChallengeWindow && block.timestamp < challengeEndsAt && challenger == address(0), "challenge unavailable");
        require(stake >= minChallengeStake, "stake below minimum");
        challenger = msg.sender; challengeStake = stake; state = State.Disputed; emit Challenged(msg.sender, stake, reasonHash);
    }

    function finalize(Outcome result, bytes32 evidenceHash) external onlyResolver nonReentrant {
        require(state == State.Disputed || (state == State.ChallengeWindow && block.timestamp >= challengeEndsAt), "not finalizable");
        require(state == State.Disputed || result == preliminaryOutcome, "uncontested outcome mismatch");
        _settle(result, evidenceHash);
        if (challenger != address(0)) {
            // A challenger who moved the outcome gets the stake back; one who did not
            // forfeits it. Either way the stake always leaves the contract.
            address recipient = result == preliminaryOutcome ? feeRecipient : challenger;
            uint256 stake = challengeStake; challengeStake = 0;
            _safeTransfer(recipient, stake);
        }
    }

    /// @notice Escape hatch against a resolver that never settles. Permissionless on purpose.
    function emergencyVoid() external nonReentrant {
        require(state == State.Closed, "only unresolved closed market");
        require(block.timestamp >= emergencyVoidAt, "emergency delay not elapsed");
        _settle(Outcome.Void, bytes32(0));
        if (challenger != address(0)) {
            // Nobody adjudicated the dispute, so the stake goes back to the challenger.
            uint256 stake = challengeStake; challengeStake = 0;
            _safeTransfer(challenger, stake);
        }
    }

    function _settle(Outcome result, bytes32 evidenceHash) private {
        if (result == Outcome.Void) {
            state = State.Void;
            lpResidual = collateral - refundLiability;
            // Fees ride along inside each trader's gross refund, so none are owed here.
            accruedFees = 0;
        } else if (result == Outcome.Yes) {
            state = State.ResolvedYes;
            lpResidual = collateral - totalYesShares - accruedFees;
        } else {
            state = State.ResolvedNo;
            lpResidual = collateral - totalNoShares - accruedFees;
        }
        emit Finalized(state, evidenceHash, lpResidual);
    }

    function claim() external nonReentrant returns (uint256 payout) {
        require(!claimed[msg.sender], "already claimed");
        bool isVoid = state == State.Void;
        require(isVoid || state == State.ResolvedYes || state == State.ResolvedNo, "not resolved");
        claimed[msg.sender] = true;
        payout = isVoid ? yesPaidCost[msg.sender] + noPaidCost[msg.sender] : (state == State.ResolvedYes ? yesShares[msg.sender] : noShares[msg.sender]);
        require(payout > 0, "nothing to claim");
        _safeTransfer(msg.sender, payout); emit Claimed(msg.sender, payout, isVoid);
    }

    /// @notice Liquidity providers recover the residual collateral once payouts are fixed.
    ///         Without this a VOID would strand every LP deposit in the contract.
    function claimLiquidity() external nonReentrant returns (uint256 payout) {
        require(state == State.ResolvedYes || state == State.ResolvedNo || state == State.Void, "not resolved");
        require(!lpClaimed[msg.sender], "already claimed");
        uint256 shares = lpShares[msg.sender];
        require(shares > 0, "no LP position");
        lpClaimed[msg.sender] = true;
        payout = lpResidual * shares / totalLpShares;
        require(payout > 0, "nothing to claim");
        _safeTransfer(msg.sender, payout); emit LiquidityClaimed(msg.sender, payout);
    }

    function claimFees() external nonReentrant returns (uint256 payout) {
        require(msg.sender == feeRecipient, "fee recipient only");
        require(state == State.ResolvedYes || state == State.ResolvedNo, "fees payable only on a settled outcome");
        require(!feesClaimed, "already claimed");
        feesClaimed = true; payout = accruedFees;
        require(payout > 0, "nothing to claim");
        _safeTransfer(feeRecipient, payout); emit FeesClaimed(feeRecipient, payout);
    }

    function _safeTransfer(address to, uint256 value) private {
        (bool ok,) = payable(to).call{value: value}("");
        require(ok, "GEN transfer failed");
    }

    function _sqrt(uint256 x) private pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x; uint256 y = (x + 1) / 2;
        while (y < z) { z = y; y = (x / y + y) / 2; }
    }
}
