"""PredictionMarket: GEN custody, CPMM fills and settlement.

The market reads its outcome from another contract, so these tests install a
`gl_call` hook that answers `CallContract` with a scripted resolver and records
every `PostMessage`. That is the same wire format GenVM uses, so the contract
under test is exercised through its real cross-contract path rather than through
a Python stub swapped in behind its back.
"""
import sys

import pytest

GEN = 10 ** 18
ZERO = "0x" + "00" * 20
RESOLVER = "0x" + "ab" * 20
DISPUTE = "0x" + "cd" * 20
SPEC = "0x" + "11" * 32
SOURCES = "0x" + "22" * 32
OPEN = "2026-08-01T00:00:00Z"
CLOSE = "2026-09-01T00:00:00Z"
AFTER_CLOSE = "2026-09-01T00:05:00Z"
WINDOW = 600


def warp(vm, when):
    """Move block time forward.

    `VMContext.warp` only rewrites `datetime.now()`; it leaves the injected
    `gl.message_raw["datetime"]` at its deployment value. The contract reads the
    message clock, as production code must, so the test harness advances both.
    """
    vm.warp(when)
    module = sys.modules.get("genlayer.gl")
    if module is not None and getattr(module, "message_raw", None) is not None:
        module.message_raw["datetime"] = when


class Chain:
    """Scripted resolvers plus a transfer log, wired into the VM's gl_call hook."""

    def __init__(self, vm):
        self.vm = vm
        self.resolvers = {}
        self.transfers = []
        vm._gl_call_hook = self._handle

    def set_resolver(self, address, outcome, resolved_at=AFTER_CLOSE, market_id="m1",
                     spec=SPEC, sources=SOURCES, observation=CLOSE, evidence="scripted"):
        self.resolvers[address.lower()] = {
            "market_binding": {"marketId": market_id, "resolutionSpecHash": spec,
                               "sourcesHash": sources, "observationTime": observation},
            "resolution": {"outcome": outcome, "resolvedAt": resolved_at if outcome != "PENDING" else "",
                           "evidence": evidence, "sourceDigests": ""},
        }

    def paid(self, address):
        return sum(entry["value"] for entry in self.transfers if entry["to"] == address.lower())

    def _handle(self, vm, request):
        from genlayer.py import calldata

        if "CallContract" in request:
            call = request["CallContract"]
            state = self.resolvers.get("0x" + call["address"].as_bytes.hex())
            if state is None:
                return bytes([1]) + b"no contract at that address"
            answer = state.get(call["calldata"]["method"])
            if answer is None:
                return bytes([1]) + b"unknown method"
            return bytes([0]) + calldata.encode(answer)
        if "PostMessage" in request:
            message = request["PostMessage"]
            self.transfers.append({"to": "0x" + message["address"].as_bytes.hex(), "value": int(message["value"])})
            return {"ok": None}
        return None


@pytest.fixture
def chain(direct_vm):
    warp(direct_vm, OPEN)
    return Chain(direct_vm)


def deploy(direct_deploy, dispute=ZERO, fee_bps=200, window=WINDOW, min_stake=GEN // 10):
    return direct_deploy("genlayer/contracts/PredictionMarket.py", "m1", "Will it happen?",
                         RESOLVER, dispute, SPEC, SOURCES, CLOSE, fee_bps, window, min_stake)


def funded(direct_vm, direct_deploy, liquidity=100 * GEN, **kwargs):
    market = deploy(direct_deploy, **kwargs)
    direct_vm.value = liquidity
    market.add_liquidity()
    direct_vm.value = 0
    return market


def buy(direct_vm, market, side, amount, min_shares_out=0, deadline=0):
    direct_vm.value = amount
    try:
        (market.buy_yes if side == "YES" else market.buy_no)(min_shares_out, deadline)
    finally:
        direct_vm.value = 0


def address_of(account):
    return "0x" + account.hex()


def settle(direct_vm, chain, market, outcome, at=AFTER_CLOSE):
    chain.set_resolver(RESOLVER, outcome)
    warp(direct_vm, at)
    market.publish_preliminary()
    warp(direct_vm, "2026-09-01T01:00:00Z")
    return market.finalize()


# --------------------------------------------------------------------- trading

def test_payable_liquidity_seeds_a_balanced_book(direct_vm, direct_deploy, chain):
    market = deploy(direct_deploy)
    direct_vm.value = 100 * GEN
    market.add_liquidity()
    direct_vm.value = 0
    state = market.market_state()
    assert state["collateral"] == 100 * GEN
    assert state["yesReserve"] == state["noReserve"] == 100 * GEN
    assert market.position_of(address_of(direct_vm.sender))["lpShares"] == 100 * GEN
    # The seeding invariant: no reserve may exceed the collateral backing it.
    assert max(state["yesReserve"], state["noReserve"]) <= state["collateral"]


def test_liquidity_without_value_is_rejected(direct_vm, direct_deploy, chain):
    market = deploy(direct_deploy)
    with direct_vm.expect_revert("send GEN"):
        market.add_liquidity()


def test_buy_yes_credits_shares_and_moves_the_price_up(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    quote = market.quote_buy("YES", 10 * GEN)
    buy(direct_vm, market, "YES", 10 * GEN)
    state = market.market_state()
    assert state["totalYesShares"] == quote["shares"]
    assert market.position_of(address_of(direct_vm.sender))["yesShares"] == quote["shares"]
    # price(YES) = no / (yes + no)
    assert state["noReserve"] * 2 > state["yesReserve"] + state["noReserve"]
    # A binary share can never cost more than one GEN.
    assert quote["shares"] > 10 * GEN


def test_buy_no_moves_the_price_the_other_way(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    buy(direct_vm, market, "NO", 10 * GEN)
    state = market.market_state()
    assert state["totalNoShares"] > 0
    assert state["yesReserve"] > state["noReserve"]


def test_quote_matches_the_fill_exactly(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    quote = market.quote_buy("NO", 7 * GEN)
    buy(direct_vm, market, "NO", 7 * GEN)
    assert market.position_of(address_of(direct_vm.sender))["noShares"] == quote["shares"]
    assert market.market_state()["accruedFees"] == quote["fee"]


def test_a_fill_worse_than_the_agreed_quote_is_rejected(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    quote = market.quote_buy("YES", 10 * GEN)
    buy(direct_vm, market, "YES", 20 * GEN)
    with direct_vm.expect_revert("price moved"):
        buy(direct_vm, market, "YES", 10 * GEN, min_shares_out=quote["shares"])


def test_an_expired_deadline_is_refused(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    with direct_vm.expect_revert("deadline"):
        buy(direct_vm, market, "YES", GEN, deadline=1)


def test_sell_returns_gen_and_retires_the_position(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    buy(direct_vm, market, "YES", 10 * GEN)
    held = market.position_of(address_of(direct_vm.sender))["yesShares"]
    quote = market.quote_sell("YES", held // 2)
    market.sell_yes(held // 2, quote["amountOut"], 0)
    position = market.position_of(address_of(direct_vm.sender))
    assert position["yesShares"] == held - held // 2
    assert chain.paid(address_of(direct_vm.sender)) == quote["amountOut"]
    # Selling half the shares gives back half the refundable cost, so a later VOID
    # cannot refund a position that has already been cashed out.
    assert position["paidCost"] == 10 * GEN - (10 * GEN * (held // 2) // held)


def test_selling_more_than_held_is_rejected(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    buy(direct_vm, market, "YES", GEN)
    held = market.position_of(address_of(direct_vm.sender))["yesShares"]
    with direct_vm.expect_revert("not enough shares"):
        market.sell_yes(held + 1, 0, 0)


def test_trading_stops_at_the_observation_time(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    warp(direct_vm, AFTER_CLOSE)
    with direct_vm.expect_revert("trading closed"):
        buy(direct_vm, market, "YES", GEN)
    with direct_vm.expect_revert("trading closed"):
        market.sell_yes(1, 0, 0)


# ------------------------------------------------------------------ resolution

def test_preliminary_copies_the_bound_resolver_outcome(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "YES")
    warp(direct_vm, AFTER_CLOSE)
    assert market.publish_preliminary() == "YES"
    state = market.market_state()
    assert state["preliminaryOutcome"] == "YES"
    assert state["finalOutcome"] == "PENDING"
    assert state["challengeClosesAt"] > 0


@pytest.mark.parametrize("outcome", ["YES", "NO", "VOID"])
def test_every_outcome_including_void_opens_a_challenge_window(direct_vm, direct_deploy, chain, outcome):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, outcome)
    warp(direct_vm, AFTER_CLOSE)
    assert market.publish_preliminary() == outcome
    # A mistaken VOID is exactly as worth challenging as a mistaken YES, so it
    # must not settle on the spot.
    assert market.market_state()["finalOutcome"] == "PENDING"
    with direct_vm.expect_revert("challenge window is still open"):
        market.finalize()


def test_a_resolver_bound_to_another_market_is_refused(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "YES", market_id="some-other-market")
    warp(direct_vm, AFTER_CLOSE)
    with direct_vm.expect_revert("not bound to this market"):
        market.publish_preliminary()


def test_a_resolver_with_a_different_spec_hash_is_refused(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "YES", spec="0x" + "99" * 32)
    warp(direct_vm, AFTER_CLOSE)
    with direct_vm.expect_revert("not bound to this market"):
        market.publish_preliminary()


def test_an_unresolved_resolver_cannot_settle_the_market(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "PENDING")
    warp(direct_vm, AFTER_CLOSE)
    with direct_vm.expect_revert("has not produced an outcome"):
        market.publish_preliminary()


def test_a_result_dated_before_the_observation_time_is_refused(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "YES", resolved_at="2026-08-30T00:00:00Z")
    warp(direct_vm, AFTER_CLOSE)
    with direct_vm.expect_revert("before the locked observation time"):
        market.publish_preliminary()


def test_publishing_before_the_observation_time_is_refused(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "YES")
    with direct_vm.expect_revert("has not reached its observation time"):
        market.publish_preliminary()


def test_a_published_outcome_cannot_be_replaced(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "YES")
    warp(direct_vm, AFTER_CLOSE)
    market.publish_preliminary()
    # Even a resolver that now reports NO cannot overwrite a published result.
    chain.set_resolver(RESOLVER, "NO")
    with direct_vm.expect_revert("already published"):
        market.publish_preliminary()
    assert market.market_state()["preliminaryOutcome"] == "YES"


def test_uncontested_finalization_keeps_the_published_outcome(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "NO")
    warp(direct_vm, AFTER_CLOSE)
    market.publish_preliminary()
    chain.set_resolver(RESOLVER, "YES")  # a later flip must not reach the market
    warp(direct_vm, "2026-09-01T01:00:00Z")
    assert market.finalize() == "NO"
    assert market.market_state()["finalOutcome"] == "NO"


# ------------------------------------------------------------------ challenges

def test_a_stake_below_the_minimum_is_rejected(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "YES")
    warp(direct_vm, AFTER_CLOSE)
    market.publish_preliminary()
    direct_vm.value = GEN // 100
    with direct_vm.expect_revert("below the minimum"):
        market.challenge("the second source disagreed")
    direct_vm.value = 0


def test_a_challenge_after_the_window_is_rejected(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "YES")
    warp(direct_vm, AFTER_CLOSE)
    market.publish_preliminary()
    warp(direct_vm, "2026-09-01T01:00:00Z")
    direct_vm.value = GEN
    with direct_vm.expect_revert("challenge window is closed"):
        market.challenge("too late")
    direct_vm.value = 0


def test_a_challenge_blocks_the_uncontested_path(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "YES")
    warp(direct_vm, AFTER_CLOSE)
    market.publish_preliminary()
    direct_vm.value = GEN
    market.challenge("the locked source was unreachable")
    direct_vm.value = 0
    state = market.market_state()
    assert state["challengeStake"] == GEN
    assert state["challengeReason"] == "the locked source was unreachable"
    with direct_vm.expect_revert("dispute window is still open"):
        market.finalize()


def test_a_committed_dispute_resolver_can_overturn_the_outcome(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy, dispute=DISPUTE)
    chain.set_resolver(RESOLVER, "YES")
    chain.set_resolver(DISPUTE, "NO")
    warp(direct_vm, AFTER_CLOSE)
    market.publish_preliminary()
    direct_vm.value = GEN
    market.challenge("the leader read a stale snapshot")
    direct_vm.value = 0
    assert market.finalize() == "NO"
    state = market.market_state()
    assert state["challengeSettled"] is True
    # An upheld challenge gets its stake back.
    assert chain.paid(address_of(direct_vm.sender)) == GEN


def test_an_upheld_outcome_forfeits_the_stake_to_the_pool(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy, dispute=DISPUTE)
    chain.set_resolver(RESOLVER, "YES")
    chain.set_resolver(DISPUTE, "YES")
    warp(direct_vm, AFTER_CLOSE)
    market.publish_preliminary()
    direct_vm.value = GEN
    market.challenge("I disagree")
    direct_vm.value = 0
    assert market.finalize() == "YES"
    state = market.market_state()
    assert state["challengeSettled"] is True
    assert chain.paid(address_of(direct_vm.sender)) == 0
    # The forfeited stake is now LP revenue rather than a stranded balance.
    assert state["lpResidual"] == state["collateral"]
    assert state["lpResidual"] >= 100 * GEN + GEN


def test_without_an_adjudicator_a_dispute_voids_and_refunds_the_stake(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    chain.set_resolver(RESOLVER, "YES")
    warp(direct_vm, AFTER_CLOSE)
    market.publish_preliminary()
    direct_vm.value = 2 * GEN
    market.challenge("the resolver used the wrong candle")
    direct_vm.value = 0
    warp(direct_vm, "2026-09-01T02:00:00Z")
    # Nothing on chain says the challenge was wrong, so the contract refuses to
    # guess: everyone is made whole, the challenger included.
    assert market.finalize() == "VOID"
    assert market.market_state()["challengeSettled"] is True
    assert chain.paid(address_of(direct_vm.sender)) == 2 * GEN


def test_a_silent_dispute_resolver_falls_back_to_void(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy, dispute=DISPUTE)
    chain.set_resolver(RESOLVER, "NO")
    chain.set_resolver(DISPUTE, "PENDING")
    warp(direct_vm, AFTER_CLOSE)
    market.publish_preliminary()
    direct_vm.value = GEN
    market.challenge("please re-read the sources")
    direct_vm.value = 0
    warp(direct_vm, "2026-09-01T02:00:00Z")
    assert market.finalize() == "VOID"
    assert chain.paid(address_of(direct_vm.sender)) == GEN


# --------------------------------------------------------------------- payouts

def test_a_winning_claim_pays_one_gen_per_share_once(direct_vm, direct_deploy, chain, direct_alice):
    market = funded(direct_vm, direct_deploy)
    with direct_vm.prank(direct_alice):
        buy(direct_vm, market, "YES", 10 * GEN)
        shares = market.position_of(address_of(direct_alice))["yesShares"]
    settle(direct_vm, chain, market, "YES")
    with direct_vm.prank(direct_alice):
        market.claim()
        assert chain.paid(address_of(direct_alice)) == shares
        with direct_vm.expect_revert("already claimed"):
            market.claim()


def test_a_losing_position_pays_nothing(direct_vm, direct_deploy, chain, direct_alice):
    market = funded(direct_vm, direct_deploy)
    with direct_vm.prank(direct_alice):
        buy(direct_vm, market, "YES", 10 * GEN)
    settle(direct_vm, chain, market, "NO")
    with direct_vm.prank(direct_alice):
        with direct_vm.expect_revert("nothing to claim"):
            market.claim()
    assert chain.paid(address_of(direct_alice)) == 0


def test_void_refunds_exactly_what_the_trader_paid(direct_vm, direct_deploy, chain, direct_alice, direct_bob):
    market = funded(direct_vm, direct_deploy)
    with direct_vm.prank(direct_alice):
        buy(direct_vm, market, "YES", 10 * GEN)
    with direct_vm.prank(direct_bob):
        buy(direct_vm, market, "NO", 4 * GEN)
    settle(direct_vm, chain, market, "VOID")
    with direct_vm.prank(direct_alice):
        market.claim()
    with direct_vm.prank(direct_bob):
        market.claim()
    assert chain.paid(address_of(direct_alice)) == 10 * GEN
    assert chain.paid(address_of(direct_bob)) == 4 * GEN


def test_lp_residual_cannot_take_the_winners_payout(direct_vm, direct_deploy, chain, direct_alice):
    market = funded(direct_vm, direct_deploy)
    with direct_vm.prank(direct_alice):
        buy(direct_vm, market, "YES", 25 * GEN)
        owed = market.position_of(address_of(direct_alice))["yesShares"]
    settle(direct_vm, chain, market, "YES")
    state = market.market_state()
    assert state["lpResidual"] == state["collateral"] - owed
    # The LP withdraws first, on purpose: the winner must still be paid in full.
    market.claim_liquidity()
    with direct_vm.prank(direct_alice):
        market.claim()
    assert chain.paid(address_of(direct_alice)) == owed
    assert market.market_state()["collateral"] == 0


def test_lp_residual_cannot_take_a_void_refund(direct_vm, direct_deploy, chain, direct_alice):
    market = funded(direct_vm, direct_deploy)
    with direct_vm.prank(direct_alice):
        buy(direct_vm, market, "YES", 25 * GEN)
    settle(direct_vm, chain, market, "VOID")
    assert market.market_state()["lpResidual"] == 100 * GEN
    market.claim_liquidity()
    with direct_vm.prank(direct_alice):
        market.claim()
    assert chain.paid(address_of(direct_alice)) == 25 * GEN
    assert market.market_state()["collateral"] == 0


def test_liquidity_can_only_be_claimed_once_and_only_after_settlement(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    with direct_vm.expect_revert("not final yet"):
        market.claim_liquidity()
    settle(direct_vm, chain, market, "NO")
    market.claim_liquidity()
    assert chain.paid(address_of(direct_vm.sender)) == 100 * GEN
    with direct_vm.expect_revert("no claimable LP position"):
        market.claim_liquidity()


def test_claiming_before_settlement_is_refused(direct_vm, direct_deploy, chain):
    market = funded(direct_vm, direct_deploy)
    buy(direct_vm, market, "YES", GEN)
    with direct_vm.expect_revert("not final yet"):
        market.claim()


def test_two_lps_split_the_residual_in_proportion(direct_vm, direct_deploy, chain, direct_alice, direct_bob):
    market = deploy(direct_deploy)
    with direct_vm.prank(direct_alice):
        direct_vm.value = 30 * GEN
        market.add_liquidity()
    with direct_vm.prank(direct_bob):
        direct_vm.value = 10 * GEN
        market.add_liquidity()
    direct_vm.value = 0
    settle(direct_vm, chain, market, "YES")
    with direct_vm.prank(direct_alice):
        market.claim_liquidity()
    with direct_vm.prank(direct_bob):
        market.claim_liquidity()
    assert chain.paid(address_of(direct_alice)) == 30 * GEN
    assert chain.paid(address_of(direct_bob)) == 10 * GEN


def test_the_contract_exposes_a_deployable_abi(direct_vm, direct_deploy, chain):
    """A contract whose schema cannot be generated cannot be deployed at all.

    This also pins the payable surface: exactly the four methods that are meant to
    receive GEN may receive it, and nothing else can be sent value by accident.
    """
    import json

    deploy(direct_deploy)
    schema = json.loads(sys.modules["_contract_PredictionMarket"].PredictionMarket.__get_schema__())
    methods = schema["methods"]
    assert {name for name, entry in methods.items() if entry.get("payable")} == {"add_liquidity", "buy_yes", "buy_no", "challenge"}
    assert {name for name, entry in methods.items() if entry.get("readonly")} == {"market_state", "quote_buy", "quote_sell", "position_of"}
    # No argument through which a caller could propose an outcome.
    assert methods["publish_preliminary"]["params"] == []
    assert methods["finalize"]["params"] == []


def test_a_late_lp_is_credited_on_equity_not_on_trader_money(direct_vm, direct_deploy, chain, direct_alice, direct_bob):
    """Depositing after trades must not buy a claim on the traders' collateral.

    Minting against gross collateral would hand the late LP a share of money that
    is already owed to a trader, and quietly transfer value to whoever was in the
    pool first. Both LPs should get back what they put in, plus their share of the
    fees and of the trading loss — not a redistribution between them.
    """
    market = funded(direct_vm, direct_deploy, liquidity=100 * GEN)
    with direct_vm.prank(direct_bob):
        buy(direct_vm, market, "YES", 10 * GEN)
    with direct_vm.prank(direct_alice):
        direct_vm.value = 110 * GEN
        market.add_liquidity()
        direct_vm.value = 0
    settle(direct_vm, chain, market, "YES")
    market.claim_liquidity()
    with direct_vm.prank(direct_alice):
        market.claim_liquidity()
    late = chain.paid(address_of(direct_alice))
    # Within a hair of the 110 GEN deposited; the early LP keeps the fee and the
    # trader's expected loss, and the late LP neither funds nor receives them.
    assert abs(late - 110 * GEN) < GEN // 100, f"late LP got {late / GEN} GEN for a 110 GEN deposit"
