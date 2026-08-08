# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""The market itself: GEN custody, CPMM pricing and settlement, on GenLayer.

This contract is the source of truth for a Verity market. It holds native GEN,
prices YES/NO with an integer complete-set CPMM, and takes its outcome from the
resolver contract that was locked into it at deployment. Nothing here lets the
creator, the challenger or any keeper choose the outcome.

Design notes that matter for reading the code:

* Every amount is an integer number of wei. There is no floating point on the
  money path at all, so a quote shown in the UI and the fill executed here agree
  exactly rather than approximately.
* Reserves are seeded so that ``max(yes_reserve, no_reserve) <= collateral``.
  That is the invariant that makes a complete-set CPMM solvent: the most a buyer
  can ever extract is their own stake plus one reserve.
* GenLayer messages are asynchronous. State is therefore always written *before*
  a transfer is emitted, and accounting is done against ``self.collateral``
  rather than ``self.balance``, which lags behind emitted transfers.
"""
import genlayer.gl as gl
from genlayer.py.public_abi import StorageType

PENDING = "PENDING"
YES = "YES"
NO = "NO"
VOID = "VOID"
OUTCOMES = (YES, NO, VOID)
BPS = 10_000
ZERO = b"\x00" * 20
MAX_REASON_CHARS = 2048


def _days_from_civil(year: int, month: int, day: int) -> int:
    """Exact integer days between 1970-01-01 and the given civil date."""
    year -= 1 if month <= 2 else 0
    era = (year if year >= 0 else year - 399) // 400
    year_of_era = year - era * 400
    day_of_year = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    day_of_era = year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year
    return era * 146097 + day_of_era - 719468


def _epoch(value: str) -> int:
    """Parse an ISO-8601 UTC timestamp into whole seconds.

    Written by hand rather than with `datetime` so the settlement path depends on
    nothing but integer arithmetic, and so a malformed timestamp is a loud error
    instead of a silently different instant.
    """
    text = value.strip()
    if len(text) < 19 or text[4] != "-" or text[7] != "-" or text[10] not in ("T", " "):
        raise ValueError("timestamp is not ISO-8601")
    offset = 0
    tail = text[19:]
    if tail.endswith("Z"):
        tail = tail[:-1]
    for index in range(len(tail)):
        if tail[index] in ("+", "-"):
            sign = -1 if tail[index] == "+" else 1
            zone = tail[index + 1:].replace(":", "")
            if len(zone) < 4 or not zone.isdigit():
                raise ValueError("timestamp has an unreadable UTC offset")
            offset = sign * (int(zone[:2]) * 3600 + int(zone[2:4]) * 60)
            break
    parts = (text[0:4], text[5:7], text[8:10], text[11:13], text[14:16], text[17:19])
    if not all(part.isdigit() for part in parts):
        raise ValueError("timestamp is not ISO-8601")
    year, month, day, hour, minute, second = (int(part) for part in parts)
    return _days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second + offset


def _isqrt(value: int) -> int:
    """Floor integer square root (Newton). Avoids depending on `math` in the VM."""
    if value < 0:
        raise ValueError("negative square root")
    if value < 2:
        return value
    guess = 1 << ((value.bit_length() + 1) // 2)
    while True:
        better = (guess + value // guess) // 2
        if better >= guess:
            return guess
        guess = better


@gl.storage.allow_storage
class Position:
    """Everything this contract owes, or has already paid, one address at a time.

    One `TreeMap` per field used to hold this. A single map of records stores the
    same state in one tree instead of seven, which is both less storage schema to
    generate at deployment and one lookup per address instead of one per field.

    The VOID refund basis is held as `yes_cost` and `no_cost` rather than as one
    total, because the two legs of a mixed position are retired independently and
    a single total cannot say which of them a sale just cashed out.
    """
    yes_shares: gl.u256
    no_shares: gl.u256
    yes_cost: gl.u256
    no_cost: gl.u256
    lp_shares: gl.u256
    claimed: bool
    lp_claimed: bool


class PredictionMarket(gl.Contract):
    # Immutable market identity, all fixed at deployment.
    market_id: str
    creator: gl.Address
    resolver: gl.Address
    dispute_resolver: gl.Address
    resolution_spec_hash: str
    sources_hash: str
    observation_time: str
    question: str
    fee_bps: gl.bigint
    challenge_window_seconds: gl.bigint
    min_challenge_stake: gl.u256

    # CPMM and custody, all in wei.
    yes_reserve: gl.u256
    no_reserve: gl.u256
    collateral: gl.u256
    accrued_fees: gl.u256
    total_yes_shares: gl.u256
    total_no_shares: gl.u256
    refund_liability: gl.u256
    lp_total: gl.u256
    lp_residual: gl.u256
    positions: gl.storage.TreeMap[gl.Address, Position]

    # Settlement.
    preliminary_outcome: str
    preliminary_at: str
    challenge_closes_at: gl.bigint
    final_outcome: str
    final_at: str
    resolver_evidence: str
    challenger: gl.Address
    challenge_stake: gl.u256
    challenge_reason: str
    challenge_settled: bool

    def __init__(self, market_id: str, question: str, resolver: str, dispute_resolver: str,
                 resolution_spec_hash: str, sources_hash: str, observation_time: str,
                 fee_bps: int, challenge_window_seconds: int, min_challenge_stake: int):
        if not market_id:
            raise ValueError("market id is required")
        if not 0 <= fee_bps <= 1000:
            raise ValueError("fee must be between 0 and 1000 bps")
        if challenge_window_seconds < 60:
            raise ValueError("challenge window must be at least 60 seconds")
        if min_challenge_stake <= 0:
            raise ValueError("minimum challenge stake must be positive")
        # A market with no adjudicator has no way to tell a right challenge from a
        # wrong one, and the only safe thing it could do with a challenge it cannot
        # judge is void. That makes the minimum stake a free option to cancel any
        # market, so the configuration is refused at deployment instead of being
        # documented as a limitation.
        if gl.Address(dispute_resolver).as_bytes == ZERO:
            raise ValueError("a dispute resolver is required")
        # An adjudicator that is the resolver under dispute would uphold itself
        # every time, which is the same market with extra steps.
        if gl.Address(dispute_resolver).as_bytes == gl.Address(resolver).as_bytes:
            raise ValueError("the dispute resolver must not be the resolver it adjudicates")
        # Rejects a malformed observation time at deployment rather than at
        # settlement, when the market would already hold other people's money.
        _epoch(observation_time)
        self.market_id = market_id
        self.question = question
        self.creator = gl.message.sender_address
        self.resolver = gl.Address(resolver)
        self.dispute_resolver = gl.Address(dispute_resolver)
        self.resolution_spec_hash = resolution_spec_hash
        self.sources_hash = sources_hash
        self.observation_time = observation_time
        self.fee_bps = gl.bigint(fee_bps)
        self.challenge_window_seconds = gl.bigint(challenge_window_seconds)
        self.min_challenge_stake = gl.u256(min_challenge_stake)

        self.yes_reserve = gl.u256(0)
        self.no_reserve = gl.u256(0)
        self.collateral = gl.u256(0)
        self.accrued_fees = gl.u256(0)
        self.total_yes_shares = gl.u256(0)
        self.total_no_shares = gl.u256(0)
        self.refund_liability = gl.u256(0)
        self.lp_total = gl.u256(0)
        self.lp_residual = gl.u256(0)

        self.preliminary_outcome = PENDING
        self.preliminary_at = ""
        self.challenge_closes_at = gl.bigint(0)
        self.final_outcome = PENDING
        self.final_at = ""
        self.resolver_evidence = ""
        self.challenger = gl.Address(ZERO)
        self.challenge_stake = gl.u256(0)
        self.challenge_reason = ""
        self.challenge_settled = False

    # ------------------------------------------------------------------ helpers

    def _now(self) -> int:
        return _epoch(gl.message_raw["datetime"])

    def _closes_at(self) -> int:
        return _epoch(self.observation_time)

    def _require_open(self, deadline: int):
        if self.preliminary_outcome != PENDING:
            raise ValueError("market is settling")
        if self._now() >= self._closes_at():
            raise ValueError("trading closed at the observation time")
        if deadline and self._now() > deadline:
            raise ValueError("quote deadline has passed")

    def _liability(self) -> int:
        """Everything the collateral must still cover, whichever way this lands."""
        return max(int(self.total_yes_shares), int(self.total_no_shares), int(self.refund_liability))

    def _reserves(self, side_yes: bool):
        """(out_reserve, in_reserve) for a trade on the given side."""
        if side_yes:
            return int(self.yes_reserve), int(self.no_reserve)
        return int(self.no_reserve), int(self.yes_reserve)

    def _write_reserves(self, side_yes: bool, out_reserve: int, in_reserve: int):
        if side_yes:
            self.yes_reserve = gl.u256(out_reserve)
            self.no_reserve = gl.u256(in_reserve)
        else:
            self.no_reserve = gl.u256(out_reserve)
            self.yes_reserve = gl.u256(in_reserve)

    def _quote_buy(self, side_yes: bool, gross: int):
        """Complete-set CPMM buy.

        The stake mints one YES and one NO; the trader keeps the side they asked
        for and sells the other into the constant-product pool:

            shares = net + out_reserve * net / (in_reserve + net)
        """
        if gross <= 0:
            raise ValueError("amount must be positive")
        fee = gross * int(self.fee_bps) // BPS
        net = gross - fee
        out_reserve, in_reserve = self._reserves(side_yes)
        if in_reserve + net == 0:
            raise ValueError("market has no liquidity")
        # Floor division keeps the rounding error inside the pool, never in the
        # trader's favour, so rounding can only ever improve solvency.
        from_pool = out_reserve * net // (in_reserve + net)
        return net + from_pool, from_pool, fee, net

    def _quote_sell(self, side_yes: bool, shares: int):
        """Exact inverse of `_quote_buy`, solved over the integers.

            gross^2 - gross * (in + out + shares) + in * shares = 0
        """
        if shares <= 0:
            raise ValueError("share amount must be positive")
        out_reserve, in_reserve = self._reserves(side_yes)
        total = in_reserve + out_reserve + shares
        discriminant = total * total - 4 * in_reserve * shares
        if discriminant < 0:
            raise ValueError("insufficient liquidity for this sale")
        root = _isqrt(discriminant)
        if root * root < discriminant:
            # Round the root up so `gross` rounds down: the pool keeps the dust.
            root += 1
        gross = (total - root) // 2
        if gross <= 0 or gross >= in_reserve:
            raise ValueError("insufficient liquidity for this sale")
        fee = gross * int(self.fee_bps) // BPS
        return gross - fee, gross, fee, shares - gross

    def _read_resolver(self, address: gl.Address) -> dict:
        """Read a resolver's *finalized* binding and outcome.

        Only finalized state is consulted: a market must never settle from a
        result that consensus could still roll back.
        """
        view = gl.get_contract_at(address).view(state=StorageType.LATEST_FINAL)
        binding = view.market_binding()
        resolution = view.resolution()
        if (binding.get("marketId") != self.market_id
                or binding.get("resolutionSpecHash") != self.resolution_spec_hash
                or binding.get("sourcesHash") != self.sources_hash
                or binding.get("observationTime") != self.observation_time):
            raise ValueError("resolver is not bound to this market")
        outcome = resolution.get("outcome")
        resolved_at = resolution.get("resolvedAt") or ""
        if outcome not in OUTCOMES:
            raise ValueError("resolver has not produced an outcome yet")
        if not resolved_at:
            raise ValueError("resolver reported an outcome without a resolution time")
        if _epoch(resolved_at) < self._closes_at():
            raise ValueError("resolver executed before the locked observation time")
        return {"outcome": outcome, "resolvedAt": resolved_at, "evidence": str(resolution.get("evidence") or "")}

    def _pay(self, recipient: gl.Address, amount: int):
        """Send GEN out. Callers must have committed their state changes first."""
        if amount <= 0:
            return
        if amount > int(self.collateral):
            raise ValueError("payout exceeds tracked collateral")
        self.collateral = gl.u256(int(self.collateral) - amount)
        gl.get_contract_at(recipient).emit_transfer(value=gl.u256(amount), on="finalized")

    # ------------------------------------------------------------------ trading

    @gl.public.write.payable
    def add_liquidity(self) -> None:
        amount = int(gl.message.value)
        if amount <= 0:
            raise ValueError("send GEN to provide liquidity")
        self._require_open(0)
        sender = gl.message.sender_address
        collateral = int(self.collateral)
        if collateral == 0:
            # A fresh book opens at 0.50 with both reserves equal to the deposit,
            # which is exactly the seeding that keeps every reserve <= collateral.
            minted = amount
            self.yes_reserve = gl.u256(amount)
            self.no_reserve = gl.u256(amount)
            self.lp_total = gl.u256(amount)
        else:
            # LP shares are minted against *equity* — collateral minus what the
            # traders are already owed — not against gross collateral. Minting on
            # gross would sell the incoming LP a claim on money that is not the
            # pool's, and hand the difference to whoever deposited earlier.
            equity = collateral - self._liability()
            if equity <= 0:
                raise ValueError("the pool has no free equity to price a deposit against")
            minted = amount * int(self.lp_total) // equity
            if minted <= 0:
                raise ValueError("deposit is too small to mint an LP share")
            # Reserves still scale with collateral, not with equity: that is what
            # keeps `max(reserve) <= collateral` true, and it leaves the price
            # exactly where it was.
            grown = collateral + amount
            self.yes_reserve = gl.u256(int(self.yes_reserve) * grown // collateral)
            self.no_reserve = gl.u256(int(self.no_reserve) * grown // collateral)
            self.lp_total = gl.u256(int(self.lp_total) + minted)
        self.collateral = gl.u256(collateral + amount)
        position = self.positions.get_or_insert_default(sender)
        position.lp_shares = gl.u256(int(position.lp_shares) + minted)

    @gl.public.write.payable
    def buy_yes(self, min_shares_out: int, deadline: int) -> None:
        self._buy(True, min_shares_out, deadline)

    @gl.public.write.payable
    def buy_no(self, min_shares_out: int, deadline: int) -> None:
        self._buy(False, min_shares_out, deadline)

    def _buy(self, side_yes: bool, min_shares_out: int, deadline: int):
        gross = int(gl.message.value)
        if gross <= 0:
            raise ValueError("send GEN to buy shares")
        self._require_open(deadline)
        shares, from_pool, fee, net = self._quote_buy(side_yes, gross)
        out_reserve, in_reserve = self._reserves(side_yes)
        if from_pool >= out_reserve:
            raise ValueError("insufficient liquidity for this trade")
        if shares < min_shares_out:
            raise ValueError("price moved beyond the requested limit")

        total_yes = int(self.total_yes_shares) + (shares if side_yes else 0)
        total_no = int(self.total_no_shares) + (0 if side_yes else shares)
        refund = int(self.refund_liability) + gross
        # The one invariant that keeps the market solvent under skew, checked on
        # the projected book before a single field is written: a trade that would
        # outgrow its own backing is refused, not merely noticed afterwards.
        if max(total_yes, total_no, refund) > int(self.collateral) + gross:
            raise ValueError("this trade would exceed the collateral backing")

        sender = gl.message.sender_address
        self.total_yes_shares = gl.u256(total_yes)
        self.total_no_shares = gl.u256(total_no)
        self.refund_liability = gl.u256(refund)
        self._write_reserves(side_yes, out_reserve - from_pool, in_reserve + net)
        self.collateral = gl.u256(int(self.collateral) + gross)
        self.accrued_fees = gl.u256(int(self.accrued_fees) + fee)
        position = self.positions.get_or_insert_default(sender)
        # Cost is booked against the side it bought, so a later sale of one leg can
        # be priced against that leg's own basis.
        if side_yes:
            position.yes_shares = gl.u256(int(position.yes_shares) + shares)
            position.yes_cost = gl.u256(int(position.yes_cost) + gross)
        else:
            position.no_shares = gl.u256(int(position.no_shares) + shares)
            position.no_cost = gl.u256(int(position.no_cost) + gross)

    @gl.public.write
    def sell_yes(self, shares: int, min_amount_out: int, deadline: int) -> None:
        self._sell(True, shares, min_amount_out, deadline)

    @gl.public.write
    def sell_no(self, shares: int, min_amount_out: int, deadline: int) -> None:
        self._sell(False, shares, min_amount_out, deadline)

    def _sell(self, side_yes: bool, shares: int, min_amount_out: int, deadline: int):
        self._require_open(deadline)
        sender = gl.message.sender_address
        position = self.positions.get_or_insert_default(sender)
        held = int(position.yes_shares if side_yes else position.no_shares)
        if shares <= 0 or shares > held:
            raise ValueError("not enough shares to sell")
        amount_out, gross, fee, to_pool = self._quote_sell(side_yes, shares)
        if amount_out < min_amount_out:
            raise ValueError("price moved beyond the requested limit")

        # A sale gives back the share of the paid cost that it retires, so a VOID
        # refund can never pay for shares the trader has already cashed out — and
        # it retires that cost from the side being sold only. Charging a mixed
        # position's whole basis against one leg wiped the refund on shares the
        # trader still held when the sold leg was the smaller one, and left the
        # refund untouched when it was the larger.
        cost = int(position.yes_cost if side_yes else position.no_cost)
        # Rounded up, so a sale never retires less basis than it is worth. Rounding
        # down let a trader dribble out a large, cheap side a few shares at a time,
        # retire nothing each round, and keep a VOID refund bigger than what they
        # still had at risk — an over-refund the collateral would have to cover.
        retired = -(-cost * shares // held) if held else 0
        out_reserve, in_reserve = self._reserves(side_yes)
        self._write_reserves(side_yes, out_reserve + to_pool, in_reserve - gross)
        if side_yes:
            position.yes_shares = gl.u256(held - shares)
            position.yes_cost = gl.u256(cost - retired)
        else:
            position.no_shares = gl.u256(held - shares)
            position.no_cost = gl.u256(cost - retired)
        self.refund_liability = gl.u256(max(0, int(self.refund_liability) - retired))
        if side_yes:
            self.total_yes_shares = gl.u256(int(self.total_yes_shares) - shares)
        else:
            self.total_no_shares = gl.u256(int(self.total_no_shares) - shares)
        self.accrued_fees = gl.u256(int(self.accrued_fees) + fee)
        self._pay(sender, amount_out)

    # -------------------------------------------------------------- settlement

    @gl.public.write
    def publish_preliminary(self) -> str:
        """Copy the bound resolver's finalized outcome in and open the window.

        Deliberately parameterless: there is no argument through which a caller
        could propose, hint at or override an outcome. Anyone may call it.
        """
        if self.preliminary_outcome != PENDING:
            raise ValueError("a preliminary outcome is already published")
        now = self._now()
        if now < self._closes_at():
            raise ValueError("market has not reached its observation time")
        result = self._read_resolver(self.resolver)
        self.preliminary_outcome = result["outcome"]
        self.preliminary_at = gl.message_raw["datetime"]
        self.resolver_evidence = result["evidence"]
        # YES, NO and VOID all open the same window. A mistaken VOID is exactly
        # as worth challenging as a mistaken YES.
        self.challenge_closes_at = gl.bigint(now + int(self.challenge_window_seconds))
        return self.preliminary_outcome

    @gl.public.write.payable
    def challenge(self, reason: str) -> None:
        stake = int(gl.message.value)
        if self.preliminary_outcome == PENDING:
            raise ValueError("there is no preliminary outcome to challenge")
        if self.final_outcome != PENDING:
            raise ValueError("market is already final")
        if self.challenger.as_bytes != ZERO:
            raise ValueError("this market already has an active challenge")
        if self._now() >= int(self.challenge_closes_at):
            raise ValueError("the challenge window is closed")
        if stake < int(self.min_challenge_stake):
            raise ValueError("stake is below the minimum challenge stake")
        text = str(reason).strip()
        if not text:
            raise ValueError("a challenge reason is required")
        self.challenger = gl.message.sender_address
        self.challenge_stake = gl.u256(stake)
        self.challenge_reason = text[:MAX_REASON_CHARS]
        # The dispute gets its own window of the same length before the fallback
        # can be applied, so a bound dispute resolver has time to finalize.
        self.challenge_closes_at = gl.bigint(self._now() + int(self.challenge_window_seconds))

    @gl.public.write
    def finalize(self) -> str:
        if self.final_outcome != PENDING:
            raise ValueError("market is already final")
        if self.preliminary_outcome == PENDING:
            raise ValueError("there is no preliminary outcome to finalize")
        expired = self._now() >= int(self.challenge_closes_at)
        if self.challenger.as_bytes == ZERO:
            if not expired:
                raise ValueError("the challenge window is still open")
            # Uncontested: the final outcome is the preliminary one, by construction.
            self._settle(self.preliminary_outcome, refund_stake=False)
            return self.final_outcome

        # There is always an adjudicator to ask — the constructor refuses a market
        # without one — but it may not have been resolved yet.
        try:
            adjudicated = self._read_resolver(self.dispute_resolver)["outcome"]
        except Exception:
            adjudicated = None
        if adjudicated is not None:
            # An adjudicator that upholds the published outcome makes the
            # challenge wrong, and the stake pays the LPs who carried the delay.
            self._settle(adjudicated, refund_stake=adjudicated != self.preliminary_outcome)
            return self.final_outcome
        if not expired:
            raise ValueError("the dispute window is still open")
        # The dispute window closed and the adjudicator still says nothing. That is
        # not evidence for the challenge: `resolve()` on the adjudicator is
        # permissionless, so a challenger with a real objection had the whole window
        # to trigger it and produce an answer. The published outcome — which *did*
        # come from a finalized resolver — stands, and the stake pays the LPs who
        # carried the delay. Voiding here instead, as this contract used to, made
        # the minimum stake a free option to cancel any market: the griefer got
        # their stake back and every winning position was refunded away.
        self._settle(self.preliminary_outcome, refund_stake=False)
        return self.final_outcome

    def _settle(self, outcome: str, refund_stake: bool):
        if outcome not in OUTCOMES:
            raise ValueError("outcome must be YES, NO or VOID")
        self.final_outcome = outcome
        self.final_at = gl.message_raw["datetime"]
        if outcome == VOID:
            owed = int(self.refund_liability)
        elif outcome == YES:
            owed = int(self.total_yes_shares)
        else:
            owed = int(self.total_no_shares)
        collateral = int(self.collateral)
        residual = collateral - owed if collateral > owed else 0
        stake = int(self.challenge_stake)
        if stake:
            # A challenge stake is held outside the trading collateral, so settling
            # it means moving it in first. Every branch below then routes it out
            # again — refunded or paid to the LPs — so it can never be stranded.
            self.challenge_settled = True
            self.collateral = gl.u256(collateral + stake)
            if not refund_stake:
                residual += stake
        self.lp_residual = gl.u256(residual)
        if stake and refund_stake:
            self._pay(self.challenger, stake)

    @gl.public.write
    def claim(self) -> None:
        if self.final_outcome == PENDING:
            raise ValueError("market is not final yet")
        sender = gl.message.sender_address
        position = self.positions.get_or_insert_default(sender)
        if position.claimed:
            raise ValueError("this address has already claimed")
        if self.final_outcome == VOID:
            # Both legs are refunded: a mixed position paid for both of them.
            payout = int(position.yes_cost) + int(position.no_cost)
        elif self.final_outcome == YES:
            payout = int(position.yes_shares)
        else:
            payout = int(position.no_shares)
        if payout <= 0:
            raise ValueError("nothing to claim on this market")
        # Effects first: the position is retired before any GEN is emitted, so a
        # replayed or reordered message cannot pay the same position twice.
        position.claimed = True
        position.yes_shares = gl.u256(0)
        position.no_shares = gl.u256(0)
        position.yes_cost = gl.u256(0)
        position.no_cost = gl.u256(0)
        self._pay(sender, payout)

    @gl.public.write
    def claim_liquidity(self) -> None:
        if self.final_outcome == PENDING:
            raise ValueError("market is not final yet")
        sender = gl.message.sender_address
        position = self.positions.get_or_insert_default(sender)
        shares = int(position.lp_shares)
        if shares <= 0 or position.lp_claimed:
            raise ValueError("there is no claimable LP position")
        amount = int(self.lp_residual) * shares // int(self.lp_total)
        position.lp_claimed = True
        position.lp_shares = gl.u256(0)
        if amount <= 0:
            return
        self._pay(sender, amount)

    # ------------------------------------------------------------------- views

    @gl.public.view
    def market_state(self) -> dict:
        return {
            "marketId": self.market_id,
            "question": self.question,
            "creator": self.creator,
            "resolver": self.resolver,
            "disputeResolver": self.dispute_resolver,
            "resolutionSpecHash": self.resolution_spec_hash,
            "sourcesHash": self.sources_hash,
            "observationTime": self.observation_time,
            "feeBps": self.fee_bps,
            "challengeWindowSeconds": self.challenge_window_seconds,
            "minChallengeStake": self.min_challenge_stake,
            "yesReserve": self.yes_reserve,
            "noReserve": self.no_reserve,
            "collateral": self.collateral,
            "accruedFees": self.accrued_fees,
            "totalYesShares": self.total_yes_shares,
            "totalNoShares": self.total_no_shares,
            "refundLiability": self.refund_liability,
            "lpTotal": self.lp_total,
            "lpResidual": self.lp_residual,
            "preliminaryOutcome": self.preliminary_outcome,
            "preliminaryAt": self.preliminary_at,
            "challengeClosesAt": self.challenge_closes_at,
            "finalOutcome": self.final_outcome,
            "finalAt": self.final_at,
            "evidence": self.resolver_evidence,
            "challenger": self.challenger,
            "challengeStake": self.challenge_stake,
            "challengeReason": self.challenge_reason,
            "challengeSettled": self.challenge_settled,
        }

    @gl.public.view
    def quote_buy(self, side: str, amount: int) -> dict:
        side_yes = self._side(side)
        shares, from_pool, fee, net = self._quote_buy(side_yes, int(amount))
        return {"side": side, "amount": amount, "shares": shares, "fromPool": from_pool, "fee": fee, "net": net}

    @gl.public.view
    def quote_sell(self, side: str, shares: int) -> dict:
        side_yes = self._side(side)
        amount_out, gross, fee, to_pool = self._quote_sell(side_yes, int(shares))
        return {"side": side, "shares": shares, "amountOut": amount_out, "gross": gross, "fee": fee, "toPool": to_pool}

    @gl.public.view
    def position_of(self, address: str) -> dict:
        who = gl.Address(address)
        # Membership is checked rather than defaulted: a view must not write, and
        # `get_or_insert_default` would insert an empty record for every address
        # anyone ever asks about.
        if who not in self.positions:
            return {"address": who, "yesShares": 0, "noShares": 0, "paidCost": 0,
                    "yesCost": 0, "noCost": 0,
                    "lpShares": 0, "claimed": False, "lpClaimed": False}
        position = self.positions[who]
        return {
            "address": who,
            "yesShares": position.yes_shares,
            "noShares": position.no_shares,
            # `paidCost` is the VOID refund this position would be paid today; the
            # per-side figures below are what it is actually made of.
            "paidCost": int(position.yes_cost) + int(position.no_cost),
            "yesCost": position.yes_cost,
            "noCost": position.no_cost,
            "lpShares": position.lp_shares,
            "claimed": position.claimed,
            "lpClaimed": position.lp_claimed,
        }

    def _side(self, side: str) -> bool:
        if side == YES:
            return True
        if side == NO:
            return False
        raise ValueError("side must be YES or NO")
