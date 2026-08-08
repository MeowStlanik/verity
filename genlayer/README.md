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
| `finalize()` | uncontested → preliminary; disputed → the adjudicator's answer, or the preliminary outcome if it never produced one |
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
- **A dispute resolver is mandatory.** The constructor refuses the zero address,
  and refuses an adjudicator that is the resolver it would be adjudicating.
- **The challenge stake is never stranded.** Overturned by the adjudicator →
  refunded; upheld by the adjudicator → paid to the LPs; adjudicator silent when
  the dispute window closes → paid to the LPs, because an unsubstantiated
  challenge is a delay someone has to be paid for.
- **VOID cost basis is tracked per side.** `yes_cost` and `no_cost` are separate,
  so cashing out one leg of a hedged position retires that leg's refundable cost
  and nothing else. The retired amount rounds up, which can only ever leave the
  pool better off.
- **Effects precede transfers.** GenLayer messages are asynchronous, so positions
  are retired and `collateral` is decremented before `emit_transfer` is called,
  and accounting never reads `self.balance`, which lags emitted transfers.
- **Payouts are emitted `on: 'finalized'`, and that is not a bug.** A sale, a
  claim or an LP withdrawal updates the contract's state the moment it is
  *accepted*, but the GEN itself does not move until the transaction *finalizes* —
  which on Bradbury is minutes behind, sometimes considerably. So there is a real
  window where `market_state()` shows the collateral already gone and the wallet
  balance has not risen yet. Paying on `accepted` instead would close that window
  and open a much worse one: a round that consensus later rolls back would have
  moved the money anyway, and the same position could be paid twice. Wait for the
  balance, and never re-send a payout because the GEN "did not arrive".

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

### The dispute path

A `dispute_resolver` address is fixed at construction and cannot be added later,
so it has to be right at deployment — and the constructor now enforces that it
*is* one. A market cannot be deployed with the zero address, and it cannot name
its own resolver as its appeal court.

**What the adjudicator is.** A second instance of the same resolver contract over
the same immutable spec: same market ID, same spec and sources hashes, same
observation time, same locked URLs. `finalize()` checks that binding before it
will accept an answer, exactly as `publish_preliminary()` does for the primary.
An appeal is therefore a *fresh consensus round re-reading the locked sources* —
not a different rule, not a committee, and not the market creator. A leader that
misread a source the first time has no way to reproduce the misreading on demand;
a leader that read it correctly is confirmed.

**How a challenge resolves.** `resolve()` on the adjudicator is permissionless,
so a challenger with a real objection triggers it themselves and pays for it.

| At the end of the dispute window | Outcome | Stake |
| --- | --- | --- |
| Adjudicator overturned the published result | the adjudicator's answer | refunded |
| Adjudicator upheld the published result | published outcome | to the LPs |
| Adjudicator never produced a finalized answer | published outcome | to the LPs |

**Why the last row is not VOID.** It used to be, and that made the minimum stake a
free option to cancel any market: lock the stake, never trigger the adjudicator,
wait out the window, and the market voids while the stake comes back. Every
winning position was refunded to its cost basis by someone with nothing at risk.
Silence from an adjudicator anyone could have called is not evidence of anything,
whereas the published outcome did come from a finalized resolver — so the
published outcome stands, and the stake pays the LPs who carried the delay.

The trade-off is stated rather than hidden: a challenger who is right, and whose
adjudicator is genuinely unreachable for the whole window, loses their stake and
the wrong result stands. That is the standard optimistic default, and it is
strictly better than handing a cancel button to anyone with the minimum stake. A
production system wants a longer escalation game with real slashing on top of it.

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
- **Validators compare the decision, not the bytes.** Per-source votes and page digests differ between nodes by design; only the settled label has to match.
- **A numeric validator checks the payout, not just the distance.** The leader's median must be within the locked spread tolerance of the validator's own median **and** on the same side of the payout threshold. Distance alone is not agreement: the tolerance is an inter-exchange spread and is far wider than the distance to the strike for any market trading near it, so accepting on distance alone let a leader choose the winning side of a close market while every validator nodded along.
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

## The live Bradbury market

One market where GEN has actually moved, both ways, deployed by
`npm run genlayer:live-demo`:

| Role | Contract |
| --- | --- |
| `PredictionMarket` | `0x76A08Db659dFa651c0d358a39ECe445A65fB08aE` |
| resolver | `0x9eE00cEB83880F466Ad8Cbe7D1D15Ea0baCD3d80` |
| dispute resolver | `0xA21bad07eDeD9ABEe11413C2025624A7beC2391e` |

Both resolvers are `NumericResolver` instances over the same locked spec — the same
market ID, spec hash, sources hash and observation minute — which is what makes the
second one a valid appeal court for the first: `finalize()` checks that binding
before it will accept an answer. The full record, including the wei observed
returning to the deployer, is in
[`deployments/bradbury-live-demo.json`](deployments/bradbury-live-demo.json).

## Bradbury v2 deployments

Finalized market-bound smoke deployments are recorded in [`deployments/bradbury-v2.json`](deployments/bradbury-v2.json). Check all three once, without polling or a private key:

```bash
npm run genlayer:status
```

- Numeric: `0xa0bf8Abe38cDa8E1dB92040a3823C4b810Cdd2b7`
- Structured: `0x6E5066c43D8F381fAb2a994f5F3433E6872d6fdc`
- Judgment: `0xaC520A14258c8af8d6Edf3937280F6B183120E7e`

All three deployment transactions are `FINALIZED` and `FINISHED_WITH_RETURN`; their bindings/configs were read back from finalized state. Outcomes remain intentionally `PENDING`: no extra resolution transactions were sent. They are smoke markets and cannot be reused for unrelated market IDs/specs.

The `PredictionMarket` contracts bound to these three resolvers are **superseded**. They were deployed with a zero dispute resolver — the configuration the constructor now refuses — so a challenge against any of them could not be adjudicated and the minimum stake would force VOID. They also predate the per-side VOID cost basis. The resolvers themselves are unaffected; only the market contracts are stale, and their addresses are kept in the root README as history.

## Legacy Bradbury deployment

> **Stale.** The instances below were deployed from the pre-v2 sources. Keep them only as history; do not bind them to new markets. Addresses and transaction hashes are versioned in [`deployments/bradbury.json`](deployments/bradbury.json).

- Numeric: [`0x768167523F3EC90C6DdC7c8e5F90e7901cAcC9b4`](https://explorer-bradbury.genlayer.com/address/0x768167523F3EC90C6DdC7c8e5F90e7901cAcC9b4)
- Structured fact: [`0x95A182fe4A1aDA7395283b2C41e80A1e6466916B`](https://explorer-bradbury.genlayer.com/address/0x95A182fe4A1aDA7395283b2C41e80A1e6466916B)
- Judgment: [`0xE6E5A7A2d8eC08DfFf70B1A607Fd922a0c5D711c`](https://explorer-bradbury.genlayer.com/address/0xE6E5A7A2d8eC08DfFf70B1A607Fd922a0c5D711c)
