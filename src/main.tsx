import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import type { Market, MarketType, Portfolio, Quote, Side, Source } from './types';
import { compactMoney, money, short, titleCase, utc } from './format';
import logo from '../uploads/pasted-1785878984854-0.png';
import './styles.css';

const marketTypeLabel: Record<MarketType, string> = {
  deterministic: 'Deterministic', structured: 'Structured fact', judgment: 'Judgment',
};
const statusLabel: Record<string, string> = {
  draft: 'Draft', trading: 'Trading', closed: 'Closed', preliminary: 'Preliminary result',
  challenge_window: 'Challenge window', disputed: 'Disputed', resolved_yes: 'Resolved · YES',
  resolved_no: 'Resolved · NO', void: 'Void',
};

function go(to: string) {
  history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function Link({ to, className = '', children }: { to: string; className?: string; children: React.ReactNode }) {
  return <a href={to} className={className} onClick={(event) => {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      go(to);
    }
  }}>{children}</a>;
}

function Logo() {
  return <Link className="brand" to="/">
    <img src={logo} alt="" />
    <span>Verity Markets</span>
  </Link>;
}

function Layout({ address, setAddress, path }: { address: string | null; setAddress: (value: string | null) => void; path: string }) {
  const [error, setError] = useState('');
  const [walletOpen, setWalletOpen] = useState(false);
  const marketId = path.match(/^\/markets\/([^/]+)$/)?.[1];
  async function connect() {
    try { setError(''); setAddress(await api.connect()); }
    catch (caught) { setError((caught as Error).message); }
  }
  return <div className="app-shell">
    <header className="site-header">
      <div className="header-left">
        <Logo />
        <nav aria-label="Main navigation">
          <Link className={path === '/' || marketId ? 'active' : ''} to="/">Markets</Link>
          <Link className={path === '/portfolio' ? 'active' : ''} to="/portfolio">Portfolio</Link>
        </nav>
      </div>
      <div className="header-actions">
        <Link className="button secondary create-link" to="/create">Create Market</Link>
        {address ? <div className="wallet-wrap">
          <button className="wallet" onClick={() => setWalletOpen((value) => !value)} aria-expanded={walletOpen}>
            <i />{short(address)}
          </button>
          {walletOpen && <button className="wallet-menu" onClick={() => {
            api.disconnect(); setAddress(null); setWalletOpen(false);
          }}>Disconnect</button>}
        </div> : <button className="button primary" onClick={connect}>Connect Wallet</button>}
      </div>
    </header>
    {error && <div className="banner error" role="alert">{error}</div>}
    <main>{path === '/' ? <Markets /> : path === '/create' ? <CreateMarket address={address} /> : path === '/portfolio' ? <PortfolioPage address={address} /> : marketId ? <MarketDetail address={address} id={decodeURIComponent(marketId)} /> : <EmptyState title="Page not found" />}</main>
    <footer>GenLayer Bradbury · On-chain markets custody GEN in a PredictionMarket contract; markets marked SIMULATION are API-ledger only · All times shown in UTC</footer>
  </div>;
}

function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return <div className="empty-state"><h2>{title}</h2>{detail && <p>{detail}</p>}<Link className="button secondary" to="/">Return to markets</Link></div>;
}

function Status({ status }: { status: string }) {
  return <span className={`status status-${status}`}>{statusLabel[status] || titleCase(status)}</span>;
}

function MarketActions({ market }: { market: Market }) {
  return <div className="quick-trade" aria-label={`Prices for ${market.title}`}>
    <span className="yes">Yes {market.probability.toFixed(2)} GEN</span>
    <span className="no">No {(1 - market.probability).toFixed(2)} GEN</span>
  </div>;
}

function Sparkline({ market }: { market: Market }) {
  const series = market.priceSeries || [];
  if (series.length < 2) return <div className="history-placeholder"><span>—</span><small>No fills</small></div>;
  const values = series.map((point) => point.p); const min = Math.min(...values); const max = Math.max(...values); const spread = Math.max(max - min, .01);
  const points = values.map((value, index) => `${index * 100 / (values.length - 1)},${28 - (value - min) * 24 / spread}`).join(' ');
  return <svg className="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="Recorded CPMM price movement"><polyline points={points} /></svg>;
}

function MarketRow({ market }: { market: Market }) {
  return <div className="market-row">
    <Link className="market-name" to={`/markets/${market.id}`}>
      <span className={`market-dot status-${market.status}`} />
      <strong>{market.title}</strong>
      <small>{market.category} · {marketTypeLabel[market.type]} · closes {utc(market.closesAt)}</small>
      <SettlementBadge market={market} />
    </Link>
    <Sparkline market={market} />
    <div className="probability-cell">
      <strong>{Math.round(market.probability * 100)}%</strong>
      <div className="probability-bar"><i style={{ width: `${market.probability * 100}%` }} /></div>
    </div>
    <MarketActions market={market} />
    <div className="volume-cell"><strong>{compactMoney(market.volume)}</strong><small>liq {compactMoney(market.liquidity)}</small></div>
    <div className="status-cell"><Status status={market.status} /></div>
  </div>;
}

function MarketCard({ market }: { market: Market }) {
  return <div className="market-card">
    <Link to={`/markets/${market.id}`}>
      <div className="row"><small>{market.category} · {marketTypeLabel[market.type]}</small><SettlementBadge market={market} /><Status status={market.status} /></div>
      <h2>{market.title}</h2>
    </Link>
    <strong className="mobile-prob">{Math.round(market.probability * 100)}%</strong>
    <MarketActions market={market} />
    <div className="card-meta"><span>Vol {compactMoney(market.volume)}</span><span>Liq {compactMoney(market.liquidity)}</span><span>{utc(market.closesAt)}</span></div>
  </div>;
}

function Markets() {
  const [items, setItems] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'all' | MarketType>('all');
  const [status, setStatus] = useState('all');
  useEffect(() => {
    api.markets().then((value) => setItems(value.items)).catch((caught) => setError(caught.message)).finally(() => setLoading(false));
  }, []);
  const visible = useMemo(() => items.filter((market) => {
    const matchesQuery = `${market.title} ${market.category}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (type === 'all' || market.type === type) && (status === 'all' || market.status === status);
  }), [items, query, type, status]);
  const countType = (value: MarketType) => items.filter((market) => market.type === value).length;
  const settlement = items.filter((market) => ['closed', 'preliminary', 'challenge_window', 'disputed'].includes(market.status)).slice(0, 3);
  return <div className="markets-layout">
    <aside className="filter-sidebar">
      <FilterGroup label="Views">
        <button className={status === 'all' ? 'selected' : ''} onClick={() => setStatus('all')}><span>All markets</span><b>{items.length}</b></button>
        <button className={status === 'trading' ? 'selected' : ''} onClick={() => setStatus('trading')}><span>Trading</span><b>{items.filter((m) => m.status === 'trading').length}</b></button>
        <button className={status === 'challenge_window' ? 'selected' : ''} onClick={() => setStatus('challenge_window')}><span>Challenge window</span><b>{items.filter((m) => m.status === 'challenge_window').length}</b></button>
        <button className={status === 'disputed' ? 'selected' : ''} onClick={() => setStatus('disputed')}><span>Disputed</span><b>{items.filter((m) => m.status === 'disputed').length}</b></button>
      </FilterGroup>
      <FilterGroup label="Market type">
        <button className={type === 'all' ? 'selected' : ''} onClick={() => setType('all')}><span>All types</span><b>{items.length}</b></button>
        {(['deterministic', 'structured', 'judgment'] as MarketType[]).map((value) => <button key={value} className={type === value ? 'selected' : ''} onClick={() => setType(value)}><span>{marketTypeLabel[value]}</span><b>{countType(value)}</b></button>)}
      </FilterGroup>
      <div className="info-panel"><h3>How resolution works</h3><p><b>01</b> Fixed sources are locked.</p><p><b>02</b> GenLayer validators resolve.</p><p><b>03</b> Anyone may challenge.</p></div>
    </aside>
    <section className="market-center">
      <div className="page-heading">
        <div><h1>Markets</h1><p>Every outcome follows a Resolution Spec locked at creation and verified by GenLayer consensus.</p></div>
        <div className="market-tools">
          <label className="sr-only" htmlFor="market-search">Search markets</label>
          <input id="market-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search markets…" />
          <select aria-label="Filter market status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option><option value="trading">Trading</option><option value="draft">Draft</option><option value="closed">Closed</option><option value="challenge_window">Challenge window</option><option value="disputed">Disputed</option><option value="resolved_yes">Resolved YES</option><option value="resolved_no">Resolved NO</option><option value="void">Void</option>
          </select>
        </div>
      </div>
      <div className="global-stats">
        <Stat label="Markets" value={String(items.length)} />
        <Stat label="Trading" value={String(items.filter((m) => m.status === 'trading').length)} accent />
        <Stat label="Volume" value={compactMoney(items.reduce((sum, m) => sum + m.volume, 0))} />
        <Stat label="Liquidity" value={compactMoney(items.reduce((sum, m) => sum + m.liquidity, 0))} />
      </div>
      <div className="mobile-type-chips">
        <button className={type === 'all' ? 'selected' : ''} onClick={() => setType('all')}>All</button>
        {(['deterministic', 'structured', 'judgment'] as MarketType[]).map((value) => <button key={value} className={type === value ? 'selected' : ''} onClick={() => setType(value)}>{marketTypeLabel[value]}</button>)}
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {loading ? <div className="skeleton-list">{[1, 2, 3, 4].map((value) => <i key={value} />)}</div> : visible.length ? <>
        <div className="market-table">
          <div className="market-table-head"><span>Market</span><span>7D</span><span>Probability</span><span>Trade</span><span>Volume</span><span>Status</span></div>
          {visible.map((market) => <MarketRow market={market} key={market.id} />)}
        </div>
        <div className="market-cards">{visible.map((market) => <MarketCard market={market} key={market.id} />)}</div>
      </> : <div className="empty-state"><h2>No markets match your filters</h2><button className="button secondary" onClick={() => { setQuery(''); setType('all'); setStatus('all'); }}>Reset filters</button></div>}
    </section>
    <aside className="right-rail">
      <div className="rail-card"><div className="rail-title"><h3>Settlement queue</h3><span>{settlement.length} ACTIVE</span></div>{settlement.length ? settlement.map((market) => <Link className="queue-item" to={`/markets/${market.id}`} key={market.id}><strong>{market.title}</strong><span>{statusLabel[market.status] || titleCase(market.status)}</span></Link>) : <p className="muted">No markets are settling.</p>}</div>
      <div className="rail-card"><div className="rail-title"><h3>Resolution model</h3></div><div className="protocol-line"><span>Network</span><b>Bradbury testnet</b></div><div className="protocol-line"><span>Outcomes</span><b>YES · NO · VOID</b></div><div className="protocol-line"><span>Evidence</span><b>Hash locked</b></div></div>
      <div className="rail-note"><b>Three levels. One judge.</b><p>Numeric feeds, structured facts and interpretation all settle from immutable specifications.</p></div>
    </aside>
  </div>;
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="filter-group"><h3>{label}</h3>{children}</div>;
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div><span>{label}</span><strong className={accent ? 'accent' : ''}>{value}</strong></div>;
}

function ResolverBinder({ market, address, onBound, onMessage }: { market: Market; address: string | null; onBound: () => Promise<void>; onMessage: (value: string) => void }) {
  const [resolver, setResolver] = useState(''); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState('');
  async function deployAndBind() {
    if (!address) return onMessage('Connect the creator wallet first');
    setBusy(true);
    try {
      const { deployMarketResolver } = await import('./genlayer');
      const deployment = await deployMarketResolver(market, address, setProgress);
      const bound = await api.bindResolver(market.id, deployment.contractAddress);
      // A second instance of the same resolver over the same locked spec. The
      // market contract will not deploy without an adjudicator to appeal to.
      setProgress('Resolver verified. Confirm the dispute resolver deployment in MetaMask…');
      const adjudicator = await deployMarketResolver(market, address, setProgress);
      const { deployPredictionMarket } = await import('./market');
      const deployed = await deployPredictionMarket(bound, address, adjudicator.contractAddress, setProgress);
      await api.bindMarketContract(bound.id, deployed.contractAddress, deployed.transactionHash);
      await onBound(); setProgress('Resolver and market contract verified. Trading is open on Bradbury.'); onMessage('Market is live on GenLayer Bradbury.');
    } catch (caught) { setProgress(''); onMessage((caught as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel bind-panel"><h2>Deploy market resolver</h2><p>This immutable draft will deploy <b>{market.resolutionSpec.resolver?.contract}</b> twice — once as the resolver, once as the dispute resolver a challenge appeals to — and then its <b>PredictionMarket</b> bound to both. Three MetaMask confirmations are required.</p><button className="button primary" disabled={busy || !address} onClick={deployAndBind}>{busy ? 'Deployment in progress…' : 'Deploy with MetaMask'}</button>{progress && <p className="progress-message" role="status">{progress}</p>}<details><summary>Advanced: bind an existing deployment</summary><pre>{JSON.stringify({ marketBinding: { marketId: market.id, resolutionSpecHash: market.resolutionSpecHash, sourcesHash: market.sourcesHash, observationTime: market.resolutionSpec.observationTime }, resolverConfig: { question: market.title, ...market.resolutionSpec.resolver?.args } }, null, 2)}</pre><form onSubmit={async (event) => {
    event.preventDefault(); if (!address) return onMessage('Connect the creator wallet first');
    try { await api.bindResolver(market.id, resolver); await onBound(); onMessage('Resolver verified and bound. Trading is open.'); }
    catch (caught) { onMessage((caught as Error).message); }
  }}><label>Finalized resolver address<input value={resolver} onChange={(event) => setResolver(event.target.value)} pattern="0x[a-fA-F0-9]{40}" required /></label><button className="button secondary">Verify and bind</button></form></details></section>;
}

/**
 * Attach a PredictionMarket that was deployed but never bound.
 *
 * Bradbury takes about fifteen minutes to finalize a deployment. Whenever the
 * browser stopped waiting first — a timeout, a closed tab, a reload — the
 * contract existed and was paid for, but nothing recorded it, so the market
 * stayed a simulation and its trades quietly went to the API ledger instead of
 * to chain. That is the one failure here a creator cannot see: the fill message
 * looks identical. This panel exists so the answer is "bind it", never "deploy
 * it again" — a second deployment spends GEN to create a rival contract holding
 * the same market's collateral.
 */
function MarketContractBinder({ market, onBound, onMessage }: { market: Market; onBound: () => Promise<void>; onMessage: (value: string) => void }) {
  const [value, setValue] = useState(''); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState('');
  async function bind(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const entered = value.trim();
      const { marketContractFromDeployment } = await import('./market');
      // Either identifier works: a hash is looked up on chain, an address is
      // taken as given. The API re-verifies the contract against this market's
      // locked binding either way, so a wrong one is refused rather than trusted.
      let contractAddress = entered, transactionHash = '';
      if (/^0x[a-fA-F0-9]{64}$/.test(entered)) {
        setProgress('Reading the deployment back from Bradbury…');
        ({ contractAddress, transactionHash } = await marketContractFromDeployment(entered));
      } else if (!/^0x[a-fA-F0-9]{40}$/.test(entered)) {
        throw new Error('Enter the deployment transaction hash (0x, 64 hex) or the contract address (0x, 40 hex)');
      }
      setProgress(`Verifying ${contractAddress} against the locked binding…`);
      await api.bindMarketContract(market.id, contractAddress, transactionHash);
      await onBound(); setProgress(''); onMessage(`Market contract ${contractAddress} bound. Trading is on Bradbury now.`);
    } catch (caught) { setProgress(''); onMessage((caught as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel bind-panel"><h2>Bind an existing market contract</h2><p>This market has a bound resolver but no <b>PredictionMarket</b>, so it is trading as a <b>simulation</b> and its fills move no GEN. If you already deployed one and the browser stopped waiting before Bradbury finalized it — that takes about fifteen minutes — attach it here rather than deploying a second one.</p><form onSubmit={bind}><label>Deployment transaction hash or contract address<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="0x…" required /></label><button className="button primary" disabled={busy}>{busy ? 'Verifying…' : 'Verify and bind'}</button></form>{progress && <p className="progress-message" role="status">{progress}</p>}</section>;
}

function ResolvePanel({ market, address, onDone, onMessage }: { market: Market; address: string | null; onDone: () => Promise<void>; onMessage: (value: string) => void }) {
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState('');
  async function resolve() {
    if (!address) return onMessage('Connect a wallet to pay the GenLayer transaction fee');
    setBusy(true);
    try {
      const { resolveOnGenLayer } = await import('./genlayer');
      const proof = await resolveOnGenLayer(market, address, setProgress);
      await api.publishResolution(market.id, proof);
      await onDone(); setProgress('Verified preliminary result published. Challenge window is open.'); onMessage('GenLayer result verified by the API.');
    } catch (caught) { setProgress(''); onMessage((caught as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel resolve-panel"><h2>Resolve with GenLayer</h2><p>The observation time has passed. Validators will independently read the three locked sources and reach consensus; the API accepts only the finalized transaction proof.</p><button className="button primary" disabled={busy || !address} onClick={resolve}>{busy ? 'Resolution in progress…' : 'Resolve on Bradbury'}</button>{progress && <p className="progress-message" role="status">{progress}</p>}</section>;
}

function ChallengePanel({ market, address, onDone, onMessage }: { market: Market; address: string | null; onDone: () => Promise<void>; onMessage: (value: string) => void }) {
  const [reason, setReason] = useState(''); const [stake, setStake] = useState(0.1);
  return <section className="panel challenge-panel"><h2>Challenge preliminary {market.preliminaryOutcome}</h2><p>Window closes {market.challengeWindowClosesAt && utc(market.challengeWindowClosesAt)}. Minimum stake: 0.1 GEN.</p><form onSubmit={async (event) => {
    event.preventDefault(); if (!address) return onMessage('Connect your wallet first');
    try { await api.challenge({ marketId: market.id, reason, stakeAmount: stake }); await onDone(); onMessage('Challenge submitted for expanded GenLayer review.'); }
    catch (caught) { onMessage((caught as Error).message); }
  }}><label>Evidence-based reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} required /></label><label>Stake (GEN)<input type="number" min="0.1" step="0.01" value={stake} onChange={(event) => setStake(Number(event.target.value))} required /></label><button className="button amber">Submit challenge</button></form></section>;
}

function LiquidityPanel({ market, address, portfolio, onDone, onMessage }: { market: Market; address: string | null; portfolio: Portfolio | null; onDone: () => Promise<void>; onMessage: (value: string) => void }) {
  const [amount, setAmount] = useState(1); const [action, setAction] = useState<'deposit' | 'withdraw'>('deposit');
  const owned = portfolio?.liquidityPositions?.find((lp) => lp.marketId === market.id && lp.status === 'open')?.shares || 0;
  return <section className="panel liquidity-panel"><h2>Liquidity</h2><form onSubmit={async (event) => {
    event.preventDefault(); if (!address) return onMessage('Connect your wallet first');
    try { await api.liquidity({ marketId: market.id, amount, action }); await onDone(); onMessage(`Liquidity ${action} completed in the simulation ledger.`); }
    catch (caught) { onMessage((caught as Error).message); }
  }}><label>Action<select value={action} onChange={(event) => setAction(event.target.value as 'deposit' | 'withdraw')}><option value="deposit">Deposit GEN</option><option value="withdraw">Withdraw LP shares</option></select></label><label>{action === 'deposit' ? 'GEN amount' : `LP shares (available ${owned.toFixed(4)})`}<input type="number" min="0.01" max={action === 'withdraw' ? owned : undefined} value={amount} onChange={(event) => setAmount(Number(event.target.value))} required /></label><button className="button secondary">Update liquidity</button></form></section>;
}

// genlayer-js and viem are only needed once a market actually settles on chain,
// so the whole on-chain panel is a separate chunk the markets list never loads.
const OnChainPanel = React.lazy(() => import('./onchain'));
const isOnChain = (market: Market) => market.settlement === 'onchain' && Boolean(market.marketContractAddress);

function SettlementBadge({ market }: { market: Market }) {
  return isOnChain(market)
    ? <span className="settlement-badge onchain" title={`PredictionMarket ${market.marketContractAddress}`}>ON-CHAIN · BRADBURY</span>
    : <span className="settlement-badge simulation" title="Balances live in the API ledger; no GEN moves">SIMULATION</span>;
}

type DetailTab = 'overview' | 'spec' | 'sources' | 'settlement' | 'activity';
function MarketDetail({ address, id }: { address: string | null; id: string }) {
  const [market, setMarket] = useState<Market | null>(null); const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [side, setSide] = useState<Side>('YES'); const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState(0.1); const [quote, setQuote] = useState<Quote | null>(null); const [message, setMessage] = useState(''); const [tab, setTab] = useState<DetailTab>('overview');
  const load = async () => { setMarket(await api.market(id)); if (address) setPortfolio(await api.portfolio(address)); else setPortfolio(null); };
  useEffect(() => { load().catch((caught) => setMessage(caught.message)); }, [id, address]);
  useEffect(() => {
    setQuote(null); if (!market || amount <= 0 || market.status !== 'trading') return;
    const timer = setTimeout(() => api.quote(id, side, amount, action).then(setQuote).catch((caught) => setMessage(caught.message)), 250);
    return () => clearTimeout(timer);
  }, [id, side, action, amount, market?.probability, market?.status]);
  async function submitTrade() {
    if (!address || !quote) return setMessage('Connect your wallet first');
    try {
      setMessage('Submitting to the simulation ledger…');
      await api.trade({ marketId: id, side, action, amount, minSharesOut: action === 'buy' ? quote.shares * .99 : undefined, minAmountOut: action === 'sell' ? (quote.amountOut || 0) * .99 : undefined, deadline: new Date(Date.now() + 60_000).toISOString() });
      await load(); setMessage('Trade filled at the quoted CPMM price.');
    } catch (caught) { setMessage((caught as Error).message); }
  }
  if (!market) return <div className="empty-state"><h2>{message || 'Loading market…'}</h2></div>;
  const owned = portfolio?.positions.find((position) => position.marketId === id && position.side === side && position.status === 'open')?.shares || 0;
  return <section className="detail-page">
    <Link className="back-link" to="/">← All markets</Link>
    <div className="detail-hero">
      <div><div className="detail-kicker"><Status status={market.status} /><SettlementBadge market={market} /><span>{market.category}</span><span>{marketTypeLabel[market.type]}</span></div><h1>{market.title}</h1></div>
      <div className="detail-price"><strong>{Math.round(market.probability * 100)}%</strong><span>YES probability</span></div>
    </div>
    <div className="detail-metrics"><Stat label="Volume" value={compactMoney(market.volume)} /><Stat label="Liquidity" value={compactMoney(market.liquidity)} /><Stat label="Traders" value={String(market.traderCount || 0)} /><Stat label="Fee" value={`${market.feeBps / 100}%`} /><Stat label="Closes" value={utc(market.closesAt)} /></div>
    <div className="detail-layout">
      <article className="detail-content">
        <div className="detail-tabs" role="tablist">{([['overview', 'Overview'], ['spec', 'Resolution Spec'], ['sources', 'Sources'], ['settlement', 'Settlement'], ['activity', 'Recent fills']] as [DetailTab, string][]).map(([value, label]) => <button role="tab" aria-selected={tab === value} key={value} onClick={() => setTab(value)}>{label}</button>)}</div>
        {tab === 'overview' && <><section className="panel"><h2>Market overview</h2><p className="lead">{market.resolutionSpec.summary}</p><div className="criteria"><span>Resolution criteria</span>{market.resolutionSpec.criteria.map((criterion, index) => <p key={index}><b>{String(index + 1).padStart(2, '0')}</b>{criterion}</p>)}</div></section><section className="panel"><h2>Market constitution</h2><dl className="spec-list"><div><dt>Observation time</dt><dd>{utc(market.resolutionSpec.observationTime || market.closesAt)}</dd></div><div><dt>Tie-break</dt><dd>VOID</dd></div><div><dt>Unavailable data</dt><dd>VOID under the locked specification</dd></div></dl></section></>}
        {tab === 'spec' && <section className="panel"><h2>Locked Resolution Spec</h2><p>{market.resolutionSpec.summary}</p><dl className="spec-list"><div><dt>Resolution hash</dt><dd className="mono">{market.resolutionSpecHash || 'Legacy market'}</dd></div><div><dt>Sources hash</dt><dd className="mono">{market.sourcesHash || 'Legacy market'}</dd></div><div><dt>Resolver class</dt><dd>{market.resolutionSpec.resolver?.contract || marketTypeLabel[market.type]}</dd></div></dl><pre>{JSON.stringify(market.resolutionSpec, null, 2)}</pre></section>}
        {tab === 'sources' && <section className="panel"><h2>Locked sources</h2><div className="source-list">{market.sources.map((source, index) => <div key={`${source.url}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><p><a href={source.url} target="_blank" rel="noreferrer">{source.name}</a><small>{source.url}</small>{source.contentHash && <small className="mono">Snapshot {source.contentHash}</small>}</p></div>)}</div></section>}
        {tab === 'settlement' && <section className="panel"><h2>Settlement state</h2><dl className="spec-list"><div><dt>Current stage</dt><dd><Status status={market.status} /></dd></div><div><dt>Preliminary outcome</dt><dd>{market.preliminaryOutcome || 'Not published'}</dd></div><div><dt>Final outcome</dt><dd>{market.outcome || 'Not finalized'}</dd></div><div><dt>Resolver</dt><dd className="mono">{market.resolverContractAddress || 'Not bound'}</dd></div><div><dt>Market contract</dt><dd className="mono">{market.marketContractAddress || 'Not deployed — this market is a simulation'}</dd></div><div><dt>Deployment tx</dt><dd className="mono">{market.marketDeploymentTx || '—'}</dd></div>{market.challengeWindowClosesAt && <div><dt>Challenge deadline</dt><dd>{utc(market.challengeWindowClosesAt)}</dd></div>}</dl></section>}
        {tab === 'activity' && <section className="panel"><h2>Recorded CPMM fills</h2><p>These rows are derived from accepted ledger trades, not generated UI statistics.</p><div className="fills-list">{market.recentTrades?.length ? market.recentTrades.map((trade) => <div key={trade.id}><b className={trade.side.toLowerCase()}>{trade.type.toUpperCase()} {trade.side}</b><span>{trade.shares.toFixed(4)} shares</span><span>{trade.price.toFixed(4)} GEN</span><span>{short(trade.trader)}</span><time>{utc(trade.timestamp)}</time></div>) : <p className="muted">No fills yet.</p>}</div></section>}
        {market.status === 'draft' && <ResolverBinder market={market} address={address} onBound={load} onMessage={setMessage} />}
        {market.status !== 'draft' && market.resolverContractAddress && !market.marketContractAddress
          && address && market.creator?.toLowerCase() === address.toLowerCase()
          && <MarketContractBinder market={market} onBound={load} onMessage={setMessage} />}
        {!isOnChain(market) && <>
          {market.status === 'closed' && market.resolverContractAddress && <ResolvePanel market={market} address={address} onDone={load} onMessage={setMessage} />}
          {market.status === 'challenge_window' && <ChallengePanel market={market} address={address} onDone={load} onMessage={setMessage} />}
          {market.status === 'trading' && <LiquidityPanel market={market} address={address} portfolio={portfolio} onDone={load} onMessage={setMessage} />}
        </>}
      </article>
      {isOnChain(market) ? <React.Suspense fallback={<aside className="trade-panel"><p className="quote-loading">Loading on-chain trading…</p></aside>}><OnChainPanel market={market} address={address} onMessage={setMessage} /></React.Suspense> : <aside className="trade-panel">
        <div className="ledger-label">SIMULATION LEDGER · NO GEN MOVES</div>
        <div className="trade-tabs"><button aria-pressed={action === 'buy'} onClick={() => setAction('buy')}>Buy</button><button aria-pressed={action === 'sell'} onClick={() => setAction('sell')}>Sell</button></div>
        <div className="trade-sides"><button className="yes" aria-pressed={side === 'YES'} onClick={() => setSide('YES')}><span>YES</span><b>{market.probability.toFixed(2)} GEN</b></button><button className="no" aria-pressed={side === 'NO'} onClick={() => setSide('NO')}><span>NO</span><b>{(1 - market.probability).toFixed(2)} GEN</b></button></div>
        <label>{action === 'buy' ? 'Amount (GEN)' : 'Shares to sell'}<div className="amount-input"><input type="number" min="0" step="0.01" value={amount} max={action === 'sell' ? owned : undefined} onChange={(event) => setAmount(Number(event.target.value))} /><span>{action === 'buy' ? 'GEN' : 'SHARES'}</span></div></label>
        {action === 'sell' && <p className="muted">Available: {owned.toFixed(4)} shares</p>}
        {quote ? <dl className="quote"><div><dt>{action === 'buy' ? 'Estimated shares' : 'Minimum received'}</dt><dd>{action === 'buy' ? quote.shares.toFixed(4) : money((quote.amountOut || 0) * .99)}</dd></div><div><dt>AMM fee</dt><dd>{money(quote.fee)}</dd></div><div><dt>Average price</dt><dd>{quote.avgPrice.toFixed(4)} GEN</dd></div><div><dt>Price impact</dt><dd>{(quote.priceImpact * 100).toFixed(2)}%</dd></div><div><dt>Slippage limit</dt><dd>1.00%</dd></div></dl> : <p className="quote-loading">{market.status === 'trading' ? 'Fetching exact CPMM quote…' : 'Trading is not open'}</p>}
        <button className={`button wide ${side === 'YES' ? 'yes-button' : 'no-button'}`} disabled={!quote || market.status !== 'trading'} onClick={submitTrade}>{action === 'buy' ? `Buy ${side}` : `Sell ${side}`}</button>
        {message && <p className="trade-message" role="status">{message}</p>}
        {market.poolDepth && <div className="pool-depth"><strong>CPMM pool depth</strong><div><span>YES reserve</span><b>{market.poolDepth.yesReserve.toFixed(4)}</b></div><div><span>NO reserve</span><b>{market.poolDepth.noReserve.toFixed(4)}</b></div><div><span>Collateral</span><b>{market.poolDepth.collateral.toFixed(4)} GEN</b></div></div>}
        <div className="trade-foot"><span>CPMM execution</span><span>1 min deadline</span></div>
      </aside>}
    </div>
  </section>;
}

function PortfolioPage({ address }: { address: string | null }) {
  const [data, setData] = useState<Portfolio | null>(null); const [message, setMessage] = useState('');
  const load = () => address ? api.portfolio(address).then(setData).catch((caught) => setMessage(caught.message)) : Promise.resolve();
  useEffect(() => { load(); }, [address]);
  if (!address) return <section className="content-page"><h1>Portfolio</h1><div className="empty-state"><h2>Connect your wallet</h2><p>A full Ethereum address is required to load positions.</p></div></section>;
  return <section className="content-page"><div className="page-heading"><div><h1>Portfolio</h1><p className="mono">{address}</p></div></div>{data && <>
    <div className="portfolio-stats"><Stat label="Portfolio value" value={money(data.totalValue)} /><Stat label="Total P&L" value={money(data.totalPnl)} accent /><Stat label="Active positions" value={String(data.positions.filter((position) => position.status === 'open').length)} /><Stat label="Wallet" value={short(address)} /></div>
    <h2>Market positions</h2><div className="position-table"><div className="position-head"><span>Market</span><span>Side</span><span>Shares</span><span>Average</span><span>Now</span><span>Status</span><span /></div>{data.positions.map((position) => <div className="position-row" key={position.id}><Link to={`/markets/${position.marketId}`}>{position.marketId}</Link><b className={position.side.toLowerCase()}>{position.side}</b><span>{position.shares.toFixed(4)}</span><span>{position.avgPrice.toFixed(4)} GEN</span><span>{position.currentPrice.toFixed(4)} GEN</span><span>{titleCase(position.status)}</span>{['claimable', 'refundable'].includes(position.status) ? <button onClick={async () => { try { await api.claim(position.marketId); await load(); } catch (caught) { setMessage((caught as Error).message); } }}>Claim</button> : <span />}</div>)}</div>
    <h2>Liquidity positions</h2><div className="position-table"><div className="position-head lp"><span>Market</span><span>Type</span><span>LP shares</span><span>Status</span><span /></div>{(data.liquidityPositions || []).map((position) => <div className="position-row lp" key={position.marketId}><Link to={`/markets/${position.marketId}`}>{position.marketId}</Link><b>LP</b><span>{position.shares.toFixed(4)}</span><span>{titleCase(position.status)}</span>{position.status === 'claimable' ? <button onClick={async () => { try { await api.claimLp(position.marketId); await load(); } catch (caught) { setMessage((caught as Error).message); } }}>Claim LP</button> : <span />}</div>)}</div>
  </>}{message && <div className="banner error" role="alert">{message}</div>}</section>;
}

const emptySource = (): Source => ({ name: '', url: '', jsonPath: '', timestampPath: '', timestampValue: '' });
function CreateMarket({ address }: { address: string | null }) {
  const [type, setType] = useState<MarketType>('deterministic'); const [sources, setSources] = useState<Source[]>([emptySource(), emptySource(), emptySource()]); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [draftId, setDraftId] = useState('');
  const [values, setValues] = useState({ title: '', category: 'Other', closesAt: '', liquidity: '10', summary: '', criterion: '' });
  const update = (index: number, key: keyof Source, value: string) => setSources((current) => current.map((source, sourceIndex) => sourceIndex === index ? { ...source, [key]: value } : source));
  const setValue = (key: keyof typeof values, value: string) => setValues((current) => ({ ...current, [key]: value }));
  function loadDemoTemplate() {
    const observation = new Date(Date.now() + 30 * 60_000); observation.setUTCSeconds(0, 0);
    setType('structured'); setDraftId(''); setMessage('Demo template loaded. Observation is 30 minutes from now; adjust it if needed.');
    setValues({
      title: 'At the locked observation time, is the latest stable genlayer-js version 1.1.8 or newer?',
      category: 'Technology', closesAt: observation.toISOString().slice(0, 16), liquidity: '10',
      summary: 'Resolves from three independently hosted package and release endpoints at the locked UTC observation time.',
      criterion: 'For each source: YES only if it explicitly reports the current or latest stable genlayer-js version as semantic version 1.1.8 or newer; NO only if it explicitly reports a lower version; otherwise VOID. The market resolves YES or NO only with at least two matching source votes, otherwise VOID.',
    });
    setSources([
      { name: 'npm registry', url: 'https://registry.npmjs.org/genlayer-js/latest' },
      { name: 'GitHub latest release', url: 'https://api.github.com/repos/genlayerlabs/genlayer-js/releases/latest' },
      { name: 'jsDelivr package metadata', url: 'https://data.jsdelivr.com/v1/package/npm/genlayer-js' },
    ]);
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!address) return setMessage('Connect your wallet first');
    const form = new FormData(event.currentTarget); const closesAt = new Date(`${String(form.get('closesAt'))}:00Z`).toISOString();
    setBusy(true); setDraftId('');
    try {
      const result = await api.create({ marketId: crypto.randomUUID().replaceAll('-', ''), title: form.get('title'), category: form.get('category'), type, closesAt, initialLiquidity: Number(form.get('liquidity')), resolverNetwork: 'testnetBradbury', resolutionSpec: { summary: form.get('summary'), criteria: [form.get('criterion')], tieBreak: 'VOID', unavailableRule: 'VOID unless all three locked sources agree under the rule' }, sources, numeric: type === 'deterministic' ? { comparator: form.get('comparator'), scale: Number(form.get('scale')), thresholdUnits: Number(form.get('threshold')), maxSourceSpreadUnits: Number(form.get('spread')) } : undefined, criterion: type === 'structured' ? form.get('criterion') : undefined, interpretationRule: type === 'judgment' ? form.get('criterion') : undefined });
      setDraftId(result.market.id); setMessage('Draft and hashes locked. Confirm the resolver deployment in MetaMask…');
      const { deployMarketResolver } = await import('./genlayer');
      const deployment = await deployMarketResolver(result.market, address, setMessage);
      const bound = await api.bindResolver(result.market.id, deployment.contractAddress);
      // The adjudicator: the same resolver over the same locked spec, deployed a
      // second time so a challenge has a fresh consensus round to appeal to. The
      // market contract refuses to deploy without one.
      setMessage('Resolver verified. Confirm the dispute resolver deployment in MetaMask…');
      const adjudicator = await deployMarketResolver(result.market, address, setMessage);
      setMessage('Dispute resolver deployed. Confirm the PredictionMarket deployment in MetaMask…');
      const { deployPredictionMarket } = await import('./market');
      const deployed = await deployPredictionMarket(bound, address, adjudicator.contractAddress, setMessage);
      await api.bindMarketContract(bound.id, deployed.contractAddress, deployed.transactionHash);
      go(`/markets/${bound.id}`);
    } catch (caught) { setMessage((caught as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="create-page"><div className="page-heading"><div><h1>Create a market</h1><p>Lock the immutable spec, then deploy its resolver and its GEN-custody PredictionMarket to Bradbury in one flow.</p></div><button className="button demo-button" type="button" onClick={loadDemoTemplate}>Load evaluation demo</button></div><form className="create-form" onSubmit={submit}>
    <div className="form-section"><div className="section-number">01</div><div><h2>Market basics</h2><div className="form-grid"><label className="full">Market question<input name="title" value={values.title} onChange={(event) => setValue('title', event.target.value)} placeholder="Will…?" required /></label><label>Category<input name="category" value={values.category} onChange={(event) => setValue('category', event.target.value)} required /></label><label>Close / observation time (UTC)<input name="closesAt" type="datetime-local" value={values.closesAt} onChange={(event) => setValue('closesAt', event.target.value)} required /></label><label>Initial liquidity (GEN)<input name="liquidity" type="number" min="1" step="0.1" value={values.liquidity} onChange={(event) => setValue('liquidity', event.target.value)} required /></label></div></div></div>
    <div className="form-section"><div className="section-number">02</div><div><h2>Market class</h2><div className="type-selector">{(['deterministic', 'structured', 'judgment'] as MarketType[]).map((value, index) => <button type="button" className={type === value ? 'selected' : ''} key={value} onClick={() => setType(value)}><b>Level {index + 1}</b><strong>{marketTypeLabel[value]}</strong><span>{value === 'deterministic' ? 'Numeric feeds and thresholds' : value === 'structured' ? 'Discrete, verifiable web facts' : 'Text interpreted against a rule'}</span></button>)}</div></div></div>
    <div className="form-section"><div className="section-number">03</div><div><h2>Resolution constitution</h2><label>Resolution summary<textarea name="summary" value={values.summary} onChange={(event) => setValue('summary', event.target.value)} placeholder="Resolves YES if…" required /></label><label>{type === 'judgment' ? 'Locked interpretation rule' : 'Locked criterion'}<textarea name="criterion" value={values.criterion} onChange={(event) => setValue('criterion', event.target.value)} required /></label>{type === 'deterministic' && <fieldset><legend>Numeric rule</legend><div className="form-grid"><label>Comparator<select name="comparator"><option>GTE</option><option>GT</option><option>LTE</option><option>LT</option></select></label><label>Scale<input name="scale" type="number" min="1" defaultValue="100" required /></label><label>Threshold units<input name="threshold" type="number" step="1" required /></label><label>Maximum source spread units<input name="spread" type="number" min="0" step="1" defaultValue="100" required /></label></div></fieldset>}</div></div>
    <div className="form-section"><div className="section-number">04</div><div><h2>Exactly three fixed sources</h2><p>Sources are hashed and cannot be replaced after creation.</p><div className="sources-grid">{sources.map((source, index) => <fieldset className="source-card" key={index}><legend>Source {index + 1}</legend><label>Name<input value={source.name} onChange={(event) => update(index, 'name', event.target.value)} required /></label><label>URL<input type="url" value={source.url} onChange={(event) => update(index, 'url', event.target.value)} required /></label>{type === 'deterministic' && <><label>Value JSON path<input value={source.jsonPath || ''} onChange={(event) => update(index, 'jsonPath', event.target.value)} required /></label><label>Timestamp JSON path<input value={source.timestampPath || ''} onChange={(event) => update(index, 'timestampPath', event.target.value)} required /></label><label>Locked timestamp value<input value={source.timestampValue || ''} onChange={(event) => update(index, 'timestampValue', event.target.value)} required /></label></>}</fieldset>)}</div></div></div>
    <div className="create-submit"><p>{address ? `Creator ${short(address)} · Bradbury gas paid in GEN` : 'Connect the creator wallet before submitting.'}</p><button className="button primary" type="submit" disabled={busy}>{busy ? 'Creating and deploying…' : 'Create + deploy resolver'}</button></div>{message && <div className="creation-status" role="status">{message}{draftId && <><br /><Link to={`/markets/${draftId}`}>Open recoverable draft →</Link></>}</div>}
  </form></section>;
}

function App() {
  const [address, setAddress] = useState<string | null>(api.address()); const [path, setPath] = useState(location.pathname);
  useEffect(() => { const update = () => setPath(location.pathname); addEventListener('popstate', update); return () => removeEventListener('popstate', update); }, []);
  return <Layout address={address} setAddress={setAddress} path={path} />;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
