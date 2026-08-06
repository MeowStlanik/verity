# GenLayer contracts

Two kinds of Intelligent Contract are deployed per market: a **resolver**, which
decides the outcome, and a **`PredictionMarket`**, which holds the GEN and pays it out.

## `PredictionMarket.py` — the market itself

This is the source of truth for a market: it custodies native GEN, prices YES/NO
with an integer complete-set CPMM, and takes its outcome from the resolver locked
into it at deployment. It is not upgradeable and has no admin method — there is no
call through which the creator, a keeper or a challenger can choose an outcome.

| Method | |
| --- | --- |
| `add_liquidity()` | payable; mints LP shares |
| `buy_yes / buy_no(min_shares_out, deadline)` | payable; slippage floor and deadline enforced |
| `sell_yes / sell_no(shares, min_amount_out, deadline)` | exact integer inverse of the buy curve |
| `publish_preliminary()` | parameterless; copies the resolver's finalized outcome in |
| `challenge(reason)` | payable; stake must reach `min_challenge_stake` |
| `finalize()` | uncontested → preliminary; disputed → dispute resolver or VOID fallback |
| `claim()` / `claim_liquidity()` | one-shot payout and LP residual |
| `market_state()`, `quote_buy()`, `quote_sell()`, `position_of()` | views |

Properties worth knowing:

- **Wei only, no floating point.** Prices, fills, refunds and the sell curve
  (a quadratic solved with an integer Newton square root) are exact integers, so
  the quote the UI shows is the fill the contract executes, not an approximation.
- **Reserves are seeded so `max(yes_reserve, no_reserve) <= collateral`.** A
  complete-set CPMM can hand out at most the buyer's stake plus one reserve, so
  this is exactly the solvency condition. Every buy re-checks the projected book
  against its backing *before* writing any field.
- **Outcome cannot be supplied.** `publish_preliminary()` takes no arguments. It
  reads `market_binding()` and `resolution()` from the bound resolver at
  `LATEST_FINAL` and rejects any mismatch in market ID, spec hash, sources hash,
  observation time, or a result dated before the observation time.
- **YES, NO and VOID all open the same challenge window,** and a published
  preliminary outcome can never be replaced — not even by a resolver that later
  reports something else.
- **The challenge stake is never stranded.** Upheld challenge → refunded;
  rejected by a committed dispute resolver → paid to the LPs; no adjudicator
  available → the market voids and the stake is refunded.
- **Effects precede transfers.** GenLayer messages are asynchronous, so positions
  are retired and `collateral` is decremented before `emit_transfer` is called,
  and accounting never reads `self.balance`, which lags emitted transfers.

### Sources have a shelf life, and the spec has to respect it

A numeric market's sources are immutable once locked, so each one has to still
serve the *observation minute* at the time the market is resolved — not merely
return a number. Kraken's `OHLC?since=`, for instance, answers correctly for a
minute inside its rolling ~12-hour window and returns the recent window instead
once that minute has aged out; Coinbase and Binance still serve the same minute a
day later.

The resolver catches this rather than papering over it: every numeric source
carries a locked timestamp path and value, and a snapshot whose timestamp does not
match is refused, which settles the market VOID instead of quietly pricing a
different minute. That guard is the reason the rule matters — **a market is only
as resolvable as its shortest-lived source** — and it is why
`npm run genlayer:live-demo` locks an observation time 45 minutes out and expects
to be resolved promptly after it.

### Why there is no Python `MarketFactory`

A factory would have to deploy `PredictionMarket` from inside a contract. GenLayer's
`gl.deploy_contract` returns an address only for a salted CREATE2 deployment;
without a salt the address is assigned asynchronously by consensus and is not
returned at all, so a factory would either have to embed the market's full source
as a constant and manage salts, or hand back nothing the caller could bind to.
Deploying each `PredictionMarket` directly from the creator's wallet is simpler,
one transaction shorter, and leaves the creator paying for their own market.
The API is what records the pair, and it verifies the deployed contract's own
`market_state()` against the locked draft before accepting either address — which
is the guarantee a factory would have been providing.

### Known limitation: the dispute path

A `dispute_resolver` address is fixed at construction and cannot be added later.
When one is committed, a challenge is adjudicated by it. When it is the zero
address — which is what the deploy script and the dApp currently use — a
challenge cannot be adjudicated on chain at all, so once the dispute window
expires the contract **voids the market and refunds everyone, the challenger
included**. That is safe but it is also a griefing vector: anyone willing to lock
the minimum stake for the length of the dispute window can force any market to
VOID. Committing a dispute resolver at deployment removes it, because a rejected
challenge then forfeits its stake. This is written down rather than papered over;
a production system needs an escalation game with real slashing.

## Resolvers

One resolver is deployed per market. Its market ID, canonical spec/source hashes, observation time, question, source URLs, numeric paths/threshold or interpretation rule are immutable constructor state.

| Market level | Contract | Resolution |
| --- | --- | --- |
| 1 — numeric | `NumericResolver.py` | Fetches exactly three JSON sources (each with its own locked JSON path), enforces a max spread, takes the median, then applies the stored comparison in integer units (`valueUnits / scale`). |
| 2 — structured fact | `StructuredFactResolver.py` | Reads three fixed pages, extracts only `YES`/`NO`/`VOID`, then requires a two-source majority. |
| 3 — judgment | `JudgmentResolver.py` | Uses the frozen interpretation rule with the same two-source majority and a conservative `VOID` default. |

All web/LLM work executes in `gl.vm.run_nondet`, so a validator independently re-runs it before it accepts the leader result. URLs are never mutated after deployment. The contracts deliberately do **not** custody collateral; their result is read from chain by the relay and forwarded to the native-GEN `BinaryMarket` resolution authority on the collateral chain.

## Properties worth knowing

- **No floating point on the value path.** `NumericResolver` reads source numbers with `parse_float=str` and converts the literal text to scaled units with integer arithmetic. `int(float("0.29") * 100)` is `28`, which resolved a market sitting exactly on its threshold the wrong way.
- **An unusable source set is data, not an exception.** The leader returns `{"ok": false}` rather than raising, so leader and validator can *agree* that the market is unresolvable and settle VOID, instead of erroring out separately and failing consensus.
- **Validators compare the decision, not the bytes.** Per-source votes and page digests differ between nodes by design; only the settled label (or, for numeric markets, the median within the locked tolerance) has to match.
- **Every resolution is evidenced.** `resolved_at` comes from the transaction datetime and `source_digests` holds a Keccak-256 digest of each fetched body, both written in the same transaction as the outcome.
- **Binding is checked, not trusted.** `market_binding()` exposes the four identity hashes/values and `resolver_config()` exposes the actual executable source/rule constructor data. The API compares both, so copying the right hashes into a resolver with malicious URLs does not work.
- **Numeric observation time is exact.** Each numeric JSON source has a locked timestamp path and its own locked `timestampValue` (seconds, milliseconds or ISO as that source represents it). Calling the resolver later cannot silently substitute a later spot price.
- **The authority is a real address.** It is stored as `Address`, so a malformed constructor argument fails at deployment rather than producing a resolver nobody can ever call.
- **Untrusted source text cannot close its own block.** The closing sentinel is stripped from fetched pages before they are embedded in a prompt.

Run syntax validation with `npm run genlayer:syntax` and the resolver tests with `npm run genlayer:test` (needs `gltest` on `PATH`). Deployment requires the GenLayer CLI/testnet credentials and must set the factory's resolver relay address before markets are created.

## Relaying a result

`npm run resolver:publish` sends only the resolver address and finalized `resolve()` transaction hash. The API independently checks finality, success, transaction target, bindings, executable config, timestamps and snapshots, then reads the outcome from finalized state. The resolver key is authorization to request verification, not authority to choose a result.

```bash
MARKET_ID=... GENLAYER_RESOLVER_CONTRACT=0x... GENLAYER_RESOLUTION_TX=0x... RESOLVER_API_KEY=... npm run resolver:publish
```

## Bradbury v2 deployments

Finalized market-bound smoke deployments are recorded in [`deployments/bradbury-v2.json`](deployments/bradbury-v2.json). Check all three once, without polling or a private key:

```bash
npm run genlayer:status
```

- Numeric: `0xa0bf8Abe38cDa8E1dB92040a3823C4b810Cdd2b7`
- Structured: `0x6E5066c43D8F381fAb2a994f5F3433E6872d6fdc`
- Judgment: `0xaC520A14258c8af8d6Edf3937280F6B183120E7e`

All three deployment transactions are `FINALIZED` and `FINISHED_WITH_RETURN`; their bindings/configs were read back from finalized state. Outcomes remain intentionally `PENDING`: no extra resolution transactions were sent. They are smoke markets and cannot be reused for unrelated market IDs/specs.

## Legacy Bradbury deployment

> **Stale.** The instances below were deployed from the pre-v2 sources. Keep them only as history; do not bind them to new markets. Addresses and transaction hashes are versioned in [`deployments/bradbury.json`](deployments/bradbury.json).

- Numeric: [`0x768167523F3EC90C6DdC7c8e5F90e7901cAcC9b4`](https://explorer-bradbury.genlayer.com/address/0x768167523F3EC90C6DdC7c8e5F90e7901cAcC9b4)
- Structured fact: [`0x95A182fe4A1aDA7395283b2C41e80A1e6466916B`](https://explorer-bradbury.genlayer.com/address/0x95A182fe4A1aDA7395283b2C41e80A1e6466916B)
- Judgment: [`0xE6E5A7A2d8eC08DfFf70B1A607Fd922a0c5D711c`](https://explorer-bradbury.genlayer.com/address/0xE6E5A7A2d8eC08DfFf70B1A607Fd922a0c5D711c)
