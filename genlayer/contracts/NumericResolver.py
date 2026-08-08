# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Level 1: fixed JSON sources -> exact-integer median -> deterministic YES/NO/VOID.

No floating point is used anywhere on the value path. Source numbers are read as
their literal JSON text and converted to scaled integer units with integer math,
so a market whose threshold sits exactly on a source value resolves the same way
on every validator.
"""
import json
import genlayer.gl as gl

COMPARATORS = ("GT", "GTE", "LT", "LTE")
MAX_BODY_BYTES = 262144


class NumericResolver(gl.Contract):
    authority: gl.Address
    market_id: str
    resolution_spec_hash: str
    sources_hash: str
    observation_time: str
    question: str
    source_a: str
    path_a: str
    source_b: str
    path_b: str
    source_c: str
    path_c: str
    timestamp_path_a: str
    timestamp_path_b: str
    timestamp_path_c: str
    timestamp_value_a: str
    timestamp_value_b: str
    timestamp_value_c: str
    comparator: str
    scale: gl.bigint
    threshold_units: gl.bigint
    max_source_spread_units: gl.bigint
    outcome: str
    median_value_units: gl.bigint
    resolved_at: str
    source_digests: str
    evidence: str

    def __init__(self, authority: str, market_id: str, resolution_spec_hash: str, sources_hash: str, observation_time: str,
                 question: str, source_a: str, path_a: str, timestamp_path_a: str, timestamp_value_a: str,
                 source_b: str, path_b: str, timestamp_path_b: str, timestamp_value_b: str,
                 source_c: str, path_c: str, timestamp_path_c: str, timestamp_value_c: str,
                 comparator: str, scale: int, threshold_units: int, max_source_spread_units: int):
        if comparator not in COMPARATORS:
            raise ValueError("invalid comparator")
        if scale <= 0:
            raise ValueError("scale must be positive")
        if max_source_spread_units < 0:
            raise ValueError("spread tolerance must not be negative")
        # Address() rejects anything that is not a well-formed 20-byte address, so a
        # typo cannot silently deploy a resolver that nobody is able to resolve.
        self.authority = gl.Address(authority)
        self.market_id = market_id
        self.resolution_spec_hash = resolution_spec_hash
        self.sources_hash = sources_hash
        self.observation_time = observation_time
        self.question = question
        self.source_a = source_a
        self.path_a = path_a
        self.source_b = source_b
        self.path_b = path_b
        self.source_c = source_c
        self.path_c = path_c
        self.timestamp_path_a = timestamp_path_a
        self.timestamp_path_b = timestamp_path_b
        self.timestamp_path_c = timestamp_path_c
        self.timestamp_value_a = timestamp_value_a
        self.timestamp_value_b = timestamp_value_b
        self.timestamp_value_c = timestamp_value_c
        self.comparator = comparator
        self.scale = gl.bigint(scale)
        self.threshold_units = gl.bigint(threshold_units)
        self.max_source_spread_units = gl.bigint(max_source_spread_units)
        self.outcome = "PENDING"
        self.median_value_units = gl.bigint(0)
        self.resolved_at = ""
        self.source_digests = ""
        self.evidence = ""

    @gl.public.write
    def resolve(self):
        # Permissionless keeper call: the caller cannot choose or influence the
        # outcome, because all inputs and rules are locked in contract storage.
        if self.outcome != "PENDING":
            raise ValueError("already resolved")
        if gl.message_raw["datetime"] < self.observation_time:
            raise ValueError("observation time not reached")

        # Nondeterministic callbacks are pickled and shipped to a sub-VM. Capture only
        # primitive immutable spec values, never the storage-backed `self`.
        sources = [(self.source_a, self.path_a, self.timestamp_path_a, self.timestamp_value_a),
                   (self.source_b, self.path_b, self.timestamp_path_b, self.timestamp_value_b),
                   (self.source_c, self.path_c, self.timestamp_path_c, self.timestamp_value_c)]
        scale = int(self.scale)
        tolerance = int(self.max_source_spread_units)
        comparator = self.comparator
        threshold = int(self.threshold_units)

        def decide(units: int) -> str:
            """The payout this many units implies. Locked constructor state only."""
            if comparator == "GT":
                return "YES" if units > threshold else "NO"
            if comparator == "GTE":
                return "YES" if units >= threshold else "NO"
            if comparator == "LT":
                return "YES" if units < threshold else "NO"
            return "YES" if units <= threshold else "NO"

        def to_units(text: str) -> int:
            """Exact conversion of a decimal literal to scaled integer units."""
            text = text.strip()
            if not text:
                raise ValueError("empty number")
            exponent = 0
            for marker in ("e", "E"):
                if marker in text:
                    text, _, exponent_text = text.partition(marker)
                    exponent = int(exponent_text)
                    break
            sign = 1
            if text[:1] in ("+", "-"):
                sign = -1 if text[0] == "-" else 1
                text = text[1:]
            whole, _, fraction = text.partition(".")
            whole = whole or "0"
            if not whole.isdigit() or (fraction and not fraction.isdigit()):
                raise ValueError("not a decimal number")
            # value == sign * digits / 10 ** (len(fraction) - exponent)
            digits = int(whole + fraction)
            decimals = len(fraction) - exponent
            numerator = sign * digits * scale
            if decimals > 0:
                denominator = 10 ** decimals
                if numerator % denominator != 0:
                    raise ValueError("source has more precision than the locked scale")
                return numerator // denominator
            return numerator * (10 ** -decimals)

        def at_path(value, path: str):
            for key in path.split("."):
                value = value[int(key)] if key.isdigit() else value[key]
            return value

        def read_source(url: str, json_path: str, timestamp_path: str, timestamp_value: str):
            response = gl.nondet.web.get(url)
            if response.status != 200 or response.body is None:
                raise ValueError("source unavailable")
            body = bytes(response.body)[:MAX_BODY_BYTES]
            digest = gl.Keccak256(body).digest().hex()
            # parse_float/parse_int keep the literal source text, so no value on the
            # settlement path is ever routed through a binary float.
            value = json.loads(body.decode("utf-8", errors="replace"), parse_float=str, parse_int=str)
            timestamp = at_path(value, timestamp_path)
            if str(timestamp) != timestamp_value:
                raise ValueError("source snapshot is for the wrong observation time")
            value = at_path(value, json_path)
            if isinstance(value, bool) or not isinstance(value, (str, int)):
                raise ValueError("source value is not numeric")
            return to_units(str(value)), digest

        def observe() -> dict:
            """Never raises: an unusable source set is a first-class `not ok` answer.

            Returning it as data rather than as an exception lets the validator agree
            that the market is unresolvable, instead of the leader erroring out and the
            two nodes disagreeing over which error each of them happened to hit.
            """
            values = []
            digests = []
            for url, json_path, timestamp_path, timestamp_value in sources:
                try:
                    units, digest = read_source(url, json_path, timestamp_path, timestamp_value)
                except Exception:
                    digests.append(gl.Keccak256(("UNAVAILABLE:" + url).encode()).digest().hex())
                    while len(digests) < 3:
                        missing_url = sources[len(digests)][0]
                        digests.append(gl.Keccak256(("UNAVAILABLE:" + missing_url).encode()).digest().hex())
                    return {"ok": False, "units": 0, "digests": digests}
                values.append(units)
                digests.append(digest)
            values.sort()
            if values[2] - values[0] > tolerance:
                return {"ok": False, "units": 0, "digests": digests}
            return {"ok": True, "units": values[1], "digests": digests}

        def leader() -> dict:
            return observe()

        def validator(leader_result) -> bool:
            proposed = gl.vm.unpack_result(leader_result)
            local = observe()
            if not proposed["ok"] or not local["ok"]:
                # Agree only when both nodes independently find the sources unusable.
                return proposed["ok"] == local["ok"]
            # Source digests are the leader's snapshot and are expected to differ
            # between nodes; only the number the market settles on has to agree.
            if abs(int(local["units"]) - int(proposed["units"])) > tolerance:
                return False
            # Agreeing "within tolerance" is not the same as agreeing on the
            # outcome. The tolerance is a spread between exchanges, and it is much
            # wider than the distance to the threshold whenever a market is close
            # to its strike — so a leader whose median sits just the other side of
            # the threshold would otherwise be accepted, and would pay the losing
            # side. Two numbers that disagree about who gets paid are a
            # disagreement, however close together they are.
            return decide(int(local["units"])) == decide(int(proposed["units"]))

        observation = gl.vm.run_nondet(leader, validator)
        self.resolved_at = gl.message_raw["datetime"]
        self.source_digests = ",".join(observation["digests"])

        if not observation["ok"]:
            self.outcome = "VOID"
            self.evidence = "the three fixed sources did not produce a median within the locked tolerance"
            return self.outcome

        value = int(observation["units"])
        self.median_value_units = gl.bigint(value)
        # The same `decide` the validator agreed on, so the stored outcome cannot
        # drift from the rule consensus was reached under.
        self.outcome = decide(value)
        self.evidence = "median=" + str(value) + " " + comparator + " threshold=" + str(threshold)
        return self.outcome

    @gl.public.view
    def resolution(self) -> dict:
        return {
            "outcome": self.outcome,
            "valueUnits": self.median_value_units,
            "scale": self.scale,
            "resolvedAt": self.resolved_at,
            "sourceDigests": self.source_digests,
            "evidence": self.evidence,
        }

    @gl.public.view
    def market_binding(self) -> dict:
        return {"marketId": self.market_id, "resolutionSpecHash": self.resolution_spec_hash,
                "sourcesHash": self.sources_hash, "observationTime": self.observation_time}

    @gl.public.view
    def resolver_config(self) -> dict:
        return {"contract": "NumericResolver", "question": self.question,
                "sources": [self.source_a, self.source_b, self.source_c], "jsonPaths": [self.path_a, self.path_b, self.path_c],
                "timestampPaths": [self.timestamp_path_a, self.timestamp_path_b, self.timestamp_path_c],
                "timestampValues": [self.timestamp_value_a, self.timestamp_value_b, self.timestamp_value_c],
                "comparator": self.comparator, "scale": self.scale, "thresholdUnits": self.threshold_units,
                "maxSourceSpreadUnits": self.max_source_spread_units}
