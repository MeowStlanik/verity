# Solidity prototype (not the GenLayer path)

> **These contracts are not deployed and are not what Verity Markets settles on.**
> On GenLayer the market itself is a Python Intelligent Contract —
> [`genlayer/contracts/PredictionMarket.py`](../genlayer/contracts/PredictionMarket.py) —
> which is what actually custodies GEN on Bradbury. The Solidity here is an
> earlier design of the same mechanism for an EVM chain, kept because it is
> where the CPMM, the challenge window and the liability rules were worked out.
> It is covered only by a compile test; there is no EVM simulator in this repo,
> so it has no executable behavioural tests. Read it as a design document.

`BinaryMarket.sol` is one native-GEN-collateralized binary market. Buys, LP deposits, and challenges use payable calls; payouts, sells, and refunds return native GEN, so the testnet demo needs no separate token faucet or approval transaction. Deterministic, structured-fact, and judgment markets differ only in the GenLayer resolver that supplies their fixed outcome. `MarketFactory.sol` permanently binds its GenLayer resolver address, `resolutionSpecHash`, and `sourcesHash`, and sets the factory-wide challenge policy (`minChallengeStake`, `emergencyVoidDelay`).

## Pricing

Net collateral mints a complete set (one YES and one NO per unit). The trader keeps the side they bought and sells the other into the constant-product pool, so a buy returns `net + outReserve * net / (inReserve + net)` shares. `quote()`/`quoteSell()` are the exact paths used by `buy()`/`sell()`; both fills carry a deadline and minimum output.

## Lifecycle

`Trading -> Closed -> ChallengeWindow -> (Disputed) -> ResolvedYes | ResolvedNo | Void`

Only the configured `resolutionAuthority` may publish or finalize a resolution; run that key behind a relay that verifies a finalized GenLayer result, never in a browser. Notable properties:

- **VOID is not a shortcut.** It is published as a preliminary outcome like YES and NO and opens the same challenge window, so a mistaken VOID can be disputed.
- **The challenge stake always leaves the contract.** `finalize` sends it to the challenger if the outcome moved and to `feeRecipient` if it did not; `emergencyVoid` returns it.
- **`emergencyVoid` is permissionless but only from `Closed`** once `emergencyVoidAt` passes, so it cannot interrupt a challenge or dispute.
- **Withdrawals respect the VOID refund.** `removeLiquidity` requires the remaining collateral to cover `liability()`, which is the largest of the YES payout, the NO payout and the gross refund a VOID owes — not just the outstanding shares.
- **Liquidity providers can exit after settlement** via `claimLiquidity()`, which pays the residual fixed at finalization. Without it a VOID would strand every LP deposit.
- **Fees are only earned on a settled outcome.** `claimFees()` pays `feeRecipient` after YES or NO; on a VOID the fees are refunded to traders as part of their gross cost.

This is testnet/MVP code, not an audited mainnet deployment. A mainnet launch needs a professional Solidity audit, a threshold/verified GenLayer relay, economic stress tests, and legal review.
