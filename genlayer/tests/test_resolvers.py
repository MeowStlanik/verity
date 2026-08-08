OBS = "0000"
SPEC = "0x" + "11" * 32
SOURCES = "0x" + "22" * 32


def web(body):
    return {"method": "GET", "status": 200, "body": body}


def numeric(direct_vm, direct_deploy, bodies, threshold=1000, scale=10):
    for host, body in zip(("a.test", "b.test", "c.test"), bodies):
        direct_vm.mock_web(host, web(body))
    return direct_deploy("genlayer/contracts/NumericResolver.py", "0x" + direct_vm.sender.hex(), "market-1", SPEC, SOURCES, OBS,
                         "BTC above 100", "https://a.test", "data.price", "data.time", OBS,
                         "https://b.test", "data.price", "data.time", OBS,
                         "https://c.test", "data.price", "data.time", OBS,
                         "GTE", scale, threshold, 30)


def reprice(direct_vm, price):
    """Point all three sources at a new price, for the validator's own re-read.

    `run_validator` re-runs the leader function against whatever mocks are
    registered at the time, so swapping them here is what makes the validator see
    a different market than the leader did.
    """
    direct_vm.clear_mocks()
    for host in ("a.test", "b.test", "c.test"):
        direct_vm.mock_web(host, web('{"data":{"price":%s,"time":"0000"}}' % price))


def test_numeric_resolves_exact_median_and_exposes_binding(direct_vm, direct_deploy):
    market = numeric(direct_vm, direct_deploy, ['{"data":{"price":101.0,"time":"0000"}}', '{"data":{"price":100.0,"time":"0000"}}', '{"data":{"price":99.0,"time":"0000"}}'])
    assert market.resolve() == "YES"
    assert market.resolution()["valueUnits"] == 1000
    assert market.market_binding() == {"marketId": "market-1", "resolutionSpecHash": SPEC, "sourcesHash": SOURCES, "observationTime": OBS}
    assert direct_vm.run_validator() is True


def test_numeric_is_exact_on_binary_float_boundary(direct_vm, direct_deploy):
    body = '{"data":{"price":0.29,"time":"0000"}}'
    market = numeric(direct_vm, direct_deploy, [body, body, body], threshold=29, scale=100)
    assert market.resolve() == "YES"
    assert market.resolution()["valueUnits"] == 29


def test_numeric_voids_a_snapshot_from_the_wrong_time(direct_vm, direct_deploy):
    wrong = '{"data":{"price":100,"time":"1234"}}'
    market = numeric(direct_vm, direct_deploy, [wrong, wrong, wrong])
    assert market.resolve() == "VOID"
    assert len(market.resolution()["sourceDigests"].split(",")) == 3


def test_numeric_rejects_precision_beyond_locked_scale(direct_vm, direct_deploy):
    precise = '{"data":{"price":0.291,"time":"0000"}}'
    market = numeric(direct_vm, direct_deploy, [precise, precise, precise], threshold=29, scale=100)
    assert market.resolve() == "VOID"


# The threshold in `numeric` is 1000 units at scale 10 with a spread tolerance of
# 30 units, so 99.7 .. 100.3 is "within tolerance" of 100.0 — a band three units
# wide on each side of the strike. Everything below turns on that: two nodes can
# be well inside the tolerance and still disagree about who gets paid.

def test_numeric_validator_rejects_a_leader_across_the_payout_threshold(direct_vm, direct_deploy):
    """The disagreement that matters is about the payout, not about the number.

    The leader reads 100.1 and settles YES. The validator's own read is 99.9 —
    two units away, comfortably inside a 30-unit tolerance, and on the other side
    of the strike, so it settles NO. Accepting on distance alone let a leader
    choose the winning side of any market trading near its threshold.
    """
    market = numeric(direct_vm, direct_deploy, ['{"data":{"price":100.1,"time":"0000"}}'] * 3)
    assert market.resolve() == "YES"
    assert market.resolution()["valueUnits"] == 1001
    reprice(direct_vm, "99.9")
    assert direct_vm.run_validator() is False


def test_numeric_validator_accepts_a_leader_on_its_own_side_of_the_threshold(direct_vm, direct_deploy):
    """The same two units of drift, on the same side of the strike, is agreement.

    Sources are allowed to differ — that is what the tolerance is for. The check
    added above must not turn every ordinary spread into a failed round.
    """
    market = numeric(direct_vm, direct_deploy, ['{"data":{"price":100.1,"time":"0000"}}'] * 3)
    assert market.resolve() == "YES"
    reprice(direct_vm, "100.3")
    assert direct_vm.run_validator() is True


def test_numeric_validator_still_rejects_a_leader_outside_the_spread_tolerance(direct_vm, direct_deploy):
    """Agreeing on the outcome does not excuse an implausible number.

    Both reads settle YES here, but they are 40 units apart against a 30-unit
    tolerance: the outcome check is an extra condition, not a replacement for the
    spread check.
    """
    market = numeric(direct_vm, direct_deploy, ['{"data":{"price":100.1,"time":"0000"}}'] * 3)
    assert market.resolve() == "YES"
    reprice(direct_vm, "104.1")
    assert direct_vm.run_validator() is False


def test_numeric_validator_agrees_when_both_nodes_find_the_sources_unusable(direct_vm, direct_deploy):
    """An unusable source set is a decision both nodes can reach independently."""
    wrong = '{"data":{"price":100,"time":"1234"}}'
    market = numeric(direct_vm, direct_deploy, [wrong] * 3)
    assert market.resolve() == "VOID"
    assert direct_vm.run_validator() is True


def test_structured_fact_requires_two_matching_sources(direct_vm, direct_deploy):
    for source in ("a.test", "b.test", "c.test"):
        direct_vm.mock_web(source, web("official report"))
    direct_vm.mock_llm(".*", '{"outcome":"YES","reason":"official result"}')
    market = direct_deploy("genlayer/contracts/StructuredFactResolver.py", "0x" + direct_vm.sender.hex(), "market-2", SPEC, SOURCES, OBS, "Did it happen?", "Only official release counts", "https://a.test", "https://b.test", "https://c.test")
    assert market.resolve() == "YES"
    assert market.market_binding()["marketId"] == "market-2"
    assert direct_vm.run_validator() is True


def test_judgment_uses_void_for_ambiguity(direct_vm, direct_deploy):
    for source in ("a.test", "b.test", "c.test"):
        direct_vm.mock_web(source, web("ambiguous statement"))
    direct_vm.mock_llm(".*", '{"outcome":"VOID","reason":"ambiguous"}')
    market = direct_deploy("genlayer/contracts/JudgmentResolver.py", "0x" + direct_vm.sender.hex(), "market-3", SPEC, SOURCES, OBS, "Was feature announced?", "Must be explicit", "https://a.test", "https://b.test", "https://c.test")
    assert market.resolve() == "VOID"
    assert direct_vm.run_validator() is True
