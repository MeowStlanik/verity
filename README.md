# Verity Markets

A prediction market whose outcomes are decided by GenLayer Intelligent Contracts
and whose money is held by one, too.

Three market classes share one settlement discipline — a Resolution Spec locked at
creation, three fixed sources, and YES / NO / **VOID** as first-class outcomes:

| Level | Resolver | Decides from |
| --- | --- | --- |
| 1 · deterministic | `NumericResolver.py` | three JSON feeds → exact-integer median vs a locked threshold |
| 2 · structured fact | `StructuredFactResolver.py` | three fixed pages → two-of-three majority |
| 3 · judgment | `JudgmentResolver.py` | three fixed pages read against a frozen interpretation rule |

`PredictionMarket.py` is the market itself: it custodies native GEN, prices YES/NO
with an integer complete-set CPMM, runs the challenge window, and pays out from the
resolver's finalized answer. See [`genlayer/README.md`](genlayer/README.md) for its
methods, its solvency invariant, and the limitation in its dispute path.

Start with [DEMO.md](DEMO.md) for the create → deploy → trade → resolve → claim
walkthrough.

## What is deployed

Network **GenLayer Bradbury Testnet** · Chain ID **4221** · Currency **GEN**
RPC `https://rpc-bradbury.genlayer.com` · Explorer `https://explorer-bradbury.genlayer.com`

**`PredictionMarket` contracts — all FINALIZED:**

| Market | Contract |
| --- | --- |
| numeric | [`0x13b407ddA155e733Fb42089f5D8E4f99CDD04eFB`](https://explorer-bradbury.genlayer.com/address/0x13b407ddA155e733Fb42089f5D8E4f99CDD04eFB) |
| structured | [`0xAC6F7B9c059Ad6190d74399c3311dFEEDe149C0b`](https://explorer-bradbury.genlayer.com/address/0xAC6F7B9c059Ad6190d74399c3311dFEEDe149C0b) |
| judgment | [`0xA073ff16703d166015614Aec6DB5A7E721C18F90`](https://explorer-bradbury.genlayer.com/address/0xA073ff16703d166015614Aec6DB5A7E721C18F90) |

**Resolvers — all FINALIZED:**

| Market | Resolver |
| --- | --- |
| numeric | [`0xa0bf8Abe38cDa8E1dB92040a3823C4b810Cdd2b7`](https://explorer-bradbury.genlayer.com/address/0xa0bf8Abe38cDa8E1dB92040a3823C4b810Cdd2b7) |
| structured | [`0x6E5066c43D8F381fAb2a994f5F3433E6872d6fdc`](https://explorer-bradbury.genlayer.com/address/0x6E5066c43D8F381fAb2a994f5F3433E6872d6fdc) |
| judgment | [`0xaC520A14258c8af8d6Edf3937280F6B183120E7e`](https://explorer-bradbury.genlayer.com/address/0xaC520A14258c8af8d6Edf3937280F6B183120E7e) |

Every market contract stores its market ID, both locked hashes, the observation
time, the fee, the challenge window and the resolver address it will settle from,
and every one of them names the resolver this repository says it should. Read it
all back from the chain — no key needed:

```bash
npm run genlayer:status     # resolvers
npm run genlayer:markets    # markets, read from chain
npm run genlayer:finalize   # re-check deployments, record newly finalized ones
```

An address is recorded here only after the contract answered a call at it, never
from a receipt's predicted address. Per-deployment detail lives in
[`genlayer/deployments/bradbury-markets.json`](genlayer/deployments/bradbury-markets.json).

**Value path.** These contracts are deployed and callable; no GEN has been traded
through them yet. All three read `collateral 0`, and their observation times have
passed, so they open on the "publish preliminary result" step rather than on
trading. The CPMM, challenge window, VOID refunds, LP protection and claim logic
are exercised by the 44 GenVM tests below. For a market that can actually be
traded, deploy a fresh one with `npm run genlayer:live-demo` — it locks an
observation time 45 minutes out and then sends real liquidity and a real buy.

## What is on chain and what is not

Markets carry a badge everywhere they are shown, because this distinction is a
correctness claim rather than a presentation detail:

- **ON-CHAIN** — a `PredictionMarket` contract holds the GEN. Liquidity, buys,
  sells, challenges, finalization and claims are Bradbury transactions. The API
  refuses every value-moving call for these markets (`ONCHAIN_MARKET`) and serves
  metadata and cached reads only; the client reads balances, shares, quotes and
  outcome from the contract.
- **SIMULATION** — `simulation-ledger-demo` in the seed. It exercises the API's
  CPMM ledger, moves no GEN, and is the one market on the list that trades without
  a wallet transaction. It ships alongside the on-chain ones on purpose: a badge
  nobody can compare against says nothing.

`contracts/*.sol` is an earlier EVM design of the same mechanism. It is **not
deployed** and is not the GenLayer path; it has a compile test and no behavioural
tests. See [`contracts/README.md`](contracts/README.md).

## Run

```bash
npm install
cp .env.example .env
npm run api      # terminal 1 — http://localhost:8000
npm run dev      # terminal 2 — http://localhost:5173
```

Local development uses an atomic JSON store. A Vercel deployment uses the included
Vercel Function and Neon Postgres adapter; no separate API host and no
`VITE_API_BASE` are needed. Setup steps are in [DEMO.md](DEMO.md).

## Security model

- **No caller can supply an outcome.** `publish_preliminary()` takes no arguments;
  it reads the bound resolver's `market_binding()` and `resolution()` at
  `LATEST_FINAL` and rejects any mismatch of market ID, spec hash, sources hash or
  observation time, and any result dated before the observation time.
- **No admin outcome switch.** The contract has no owner method, is not
  upgradeable, and its resolver and dispute resolver are fixed at construction.
- **YES, NO and VOID all enter the same challenge window,** and an uncontested
  finalization can only confirm the published preliminary outcome.
- **Wei only.** Every amount, quote, fill, fee and refund is an exact integer, so
  the price shown is the price filled.
- **Solvency is an invariant, not a hope.** Reserves are seeded so
  `max(yes_reserve, no_reserve) <= collateral`, and every buy re-checks the
  projected book against its backing before writing any state.
- **LP funds cannot outrun trader liabilities.** LP shares are minted and redeemed
  against equity — collateral minus what traders are already owed — never against
  gross collateral, and the residual is fixed at settlement once the winning side
  is fully covered.
- **The challenge stake always leaves the contract**: refunded when a challenge is
  upheld or cannot be adjudicated, paid to the LPs when a committed dispute
  resolver rejects it.
- **Effects precede transfers**, because GenLayer messages are asynchronous. A
  contract's GEN is held by a ghost contract at the chain layer while its state
  lives at the intelligent layer, so accounting here never reads `self.balance` —
  only the collateral the contract books itself.

## Checks

```bash
npm test                 # API + resolver/market gltest + typecheck + production build
npm audit --omit=dev
```

43 API tests and 44 GenVM tests. The GenVM suite covers payable liquidity, buys on
both sides, price movement, slippage rejection, expired deadlines, sells, trading
after close, resolver binding, preliminary YES/NO/VOID, the VOID challenge window,
challenge stakes, prevention of preliminary overwrite, uncontested finalization,
winning claims, losing positions, VOID refunds, double-claim rejection, LP
liability protection, and the challenge stake in all four of its outcomes.

Further reading: [BACKEND_GUIDE.md](BACKEND_GUIDE.md),
[server/README.md](server/README.md), [genlayer/README.md](genlayer/README.md),
[contracts/README.md](contracts/README.md), [AUDIT-FIXES.md](AUDIT-FIXES.md).
