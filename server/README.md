# API internals

Run `npm run api`; optionally run `npm run worker` in another process. The worker never opens the JSON store: it calls the protected lifecycle endpoint, leaving the API as the only writer. Store mutations are additionally serialized and committed by atomic rename.

On Vercel, `api/index.js` runs the same routes through a Vercel Function.
`PostgresMarketStore` stores the aggregate in Neon and commits with a versioned
compare-and-swap update. This preserves the domain's atomic trade/position/pool
updates across concurrent serverless instances. Schema setup and seed insertion are
idempotent, and wallet login nonces are also stored in Postgres.

`GET /v1/markets/:id/quote` and `POST /v1/trades` share the same buy/sell CPMM math. Mutations require wallet nonce/signature authentication and use the address in the signed bearer token.

Settlement requests contain only `{ contractAddress, transactionHash }`. `genlayer-verifier.mjs` checks finalized successful execution and the resolver's finalized binding/config/state before creating a verified domain envelope. `MarketStore.publishPreliminary` rejects unverified envelopes and refuses any replacement once a challenge window or dispute exists.

An authenticated dApp user may submit that proof at `POST /v1/markets/:id/resolution`; the endpoint still derives the outcome from finalized GenLayer state. `CHALLENGE_WINDOW_SECONDS` controls the API-ledger window (default 1800, minimum 60) so a live testnet demo can use a shorter window without weakening the production default.

## On-chain markets are not this ledger's business

Once a market has a deployed `PredictionMarket`, `POST /v1/markets/:id/contract`
records its address and `market.settlement` becomes `onchain`. From then on
`MarketStore._requireLedger` refuses every value-moving call — trade, liquidity,
claim, challenge, publish, finalize — with `ONCHAIN_MARKET`, because keeping a
second set of balances beside the contract's is how the two silently diverge.
The API keeps the metadata, the Resolution Spec, both contract addresses and
cached reads; the client reads balances, shares, quotes and outcome from the
contract itself.

`verifyMarketContract` reads `market_state()` at `latest-final` and compares the
market ID, both hashes, the observation time and the resolver address against the
locked draft before the binding is accepted, so a creator cannot point a market at
a lookalike contract that pays out differently.

The JSON/Postgres ledger remains the settlement path only for markets marked
`simulation` — the seeded demo markets. Those are labelled SIMULATION everywhere
they appear in the UI.
