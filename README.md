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
resolver's finalized answer. Every market is deployed against **two** resolver
instances over the same locked spec — one that decides, one that a challenge
appeals to. See [`genlayer/README.md`](genlayer/README.md) for its methods, its
solvency invariant, and how the dispute path resolves.

Start with [DEMO.md](DEMO.md) for the create → deploy → trade → resolve → claim
walkthrough.

## What is deployed

Network **GenLayer Bradbury Testnet** · Chain ID **4221** · Currency **GEN**
RPC `https://rpc-bradbury.genlayer.com` · Explorer `https://explorer-bradbury.genlayer.com`

**The live market — this is the one that holds GEN:**

| Role | Contract |
| --- | --- |
| `PredictionMarket` | [`0x76A08Db659dFa651c0d358a39ECe445A65fB08aE`](https://explorer-bradbury.genlayer.com/address/0x76A08Db659dFa651c0d358a39ECe445A65fB08aE) |
| resolver | [`0x9eE00cEB83880F466Ad8Cbe7D1D15Ea0baCD3d80`](https://explorer-bradbury.genlayer.com/address/0x9eE00cEB83880F466Ad8Cbe7D1D15Ea0baCD3d80) |
| dispute resolver | [`0xA21bad07eDeD9ABEe11413C2025624A7beC2391e`](https://explorer-bradbury.genlayer.com/address/0xA21bad07eDeD9ABEe11413C2025624A7beC2391e) |

Market ID `bradbury-live-demo-1786159260`, observation time `2026-08-08T03:21:00Z`,
2% fee, 10-minute challenge window, 0.1 GEN minimum challenge stake. Both resolvers
are separate instances of `NumericResolver` bound to the same market ID, the same
spec and sources hashes and the same observation minute, which is what lets
`finalize()` accept the second one's answer as an appeal against the first one's.

**Value path.** 0.6 GEN went in and is there: 0.5 GEN of liquidity
([`0x62fac965…`](https://explorer-bradbury.genlayer.com/tx/0x62fac965d313618a8c73898dce00b60254ff48282f108f8048d4fab09bd31bec))
and a 0.1 GEN YES buy
([`0xd3ff3580…`](https://explorer-bradbury.genlayer.com/tx/0xd3ff358090dc03edd675544fb58f01badf0909f3f739cda433b3330a93236a6e)).
The market reads `collateral 0.5745 GEN` against a 0.6 GEN balance at the chain
layer, and the buyer's position reads `yesShares 0.13495`, `yesCost 0.075 GEN`,
`noCost 0` — the per-side VOID basis, live.

Coming back out, a quarter of that position was sold
([`0xc67ca774…`](https://explorer-bradbury.genlayer.com/tx/0xc67ca77464861d3b74a69b78773d8283c4b5b5cf4cdcc3936301a698b075bdf1)):
0.04498 shares against a quoted 0.02547 GEN. The shares are retired and the
collateral is down by exactly that amount — `yesCost` fell from 0.1 to 0.075,
which is the ceiling-rounded quarter of the basis. The transaction reached
`FINALIZED` / `FINISHED_WITH_RETURN`, and **it carries the outbound transfer the
contract emitted**: one message of `messageType 1` for `value 25470119039617052`
wei, which is the quoted payout to the wei.

**That message has not been delivered.** Hours after finality the market's balance
is still the full 0.6 GEN and the seller's wallet is unchanged. So the contract
side of the payout path is done and evidenced in the finalized receipt, and what
has not happened is Bradbury applying the emitted message. This is recorded as
observed rather than smoothed over: the money-out path is **not** demonstrated
end to end on this network, and `observedOutWei` in the deployment record is
`null` because the script reports what it saw rather than what it expected.

`_pay` emits `on: 'finalized'` deliberately and that is not the thing to change.
Emitting `on: 'accepted'` would move value on a round consensus can still roll
back and would let one position be paid twice — a solvency hole traded for a
cosmetic improvement. Whatever is holding the message is downstream of the
contract. Do not re-send a payout that looks missing.

Redeploy one of these yourself, end to end, with
`CONFIRM_BRADBURY_DEPLOY=YES npm run genlayer:live-demo`; the full record of this
run is in
[`genlayer/deployments/bradbury-live-demo.json`](genlayer/deployments/bradbury-live-demo.json).

**Earlier smoke deployments — stale, do not bind new markets to these.**

| Market | Resolver | `PredictionMarket` |
| --- | --- | --- |
| numeric | [`0xa0bf8Abe…`](https://explorer-bradbury.genlayer.com/address/0xa0bf8Abe38cDa8E1dB92040a3823C4b810Cdd2b7) | [`0x13b407dd…`](https://explorer-bradbury.genlayer.com/address/0x13b407ddA155e733Fb42089f5D8E4f99CDD04eFB) |
| structured | [`0x6E5066c4…`](https://explorer-bradbury.genlayer.com/address/0x6E5066c43D8F381fAb2a994f5F3433E6872d6fdc) | [`0xAC6F7B9c…`](https://explorer-bradbury.genlayer.com/address/0xAC6F7B9c059Ad6190d74399c3311dFEEDe149C0b) |
| judgment | [`0xaC520A14…`](https://explorer-bradbury.genlayer.com/address/0xaC520A14258c8af8d6Edf3937280F6B183120E7e) | [`0xA073ff16…`](https://explorer-bradbury.genlayer.com/address/0xA073ff16703d166015614Aec6DB5A7E721C18F90) |

Those three markets were deployed from the previous contract with a **zero dispute
resolver**, which is the configuration the current constructor refuses: a challenge
against any of them cannot be adjudicated, so the minimum stake would force VOID.
They also carry the old shared VOID cost basis. They hold no GEN, their observation
times have passed, and they are kept as history. The resolvers above are fine and
still readable; it is the market contracts that are superseded.

Read any of it back from the chain — no key needed:

```bash
npm run genlayer:status     # resolvers
npm run genlayer:markets    # markets, read from chain
npm run genlayer:finalize   # re-check deployments, record newly finalized ones
```

An address is recorded here only after the contract answered a call at it, never
from a receipt's predicted address. Per-deployment detail lives in
[`genlayer/deployments/bradbury-markets.json`](genlayer/deployments/bradbury-markets.json).

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
- **A dispute adjudicator is mandatory.** The constructor refuses the zero
  address and refuses an adjudicator that is the resolver it would adjudicate, so
  no market can be deployed into the configuration where a challenge it cannot
  judge leaves voiding as the only safe answer.
- **A challenge cannot force VOID.** If the adjudicator has produced no finalized
  answer when the dispute window closes, the published outcome stands and the
  stake pays the LPs. Nothing on chain substantiated the objection —
  `resolve()` on the adjudicator is permissionless, so a challenger with a real
  one had the whole window to trigger it — and the published outcome did come
  from a finalized resolver. VOID after a challenge is still reachable, but only
  when the adjudicator itself finalizes VOID.
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
- **A VOID refund follows the leg that paid for it.** YES and NO cost bases are
  stored separately, so selling one side of a hedged position retires that side's
  refundable cost and leaves the other side's alone. A single shared basis wiped
  the untouched leg's refund when the sold leg was the smaller one, and left the
  refund standing — payable out of collateral the pool never received — when it
  was the larger.
- **The challenge stake always leaves the contract**: refunded when the
  adjudicator overturns the published outcome, paid to the LPs when it upholds it
  or when it never answers.
- **Effects precede transfers**, because GenLayer messages are asynchronous. A
  contract's GEN is held by a ghost contract at the chain layer while its state
  lives at the intelligent layer, so accounting here never reads `self.balance` —
  only the collateral the contract books itself.

## Checks

```bash
npm test                 # API + resolver/market gltest + typecheck + production build
npm audit --omit=dev
```

43 API tests and 52 GenVM tests. The GenVM suite covers payable liquidity, buys on
both sides, price movement, slippage rejection, expired deadlines, sells, trading
after close, resolver binding, preliminary YES/NO/VOID, the VOID challenge window,
challenge stakes, prevention of preliminary overwrite, uncontested finalization,
winning claims, losing positions, VOID refunds, double-claim rejection, LP
liability protection, and the challenge stake in each of its outcomes.

The paths worth naming individually, because each of them is a bug this contract
used to have:

- a market with no adjudicator, and a market naming its own resolver as its
  adjudicator, are both refused at deployment;
- a minimum-stake challenge against a correct result, never escalated, settles the
  published outcome, pays the winner in full and forfeits the stake;
- selling either leg of a hedged YES/NO position leaves the other leg's VOID
  refund intact, and dribbling the larger leg out in slices cannot refund more
  than the trader paid in;
- a numeric validator refuses a leader whose median falls on the other side of the
  payout threshold, accepts the same drift on its own side of it, and still
  refuses one outside the spread tolerance.

Further reading: [BACKEND_GUIDE.md](BACKEND_GUIDE.md),
[server/README.md](server/README.md), [genlayer/README.md](genlayer/README.md),
[contracts/README.md](contracts/README.md).
