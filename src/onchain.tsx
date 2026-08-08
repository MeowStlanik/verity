import React, { useEffect, useState } from 'react';
import { money, short, utc } from './format';
import {
  addLiquidityOnChain, buyOnChain, challengeOnChain, claimLiquidityOnChain, claimOnChain, finalizeOnChain,
  fromWei, publishPreliminaryOnChain, quoteOnChain, readMarketState, readPosition, sellOnChain, toWei, withSlippage,
} from './market';
import type { OnChainMarketState, OnChainPosition, OnChainQuote } from './market';
import type { Market, Side } from './types';

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

type OnChainStage = 'trading' | 'awaiting_resolution' | 'challenge_window' | 'disputed' | 'settled';
function onChainStage(state: OnChainMarketState): OnChainStage {
  const now = Math.floor(Date.now() / 1000);
  if (state.finalOutcome !== 'PENDING') return 'settled';
  if (state.preliminaryOutcome === 'PENDING') return now < Date.parse(state.observationTime) / 1000 ? 'trading' : 'awaiting_resolution';
  return state.challenger.toLowerCase() === ZERO_ADDRESS ? 'challenge_window' : 'disputed';
}

/**
 * Everything shown by this panel is read from the PredictionMarket contract, and
 * every button sends a Bradbury transaction that moves real GEN. Nothing here is
 * mirrored from the API ledger.
 */
export default function OnChainPanel({ market, address, onMessage }: { market: Market; address: string | null; onMessage: (value: string) => void }) {
  const contract = market.marketContractAddress as string;
  const [state, setState] = useState<OnChainMarketState | null>(null);
  const [position, setPosition] = useState<OnChainPosition | null>(null);
  const [side, setSide] = useState<Side>('YES');
  const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('0.1');
  const [liquidity, setLiquidity] = useState('1');
  const [stake, setStake] = useState('0.1');
  const [reason, setReason] = useState('');
  const [quote, setQuote] = useState<OnChainQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const load = async () => {
    setState(await readMarketState(contract));
    setPosition(address ? await readPosition(contract, address) : null);
  };
  useEffect(() => { load().catch((caught) => onMessage((caught as Error).message)); }, [contract, address]);

  const held = position ? (side === 'YES' ? position.yesShares : position.noShares) : 0n;
  useEffect(() => {
    setQuote(null);
    if (!state || onChainStage(state) !== 'trading') return;
    let wei: bigint;
    try { wei = toWei(amount); } catch { return; }
    if (wei <= 0n || (action === 'sell' && wei > held)) return;
    const timer = setTimeout(() => {
      quoteOnChain(contract, side, action, wei).then(setQuote).catch(() => setQuote(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [contract, side, action, amount, state?.yesReserve, state?.noReserve, held]);

  async function run(label: string, work: () => Promise<string>) {
    if (!address) return onMessage('Connect your wallet first');
    setBusy(true); setProgress('');
    try {
      const hash = await work();
      await load();
      setProgress('');
      onMessage(`${label} finalized on Bradbury (${hash.slice(0, 10)}…).`);
    } catch (caught) { setProgress(''); onMessage((caught as Error).message); }
    finally { setBusy(false); }
  }

  if (!state) return <aside className="trade-panel"><div className="ledger-label onchain">ON-CHAIN · GENLAYER BRADBURY</div><p className="quote-loading">Reading finalized contract state…</p></aside>;
  const stage = onChainStage(state);
  const yesPrice = state.probability;
  return <aside className="trade-panel">
    <div className="ledger-label onchain">ON-CHAIN · GENLAYER BRADBURY</div>
    <p className="mono contract-address">{contract}</p>
    {stage === 'trading' && <>
      <div className="trade-tabs"><button aria-pressed={action === 'buy'} onClick={() => setAction('buy')}>Buy</button><button aria-pressed={action === 'sell'} onClick={() => setAction('sell')}>Sell</button></div>
      <div className="trade-sides">
        <button className="yes" aria-pressed={side === 'YES'} onClick={() => setSide('YES')}><span>YES</span><b>{yesPrice.toFixed(2)} GEN</b></button>
        <button className="no" aria-pressed={side === 'NO'} onClick={() => setSide('NO')}><span>NO</span><b>{(1 - yesPrice).toFixed(2)} GEN</b></button>
      </div>
      <label>{action === 'buy' ? 'Amount (GEN)' : 'Shares to sell'}<div className="amount-input"><input aria-label={action === 'buy' ? 'Amount in GEN' : 'Shares to sell'} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /><span>{action === 'buy' ? 'GEN' : 'SHARES'}</span></div></label>
      {action === 'sell' && <p className="muted">Available: {fromWei(held).toFixed(4)} shares</p>}
      {quote ? <dl className="quote">
        <div><dt>{action === 'buy' ? 'Shares' : 'You receive'}</dt><dd>{action === 'buy' ? fromWei(quote.shares).toFixed(4) : money(fromWei(quote.amountOut))}</dd></div>
        <div><dt>Fee</dt><dd>{money(fromWei(quote.fee))}</dd></div>
        <div><dt>Average price</dt><dd>{quote.avgPrice.toFixed(4)} GEN</dd></div>
        <div><dt>Slippage limit</dt><dd>1.00%</dd></div>
      </dl> : <p className="quote-loading">Quoting from the contract…</p>}
      <button className={`button wide ${side === 'YES' ? 'yes-button' : 'no-button'}`} disabled={busy || !quote || !address} onClick={() => run(action === 'buy' ? 'Buy' : 'Sell', () => action === 'buy'
        ? buyOnChain(contract, address!, side, toWei(amount), withSlippage(quote!.shares), setProgress)
        : sellOnChain(contract, address!, side, toWei(amount), withSlippage(quote!.amountOut), setProgress))}>
        {busy ? 'Waiting for finality…' : `${action === 'buy' ? 'Buy' : 'Sell'} ${side} on-chain`}
      </button>
      <label>Add liquidity (GEN)<div className="amount-input"><input aria-label="Liquidity in GEN" inputMode="decimal" value={liquidity} onChange={(event) => setLiquidity(event.target.value)} /><span>GEN</span></div></label>
      <button className="button secondary wide" disabled={busy || !address} onClick={() => run('Liquidity deposit', () => addLiquidityOnChain(contract, address!, toWei(liquidity), setProgress))}>Provide liquidity</button>
    </>}
    {stage === 'awaiting_resolution' && <>
      <p>Trading closed at the observation time. The contract will copy in the finalized outcome of its bound resolver; no caller can supply one.</p>
      <button className="button primary wide" disabled={busy || !address} onClick={() => run('Preliminary result', () => publishPreliminaryOnChain(contract, address!, setProgress))}>Publish preliminary result</button>
    </>}
    {(stage === 'challenge_window' || stage === 'disputed') && <>
      <dl className="quote">
        <div><dt>Preliminary</dt><dd>{state.preliminaryOutcome}</dd></div>
        <div><dt>Window closes</dt><dd>{utc(new Date(state.challengeClosesAt * 1000).toISOString())}</dd></div>
        <div><dt>Minimum stake</dt><dd>{money(fromWei(state.minChallengeStake))}</dd></div>
      </dl>
      {stage === 'challenge_window' && <>
        <label>Challenge reason<textarea aria-label="Challenge reason" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <label>Stake (GEN)<div className="amount-input"><input aria-label="Challenge stake in GEN" inputMode="decimal" value={stake} onChange={(event) => setStake(event.target.value)} /><span>GEN</span></div></label>
        <button className="button amber wide" disabled={busy || !address || !reason.trim()} onClick={() => run('Challenge', () => challengeOnChain(contract, address!, reason, toWei(stake), setProgress))}>Stake and challenge</button>
      </>}
      {stage === 'disputed' && <p>Challenged by {short(state.challenger)} for {money(fromWei(state.challengeStake))}. Call <code>resolve()</code> on the dispute resolver ({short(state.disputeResolver)}) before the window closes: it decides, and the stake is refunded if it overturns the published result. If it has produced no finalized answer by then, the published outcome stands and the stake goes to the liquidity providers — so an unsubstantiated challenge cannot cancel the market.</p>}
      <button className="button secondary wide" disabled={busy || !address} onClick={() => run('Finalization', () => finalizeOnChain(contract, address!, setProgress))}>Finalize</button>
    </>}
    {stage === 'settled' && <>
      <dl className="quote">
        <div><dt>Final outcome</dt><dd>{state.finalOutcome}</dd></div>
        <div><dt>Your YES / NO</dt><dd>{fromWei(position?.yesShares || 0n).toFixed(4)} / {fromWei(position?.noShares || 0n).toFixed(4)}</dd></div>
        <div><dt>Refundable cost</dt><dd>{money(fromWei(position?.paidCost || 0n))}</dd></div>
        <div><dt>LP shares</dt><dd>{fromWei(position?.lpShares || 0n).toFixed(4)}</dd></div>
      </dl>
      <button className="button primary wide" disabled={busy || !address || position?.claimed} onClick={() => run('Claim', () => claimOnChain(contract, address!, setProgress))}>{position?.claimed ? 'Already claimed' : 'Claim payout'}</button>
      <button className="button secondary wide" disabled={busy || !address || position?.lpClaimed || !position?.lpShares} onClick={() => run('LP claim', () => claimLiquidityOnChain(contract, address!, setProgress))}>{position?.lpClaimed ? 'LP already claimed' : 'Claim LP residual'}</button>
    </>}
    {progress && <p className="trade-message" role="status">{progress}</p>}
    <div className="pool-depth">
      <strong>Contract state</strong>
      <div><span>YES reserve</span><b>{fromWei(state.yesReserve).toFixed(4)}</b></div>
      <div><span>NO reserve</span><b>{fromWei(state.noReserve).toFixed(4)}</b></div>
      <div><span>Collateral</span><b>{fromWei(state.collateral).toFixed(4)} GEN</b></div>
      <div><span>Outstanding YES / NO</span><b>{fromWei(state.totalYesShares).toFixed(2)} / {fromWei(state.totalNoShares).toFixed(2)}</b></div>
    </div>
    <div className="trade-foot"><span>Every action is a Bradbury transaction</span><span>2 min deadline</span></div>
  </aside>;
}

