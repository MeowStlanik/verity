# Backend/API guide

All times are ISO-8601 UTC and wallet mutations require the bearer token obtained from `/v1/auth/nonce` + `/v1/auth/verify`.

## Public endpoints

- `GET /v1/markets`, `GET /v1/markets/:id`
- `GET /v1/markets/:id/quote?side=YES&amount=100&action=buy|sell`
- `GET /v1/portfolio/:fullEthereumAddress`
- `POST /v1/trades` — `action`, `side`, `amount`, `deadline`, and `minSharesOut` or `minAmountOut`
- `POST /v1/liquidity`, `POST /v1/liquidity/claims`
- `POST /v1/challenges`, `POST /v1/claims`
- `POST /v1/markets` — creates an immutable draft from exactly three fixed sources and a complete resolution rule
- `POST /v1/markets/:id/resolver` — creator binds a deployed resolver after its finalized binding/config is verified; only then does trading start
- `POST /v1/markets/:id/contract` — creator binds the deployed `PredictionMarket`. The API reads `market_state()` at `latest-final` and requires the market ID, both hashes, the observation time and the resolver address to match the locked draft.

Once a market contract is bound, `settlement` becomes `onchain` and every
value-moving endpoint above returns `409 ONCHAIN_MARKET` for that market: the
contract owns those actions and the client calls it directly. The API keeps the
metadata, the Resolution Spec, both addresses and cached reads.

Numeric creation additionally requires `jsonPath`, `timestampPath`, and the source-specific locked `timestampValue` on every source plus integer `scale`, `thresholdUnits`, `maxSourceSpreadUnits`, and a comparator. Structured markets require `criterion`; judgment markets require `interpretationRule`.

## Settlement endpoints

Both endpoints require `X-Resolver-Key`, but the key cannot select an outcome:

```json
POST /v1/internal/markets/:id/preliminary
{ "contractAddress": "0x...", "transactionHash": "0x..." }
```

For a dispute, the same envelope is posted to `/final`; the first expanded resolver address becomes immutable. The API reads the outcome from finalized GenLayer state and rejects wrong market IDs, spec/source hashes, observation times, executable source/rule configurations, transaction targets, non-final transactions and incomplete snapshots.

The lifecycle worker calls `/v1/internal/lifecycle/tick`; only the API process writes the store.
