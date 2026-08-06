# Verity Markets — evaluation demo

Two things are deployed per market on GenLayer Bradbury:

1. a **resolver** (`NumericResolver` / `StructuredFactResolver` / `JudgmentResolver`)
   that decides YES / NO / VOID from three locked sources, and
2. a **`PredictionMarket`** that holds the GEN, prices YES/NO with an integer CPMM
   and pays out from the resolver's finalized answer.

Markets created through the dApp deploy both and are labelled **ON-CHAIN**.
The three seeded markets that ship with the repository are labelled **SIMULATION**:
they exercise the API ledger and are not backed by GEN. The badge is on the market
list, the market card, the detail header and the settlement tab, so the two are
never mixed silently.

## What moves real GEN

| Action | Where it runs |
| --- | --- |
| Deploy resolver, deploy PredictionMarket | Bradbury transaction, gas in GEN |
| Add liquidity, buy YES/NO | payable Bradbury transaction; the GEN enters the contract |
| Sell, claim, claim LP residual | Bradbury transaction; the contract emits a GEN transfer back |
| Publish preliminary, challenge, finalize | Bradbury transaction (`challenge` is payable) |
| Anything on a SIMULATION market | API ledger only; no GEN moves |

The API never holds balances for an on-chain market. It stores the metadata, the
Resolution Spec, the two contract addresses and cached reads; every value-moving
call is refused with `ONCHAIN_MARKET` and belongs to the contract.

## Deploying a tradeable market of your own

The markets bound to the existing v2 resolvers all close in the past, so they open
on the "publish preliminary result" step and cannot be traded. To get one that can:

```bash
CONFIRM_BRADBURY_DEPLOY=YES npm run genlayer:live-demo
```

It locks an observation minute 45 minutes out, deploys a `NumericResolver` bound to
three exchange candles at exactly that minute, deploys the `PredictionMarket` bound
to that resolver, then sends real liquidity (0.5 GEN) and a real YES buy (0.1 GEN),
printing the addresses and the resulting contract state.

Every step waits for `ACCEPTED` — the point at which a contract becomes callable —
rather than for finality, which arrives later and is checked by
`npm run genlayer:finalize`. If the network stalls mid-run, resume instead of
restarting; the observation minute is baked into the resolver's constructor and
both hashes, so a fresh minute would produce a resolver the market can never bind
to:

```bash
CONFIRM_BRADBURY_DEPLOY=YES MARKET_MINUTE=<minute> RESOLVER_TX=0x<hash> \
  ACCEPT_RETRIES=100 npm run genlayer:live-demo
```

## Ten-minute walkthrough

1. Open the UI and connect MetaMask. The same signature authenticates API writes.
   Bradbury is added/switched with standard EIP-1193 calls — no MetaMask Snap.
2. **Create Market → Load evaluation demo.** Set the observation time far enough
   ahead to leave time for trading (30+ minutes).
3. Click **Create + deploy resolver**. Two MetaMask confirmations follow: the
   resolver, then the `PredictionMarket` bound to it. The API verifies both
   against the locked draft before it will record either address.
4. On the market page, **Provide liquidity** first — a market with no liquidity
   cannot be traded. Then buy YES or NO. The quote comes from `quote_buy()` on the
   contract, so the number shown is the number filled; a 1% slippage floor and a
   two-minute deadline are enforced by the contract, not the UI.
5. After the locked observation time, **Publish preliminary result**. This call
   takes no arguments: the contract reads the resolver's finalized outcome itself.
   (The resolver must have been resolved first — see `npm run genlayer:status`.)
6. A 10-minute challenge window opens for YES, NO **and** VOID. Either stake 0.1 GEN
   to challenge, or wait for it to expire and click **Finalize**.
7. **Claim payout** — one GEN per winning share, or the exact GEN paid in on a VOID.
   Liquidity providers claim their residual separately.

## Run locally

```bash
npm install
npm run api        # terminal 1
npm run dev        # terminal 2
```

UI on `http://localhost:5173`, API on `http://localhost:8000`. The Vite proxy keeps
requests same-origin, so the flow also works through a forwarded Codespaces URL.

## Vercel-only deployment

The Vite frontend and a same-origin Vercel Function deploy together. The function
stores the ledger and wallet login nonces in Neon Postgres with compare-and-swap
revisions, so concurrent trades cannot overwrite each other.

1. Import the repository in Vercel and deploy once.
2. **Storage → Create Database → Neon Postgres**, free plan, connected to the same
   project. This injects `DATABASE_URL`.
3. **Settings → Environment Variables**: `AUTH_SECRET` (`openssl rand -hex 32`),
   optionally `CHALLENGE_WINDOW_SECONDS=120` and `RESOLVER_API_KEY`.
4. Redeploy. `/health` should report `"storage":"postgres"`.

Do not set `VITE_API_BASE`: requests stay on the Vercel origin. No Railway, Render,
separate backend, migration command or persistent worker is involved.

Bradbury needs test GEN for gas and for liquidity. RPC `https://rpc-bradbury.genlayer.com`,
chain ID `4221`, currency `GEN`, explorer `https://explorer-bradbury.genlayer.com`.
