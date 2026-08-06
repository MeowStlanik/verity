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
