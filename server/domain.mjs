import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalHash, fixedSources } from './canonical.mjs';

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
// A lock older than this belonged to a process that died before releasing it.
const LOCK_STALE_MS = 30_000;

const STAGES = [
  ['market_closed', 'Market closed'], ['preliminary_result', 'Preliminary result published'],
  ['challenge_window', 'Challenge window open'], ['dispute_review', 'Dispute under review'],
  ['final_result', 'Final result recorded'], ['settled', 'Payouts settled'],
];
const FINAL = new Set(['resolved_yes', 'resolved_no', 'void']);
const nowISO = (clock = Date) => new Date(typeof clock.now === 'function' ? clock.now() : Date.now()).toISOString();
const clone = (value) => structuredClone(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const n = (value, digits = 6) => Number(Number(value).toFixed(digits));

export class ApiError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function stagesFor(status, timestamps = {}, wasDisputed = false) {
  const current = { trading: -1, closed: 0, preliminary: 1, challenge_window: 2, disputed: 3,
    resolved_yes: 4, resolved_no: 4, void: 4 }[status] ?? -1;
  return STAGES.filter(([key]) => wasDisputed || key !== 'dispute_review').map(([key, label], index) => ({
    key, label, status: index < current ? 'done' : index === current ? 'current' : 'upcoming',
    timestamp: index <= current ? (timestamps[key] || null) : null,
  }));
}

function seedAmm(market) {
  const collateral = Number(market.liquidity) || 10_000;
  const probability = clamp(Number(market.probability) || .5, .001, .999);
  // x*y = k, and price YES = no/(yes+no). The reserves are scaled so the larger
  // of the two equals the collateral: a complete-set CPMM can hand out at most
  // the buyer's own stake plus one reserve, so `max(reserve) <= collateral` is
  // exactly the condition that keeps the book solvent. `PredictionMarket.py`
  // seeds itself the same way; the two must not drift apart.
  const dominant = Math.max(probability, 1 - probability);
  return {
    yesReserve: collateral * (1 - probability) / dominant, noReserve: collateral * probability / dominant,
    collateral, lpShares: collateral, fees: 0, totalYesShares: 0, totalNoShares: 0, refundLiability: 0,
  };
}

/**
 * Everything the collateral must still cover whichever way the market lands, mirroring
 * `BinaryMarket.liability()`. A VOID refunds gross spend, which can exceed the
 * outstanding YES/NO shares, so LP withdrawals have to respect it too.
 */
function liabilityOf(amm) {
  return Math.max((amm.totalYesShares || 0) + (amm.fees || 0), (amm.totalNoShares || 0) + (amm.fees || 0), amm.refundLiability || 0);
}

/**
 * CPMM quote. Exported so the UI can price a trade exactly the way the store fills it.
 *
 * The collateral mints a complete set (one YES + one NO per unit), the trader keeps the
 * side they want and sells the other into the constant-product pool:
 *
 *   shares  = input + outReserve * input / (inReserve + input)
 *
 * The previous `2 * outReserve * input / (inReserve + input)` only agrees with the quoted
 * price at 50/50. At a spot price of 0.91 it handed out 5.5x too few shares, and every
 * test sat at 0.5 so nothing caught it.
 */
export function quoteTrade(amm, market, side, gross) {
  const fee = gross * market.feeBps / 10_000, input = gross - fee;
  const outReserve = side === 'YES' ? amm.yesReserve : amm.noReserve;
  const inReserve = side === 'YES' ? amm.noReserve : amm.yesReserve;
  const fromPool = outReserve * input / (inReserve + input);
  const shares = input + fromPool;
  return { shares, fromPool, fee, input, avgPrice: shares > 0 ? gross / shares : 0 };
}

export function quoteSell(amm, market, side, shares) {
  const outReserve = side === 'YES' ? amm.yesReserve : amm.noReserve;
  const inReserve = side === 'YES' ? amm.noReserve : amm.yesReserve;
  const sum = outReserve + inReserve + shares;
  const discriminant = sum * sum - 4 * inReserve * shares;
  if (discriminant < 0) throw new ApiError('INSUFFICIENT_LIQUIDITY', 'Insufficient liquidity for this sale');
  const gross = (sum - Math.sqrt(discriminant)) / 2;
  const fee = gross * market.feeBps / 10_000;
  return { amountOut: gross - fee, gross, fee, toPool: shares - gross, avgPrice: shares ? (gross - fee) / shares : 0 };
}

export function ensureRuntime(state) {
  state.marketRuntime ||= {};
  state.portfolios ||= {};
  state.challenges ||= [];
  state.liquidityPositions ||= {};
  for (const market of state.markets || []) {
    if (!state.marketRuntime[market.id]) state.marketRuntime[market.id] = { amm: seedAmm(market), timestamps: {}, wasDisputed: Boolean(market.challenge) };
    if (!state.marketRuntime[market.id].amm) state.marketRuntime[market.id].amm = seedAmm(market);
    const amm = state.marketRuntime[market.id].amm;
    amm.refundLiability ??= (amm.totalYesShares || 0) + (amm.totalNoShares || 0);
    market.settlement ||= market.marketContractAddress ? 'onchain' : 'simulation';
    if (!market.priceSeries) market.priceSeries = (market.priceHistory || [market.probability]).map((p, i, values) => ({
      t: new Date(Date.parse(market.createdAt) + (Date.now() - Date.parse(market.createdAt)) * i / Math.max(values.length - 1, 1)).toISOString(), p,
    }));
  }
  return state;
}

const RESOLVER_CONTRACT = { deterministic: 'NumericResolver', structured: 'StructuredFactResolver', judgment: 'JudgmentResolver' };
const COMPARATORS = ['GT', 'GTE', 'LT', 'LTE'];

/**
 * Turns creation input into the exact constructor arguments of the GenLayer resolver for
 * this market type. A market whose spec cannot be expressed this way is not resolvable
 * on chain, so it is rejected at creation rather than discovered at settlement.
 */
function buildResolverSpec(type, input, sources) {
  if (sources.length !== 3) throw new ApiError('SOURCES_REQUIRED', 'Exactly three fixed sources are required; the resolver contracts read source_a, source_b and source_c');
  const urls = sources.map((s) => s.url);
  if (new Set(urls).size !== 3) throw new ApiError('DUPLICATE_SOURCE', 'The three sources must be distinct');
  const contract = RESOLVER_CONTRACT[type];
  if (type === 'deterministic') {
    const numeric = input.numeric || {};
    const paths = sources.map((s) => String(s.jsonPath || '').trim());
    const timestampPaths = sources.map((s) => String(s.timestampPath || '').trim());
    const timestampValues = sources.map((s) => String(s.timestampValue || '').trim());
    if (paths.some((path) => !path)) throw new ApiError('JSON_PATH_REQUIRED', 'Every source of a numeric market needs a jsonPath');
    if (timestampPaths.some((path) => !path)) throw new ApiError('TIMESTAMP_PATH_REQUIRED', 'Every numeric source needs a timestampPath binding it to the observation time');
    if (timestampValues.some((value) => !value)) throw new ApiError('TIMESTAMP_VALUE_REQUIRED', 'Every numeric source needs its locked representation of the observation timestamp');
    if (!COMPARATORS.includes(numeric.comparator)) throw new ApiError('INVALID_COMPARATOR', `comparator must be one of ${COMPARATORS.join(', ')}`);
    const scale = Number(numeric.scale), threshold = Number(numeric.thresholdUnits), spread = Number(numeric.maxSourceSpreadUnits);
    if (!Number.isSafeInteger(scale) || scale <= 0) throw new ApiError('INVALID_SCALE', 'scale must be a positive integer');
    if (!Number.isSafeInteger(threshold)) throw new ApiError('INVALID_THRESHOLD', 'thresholdUnits must be an integer in scaled units');
    if (!Number.isSafeInteger(spread) || spread < 0) throw new ApiError('INVALID_SPREAD', 'maxSourceSpreadUnits must be a non-negative integer');
    return { contract, args: { sources: urls, jsonPaths: paths, timestampPaths, timestampValues, comparator: numeric.comparator, scale, thresholdUnits: threshold, maxSourceSpreadUnits: spread } };
  }
  const rule = String((type === 'structured' ? input.criterion : input.interpretationRule) || '').trim();
  if (!rule) throw new ApiError('RESOLUTION_RULE_REQUIRED', type === 'structured' ? 'A structured market needs a locked criterion' : 'A judgment market needs a locked interpretation rule');
  return { contract, args: { sources: urls, [type === 'structured' ? 'criterion' : 'interpretationRule']: rule } };
}

export class MarketStore {
  constructor({ file, seed, clock = Date, challengeWindowSeconds = 1800 }) {
    this.file = file; this.seed = clone(seed); this.clock = clock; this.challengeWindowSeconds = challengeWindowSeconds;
    this.lockFile = `${file}.lock`;
    this._stamp = null;   // mtime/size of the revision currently held in memory
    this._queue = Promise.resolve();
  }
  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    if (!(await this._load())) {
      this.state = ensureRuntime(clone(this.seed));
      await this.persist();
    }
    return this;
  }
  async _load() {
    try {
      const [raw, info] = await Promise.all([readFile(this.file, 'utf8'), stat(this.file)]);
      this.state = ensureRuntime(JSON.parse(raw));
      this._stamp = `${info.mtimeMs}:${info.size}`;
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }
  /** Pick up writes made by the other process (API vs worker) before touching state. */
  async _reloadIfChanged() {
    try {
      const info = await stat(this.file);
      if (`${info.mtimeMs}:${info.size}` !== this._stamp) await this._load();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async persist() {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2));
    await rename(temp, this.file);
    const info = await stat(this.file);
    this._stamp = `${info.mtimeMs}:${info.size}`;
  }
  async _acquire() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try { const handle = await open(this.lockFile, 'wx'); await handle.close(); return; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const age = await stat(this.lockFile).then((info) => Date.now() - info.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) { await rm(this.lockFile, { force: true }); continue; }
        if (Date.now() > deadline) throw new ApiError('STORE_BUSY', 'The store is busy, please retry', 503);
        await delay(LOCK_RETRY_MS);
      }
    }
  }
  /**
   * API and worker are separate processes over one JSON file. Every mutation runs
   * under an exclusive lock and re-reads whatever the other process committed, so
   * neither can flush a stale in-memory snapshot over the other's trades or claims.
   */
  async _transaction(body) {
    const run = async () => {
      await this._acquire();
      try { await this._reloadIfChanged(); return await body(); }
      finally { await rm(this.lockFile, { force: true }); }
    };
    const chained = this._queue.then(run, run);
    this._queue = chained.then(() => undefined, () => undefined);
    return chained;
  }
  _market(id) {
    const market = this.state.markets.find((item) => item.id === id);
    if (!market) throw new ApiError('MARKET_NOT_FOUND', 'Market not found', 404);
    return market;
  }
  /**
   * A market with a deployed `PredictionMarket` custodies real GEN on Bradbury.
   * The API keeps its metadata and caches its reads, but it must never keep a
   * second, divergent set of balances for it: every value-moving call belongs to
   * the contract. Only simulation markets are settled by this ledger.
   */
  _requireLedger(market) {
    if (market.marketContractAddress) {
      throw new ApiError('ONCHAIN_MARKET', 'This market settles on GenLayer; send this action to its PredictionMarket contract', 409);
    }
    return market;
  }
  _runtime(id) { return this.state.marketRuntime[id]; }
  _timestamps(id) { return this._runtime(id).timestamps ||= {}; }
  _refresh(market) {
    const runtime = this._runtime(market.id); const amm = runtime.amm;
    if (!FINAL.has(market.status)) {
      market.probability = n(amm.noReserve / (amm.yesReserve + amm.noReserve), 4);
      market.liquidity = n(amm.collateral, 2);
    }
    market.poolDepth = { yesReserve: n(amm.yesReserve), noReserve: n(amm.noReserve), collateral: n(amm.collateral), fees: n(amm.fees) };
    market.settlementStages = stagesFor(market.status, runtime.timestamps, runtime.wasDisputed);
    market.recentTrades = Object.values(this.state.portfolios).flatMap((portfolio) =>
      (portfolio.history || []).filter((trade) => trade.marketId === market.id).map((trade) => ({ ...trade, trader: portfolio.address }))
    ).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 20);
    market.traderCount = new Set(market.recentTrades.map((trade) => String(trade.trader).toLowerCase())).size;
    for (const portfolio of Object.values(this.state.portfolios)) this._refreshPortfolio(portfolio);
    return market;
  }
  _refreshPortfolio(portfolio) {
    let value = 0, cost = 0;
    for (const p of portfolio.positions) {
      const market = this.state.markets.find((m) => m.id === p.marketId);
      if (!market) continue;
      p.currentPrice = p.side === 'YES' ? market.probability : n(1 - market.probability, 4);
      if (p.status !== 'settled') {
        if (market.status === 'void') p.status = 'refundable';
        else if (market.status === `resolved_${p.side.toLowerCase()}`) p.status = 'claimable';
        // A resolved market that did not go this position's way pays nothing. Leaving it
        // 'open' made losing positions look live and still claimable forever.
        else if (FINAL.has(market.status)) p.status = 'lost';
        else p.status = 'open';
      }
      value += p.status === 'lost' ? 0 : p.shares * p.currentPrice; cost += p.shares * p.avgPrice;
    }
    portfolio.totalValue = n(value, 2); portfolio.totalPnl = n(value - cost, 2);
  }
  _portfolio(address) {
    const key = address.toLowerCase();
    if (!this.state.portfolios[key]) this.state.portfolios[key] = { address, totalValue: 0, totalPnl: 0, positions: [], history: [] };
    return this.state.portfolios[key];
  }
  _recordPrice(market) {
    const t = nowISO(this.clock); const p = market.probability;
    market.priceHistory = [...(market.priceHistory || []), p].slice(-500);
    market.priceSeries = [...(market.priceSeries || []), { t, p }].slice(-500);
  }
  /** Lifecycle step. Runs inside an already-held transaction; never locks or persists itself. */
  _advance() {
    const now = this.clock.now(); let changed = false;
    for (const market of this.state.markets) {
      const timestamps = this._timestamps(market.id);
      if (market.status === 'trading' && Date.parse(market.closesAt) <= now) {
        market.status = 'closed'; timestamps.market_closed = nowISO(this.clock); this._refresh(market); changed = true;
      }
      if (market.status === 'challenge_window' && Date.parse(market.challengeWindowClosesAt) <= now) {
        this._finalize(market, market.preliminaryOutcome, market.voidReason); changed = true;
      }
    }
    return changed;
  }
  async advance() {
    return this._transaction(async () => { const changed = this._advance(); if (changed) await this.persist(); return changed; });
  }
  async list(query = {}) {
    return this._transaction(async () => this._list(query));
  }
  _list(query = {}) {
    this._advance(); let items = this.state.markets.map((m) => this._refresh(m));
    for (const key of ['status', 'type', 'category']) if (query[key]) items = items.filter((m) => m[key] === query[key]);
    if (query.search) { const search = query.search.toLowerCase(); items = items.filter((m) => `${m.title} ${m.category}`.toLowerCase().includes(search)); }
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const start = Math.max(0, Number(query.cursor) || 0), limit = clamp(Number(query.limit) || 50, 1, 100), page = items.slice(start, start + limit);
    return { items: clone(page), nextCursor: start + limit < items.length ? String(start + limit) : null };
  }
  async getMarket(id) { return this._transaction(async () => { this._advance(); return clone(this._refresh(this._market(id))); }); }
  async getPortfolio(address) {
    return this._transaction(async () => {
      this._advance(); const portfolio = this._portfolio(address); this._refreshPortfolio(portfolio);
      portfolio.liquidityPositions = Object.values(this.state.liquidityPositions).filter((lp) => lp.address.toLowerCase() === address.toLowerCase()).map((lp) => ({ ...lp, status: lp.claimed ? 'claimed' : FINAL.has(this._market(lp.marketId).status) ? 'claimable' : 'open' }));
      await this.persist(); return clone(portfolio);
    });
  }
  /** Read-only price quote so a client can show what a trade would actually fill at. */
  async quote(marketId, side, amount, action = 'buy') {
    return this._transaction(async () => {
      this._advance(); const market = this._market(marketId); const gross = Number(amount);
      if (!['YES', 'NO'].includes(side)) throw new ApiError('INVALID_SIDE', 'side must be YES or NO');
      if (!['buy', 'sell'].includes(action)) throw new ApiError('INVALID_TRADE_ACTION', 'action must be buy or sell');
      if (!Number.isFinite(gross) || gross <= 0 || (action === 'buy' && gross < .001)) throw new ApiError('AMOUNT_TOO_SMALL', 'Trade amount is too small');
      const amm = this._runtime(marketId).amm;
      const spot = side === 'YES' ? market.probability : 1 - market.probability;
      if (action === 'sell') {
        const { amountOut, fee, avgPrice } = quoteSell(amm, market, side, gross);
        return { marketId, action, side, shares: n(gross), amountOut: n(amountOut), fee: n(fee), avgPrice: n(avgPrice, 6), spotPrice: n(spot, 6), priceImpact: spot > 0 ? n((spot - avgPrice) / spot, 6) : 0 };
      }
      const { shares, fee, avgPrice } = quoteTrade(amm, market, side, gross);
      return {
        marketId, action, side, amount: n(gross), shares: n(shares), fee: n(fee), avgPrice: n(avgPrice, 6),
        spotPrice: n(spot, 6), priceImpact: spot > 0 ? n((avgPrice - spot) / spot, 6) : 0,
      };
    });
  }
  async trade(address, { marketId, side, amount, action = 'buy', minSharesOut, minAmountOut, deadline }) {
    return this._transaction(async () => {
      this._advance(); const market = this._requireLedger(this._market(marketId)); const gross = Number(amount);
      if (market.status !== 'trading') throw new ApiError('MARKET_NOT_TRADING', 'This market is no longer trading');
      if (!['YES', 'NO'].includes(side)) throw new ApiError('INVALID_SIDE', 'side must be YES or NO');
      if (!['buy', 'sell'].includes(action)) throw new ApiError('INVALID_TRADE_ACTION', 'action must be buy or sell');
      if (!Number.isFinite(gross) || gross <= 0 || (action === 'buy' && gross < .001)) throw new ApiError('AMOUNT_TOO_SMALL', 'Trade amount is too small');
      if (deadline !== undefined && Date.parse(deadline) <= this.clock.now()) throw new ApiError('QUOTE_EXPIRED', 'The quote for this trade has expired');
      const amm = this._runtime(marketId).amm;
      const portfolio = this._portfolio(address);
      if (action === 'sell') {
        const position = portfolio.positions.find((p) => p.marketId === marketId && p.side === side && p.status === 'open');
        if (!position || gross > position.shares + 1e-6) throw new ApiError('INSUFFICIENT_SHARES', 'Not enough shares to sell');
        const beforeShares = position.shares;
        const { amountOut, gross: poolOut, fee, toPool, avgPrice } = quoteSell(amm, market, side, gross);
        if (!Number.isFinite(amountOut) || amountOut <= 0 || poolOut >= (side === 'YES' ? amm.noReserve : amm.yesReserve)) throw new ApiError('INSUFFICIENT_LIQUIDITY', 'Insufficient liquidity for this sale');
        if (minAmountOut !== undefined && Number(minAmountOut) > amountOut) throw new ApiError('SLIPPAGE_EXCEEDED', 'Price moved beyond the requested limit');
        const outReserve = side === 'YES' ? 'yesReserve' : 'noReserve', inReserve = side === 'YES' ? 'noReserve' : 'yesReserve';
        const exposureKey = side === 'YES' ? 'totalYesShares' : 'totalNoShares';
        const removedCost = (position.totalCost || 0) * gross / beforeShares;
        amm[outReserve] += toPool; amm[inReserve] -= poolOut; amm.collateral -= amountOut; amm.fees += fee;
        amm[exposureKey] -= gross; amm.refundLiability = Math.max(0, amm.refundLiability - removedCost);
        position.shares = n(beforeShares - gross); position.totalCost = n((position.totalCost || 0) - removedCost);
        if (position.shares <= 1e-6) position.status = 'settled';
        market.volume = n((Number(market.volume) || 0) + poolOut, 2); this._refresh(market); this._recordPrice(market); this._refreshPortfolio(portfolio);
        const trade = { id: `t_${randomUUID()}`, marketId, type: 'sell', side, shares: n(gross), price: n(avgPrice), total: n(amountOut), fee: n(fee), timestamp: nowISO(this.clock) };
        portfolio.history.unshift(trade); await this.persist(); return { trade: clone(trade), market: clone(market) };
      }
      const { shares, fromPool, fee, input, avgPrice } = quoteTrade(amm, market, side, gross);
      const drained = side === 'YES' ? amm.yesReserve : amm.noReserve;
      if (!Number.isFinite(shares) || shares <= .000001 || fromPool >= drained * .999) throw new ApiError('INSUFFICIENT_LIQUIDITY', 'Insufficient liquidity for this trade');
      // The fill has to be at least as good as the quote the client agreed to.
      if (minSharesOut !== undefined && Number(minSharesOut) > shares) throw new ApiError('SLIPPAGE_EXCEEDED', 'Price moved beyond the requested limit');
      const exposureKey = side === 'YES' ? 'totalYesShares' : 'totalNoShares';
      const outReserve = side === 'YES' ? 'yesReserve' : 'noReserve', inReserve = side === 'YES' ? 'noReserve' : 'yesReserve';
      const projected = { ...amm, [exposureKey]: (amm[exposureKey] || 0) + shares, fees: amm.fees + fee, refundLiability: (amm.refundLiability || 0) + gross };
      if (liabilityOf(projected) > amm.collateral + gross) throw new ApiError('INSUFFICIENT_LIQUIDITY', 'This trade would exceed collateral backing');
      // The pool custodies the gross amount, fee included; only the CPMM reserves move by
      // the net. `BinaryMarket.buy` does exactly this, and the two must not drift apart.
      amm[outReserve] -= fromPool; amm[inReserve] += input; amm.collateral += gross; amm.fees += fee;
      amm[exposureKey] = (amm[exposureKey] || 0) + shares; amm.refundLiability = (amm.refundLiability || 0) + gross;
      market.volume = n((Number(market.volume) || 0) + gross, 2); this._refresh(market); this._recordPrice(market);
      let position = portfolio.positions.find((p) => p.marketId === marketId && p.side === side && p.status === 'open');
      if (position) { const newShares = position.shares + shares; position.avgPrice = n((position.avgPrice * position.shares + gross) / newShares, 6); position.shares = n(newShares); }
      else { position = { id: `p_${randomUUID()}`, marketId, side, shares: n(shares), avgPrice: n(avgPrice), currentPrice: 0, status: 'open', totalCost: 0 }; portfolio.positions.push(position); }
      position.totalCost = n((position.totalCost || 0) + gross); this._refreshPortfolio(portfolio);
      const trade = { id: `t_${randomUUID()}`, marketId, type: 'buy', side, shares: n(shares), price: n(avgPrice), total: n(gross), fee: n(fee), timestamp: nowISO(this.clock) };
      portfolio.history.unshift(trade); await this.persist(); return { trade: clone(trade), market: clone(market) };
    });
  }
  async provideLiquidity(address, { marketId, amount, action = 'deposit' }) {
    return this._transaction(async () => {
      this._advance(); const market = this._requireLedger(this._market(marketId)); const value = Number(amount);
      if (market.status !== 'trading') throw new ApiError('MARKET_NOT_TRADING', 'Liquidity is available only while trading');
      if (!Number.isFinite(value) || value <= 0) throw new ApiError('AMOUNT_TOO_SMALL', 'Amount must be positive');
      const amm = this._runtime(marketId).amm, key = `${address.toLowerCase()}:${marketId}`; let lp = this.state.liquidityPositions[key] || { address, marketId, shares: 0 };
      if (action === 'deposit') {
        // Mint against equity (collateral minus what traders are already owed),
        // never against gross collateral, or a late depositor buys a claim on the
        // traders' money and the difference goes to whoever deposited earlier.
        // Reserves still scale with collateral: that is what keeps
        // `max(reserve) <= collateral`. `PredictionMarket.add_liquidity` matches.
        const equity = amm.collateral - liabilityOf(amm);
        if (amm.lpShares && equity <= 0) throw new ApiError('NO_FREE_EQUITY', 'The pool has no free equity to price a deposit against');
        const minted = amm.lpShares ? value * amm.lpShares / equity : value;
        const scale = (amm.collateral + value) / amm.collateral; amm.yesReserve *= scale; amm.noReserve *= scale; amm.collateral += value; amm.lpShares += minted; lp.shares += minted;
      } else if (action === 'withdraw') {
        if (value > lp.shares) throw new ApiError('INSUFFICIENT_LP_SHARES', 'Not enough LP shares');
        // Paid out of equity, for the same reason deposits are priced on equity:
        // paying `collateral * fraction` would hand the withdrawing LP a slice of
        // money the traders are owed. It also closed a round-trip exploit — deposit
        // at the equity price, withdraw at the collateral price, keep the difference
        // whenever any trader liability was outstanding.
        const fraction = value / amm.lpShares; const payout = Math.max(0, amm.collateral - liabilityOf(amm)) * fraction;
        // Structurally this cannot under-collateralize the book, but the check stays
        // as a cheap assertion against a future change to the equity definition.
        if (amm.collateral - payout < liabilityOf(amm)) throw new ApiError('COLLATERAL_STILL_BACKING', 'That withdrawal would leave the market unable to cover its payouts');
        const remaining = amm.collateral ? (amm.collateral - payout) / amm.collateral : 0;
        amm.yesReserve *= remaining; amm.noReserve *= remaining; amm.collateral -= payout; amm.lpShares -= value; lp.shares -= value;
        this.state.liquidityPositions[key] = lp; this._refresh(market); await this.persist(); return { market: clone(market), lpPosition: clone(lp), amount: n(payout) };
      } else throw new ApiError('INVALID_LIQUIDITY_ACTION', 'action must be deposit or withdraw');
      this.state.liquidityPositions[key] = lp; this._refresh(market); this._recordPrice(market); await this.persist(); return { market: clone(market), lpPosition: clone(lp), amount: n(value) };
    });
  }
  async createMarket(address, input) {
    return this._transaction(async () => {
      const title = String(input.title || '').trim(), type = input.type, closesAt = Date.parse(input.closesAt), liquidity = Number(input.initialLiquidity);
      if (!title) throw new ApiError('TITLE_REQUIRED', 'A market title is required');
      if (!['deterministic', 'structured', 'judgment'].includes(type)) throw new ApiError('INVALID_MARKET_TYPE', 'type must be deterministic, structured, or judgment');
      if (!input.resolutionSpec?.summary || !Array.isArray(input.resolutionSpec.criteria) || !input.resolutionSpec.criteria.length) throw new ApiError('SPEC_REQUIRED', 'A locked resolution spec with criteria is required');
      if (!Array.isArray(input.sources) || !input.sources.length) throw new ApiError('SOURCES_REQUIRED', 'At least one fixed source is required');
      if (!Number.isFinite(closesAt) || closesAt <= this.clock.now()) throw new ApiError('CLOSES_AT_IN_PAST', 'Close time must be in the future');
      if (!Number.isFinite(liquidity) || liquidity < 1) throw new ApiError('INITIAL_LIQUIDITY_TOO_LOW', 'Initial liquidity must be at least 1 GEN');
      const sources = input.sources.map((s) => ({
        name: String(s.name || '').trim(), url: String(s.url || '').trim(),
        jsonPath: s.jsonPath ? String(s.jsonPath).trim() : null,
        timestampPath: s.timestampPath ? String(s.timestampPath).trim() : null,
        timestampValue: s.timestampValue !== undefined ? String(s.timestampValue).trim() : null,
        fetchedAt: null, contentHash: null,
      }));
      if (sources.some((s) => !s.name || !/^https?:\/\//.test(s.url))) throw new ApiError('INVALID_SOURCE', 'Every source needs a name and an http(s) URL');
      const resolver = buildResolverSpec(type, input, sources);
      const id = input.marketId ? String(input.marketId) : `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48)}-${randomUUID().slice(0, 8)}`;
      if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id) || this.state.markets.some((item) => item.id === id)) throw new ApiError('INVALID_MARKET_ID', 'marketId must be unique and contain 6–80 letters, digits, underscores or dashes');
      const createdAt = nowISO(this.clock); const market = {
        id, title, category: String(input.category || 'Other'), type, status: 'draft', outcome: null, preliminaryOutcome: null,
        probability: .5, volume: 0, liquidity: n(liquidity), closesAt: new Date(closesAt).toISOString(), createdAt, feeBps: clamp(Number(input.feeBps) || 200, 0, 1000),
        challengeWindowClosesAt: null, voidReason: null,
        // `resolver` is the machine-readable half of the spec: exactly the constructor
        // arguments the GenLayer contract for this market type is deployed with.
        resolutionSpec: {
          summary: String(input.resolutionSpec.summary), criteria: input.resolutionSpec.criteria.map(String),
          tieBreak: String(input.resolutionSpec.tieBreak || 'VOID'), unavailableRule: String(input.resolutionSpec.unavailableRule || 'VOID unless all three fixed sources are available'),
          observationTime: new Date(closesAt).toISOString(), lockedAt: createdAt, version: 'v2.0', resolver,
        },
        sources, settlementStages: stagesFor('draft'), challenge: null, priceHistory: [.5], priceSeries: [{ t: createdAt, p: .5 }], creator: address,
        resolverContractAddress: null, resolverNetwork: String(input.resolverNetwork || 'testnetBradbury'), disputeResolverContractAddress: null,
        // Set once a PredictionMarket is deployed and verified. Until then this
        // market is a simulation and says so everywhere it is shown.
        marketContractAddress: null, marketDeploymentTx: null, settlement: 'simulation',
      };
      market.sourcesHash = canonicalHash(fixedSources(sources));
      market.resolutionSpecHash = canonicalHash(market.resolutionSpec);
      market.resolverBinding = { marketId: id, resolutionSpecHash: market.resolutionSpecHash, sourcesHash: market.sourcesHash, observationTime: market.resolutionSpec.observationTime };
      this.state.markets.push(market); this.state.marketRuntime[id] = { amm: seedAmm(market), timestamps: {}, wasDisputed: false };
      this.state.liquidityPositions[`${address.toLowerCase()}:${id}`] = { address, marketId: id, shares: liquidity, claimed: false };
      await this.persist(); return { market: clone(market) };
    });
  }
  async bindResolver(id, caller, contractAddress, verifiedBinding) {
    return this._transaction(async () => {
      const market = this._market(id);
      if (market.creator.toLowerCase() !== caller.toLowerCase()) throw new ApiError('CREATOR_ONLY', 'Only the market creator can bind its resolver', 403);
      if (market.status !== 'draft' || market.resolverContractAddress) throw new ApiError('MARKET_NOT_DRAFT', 'Resolver can only be bound once, before trading starts');
      if (!verifiedBinding?.verified || verifiedBinding.contractAddress.toLowerCase() !== String(contractAddress).toLowerCase()) throw new ApiError('UNVERIFIED_RESOLVER', 'Resolver binding was not verified', 403);
      if (Date.parse(market.closesAt) <= this.clock.now()) throw new ApiError('CLOSES_AT_IN_PAST', 'The draft expired before its resolver was bound');
      market.resolverContractAddress = contractAddress; market.status = 'trading'; market.resolverBoundAt = nowISO(this.clock); this._refresh(market);
      await this.persist(); return clone(market);
    });
  }
  /**
   * Record the deployed PredictionMarket for a market. From this point the API
   * is an index, not a ledger: `_requireLedger` refuses every value-moving call
   * and the client reads balances, shares and outcome from the contract.
   */
  async bindMarketContract(id, caller, contractAddress, verified) {
    return this._transaction(async () => {
      const market = this._market(id);
      if (market.creator.toLowerCase() !== caller.toLowerCase()) throw new ApiError('CREATOR_ONLY', 'Only the market creator can bind its market contract', 403);
      if (!market.resolverContractAddress) throw new ApiError('RESOLVER_NOT_BOUND', 'Bind the resolver before the market contract');
      if (market.marketContractAddress) throw new ApiError('MARKET_CONTRACT_BOUND', 'This market already has a deployed contract');
      if (!verified?.verified || verified.contractAddress.toLowerCase() !== String(contractAddress).toLowerCase()) throw new ApiError('UNVERIFIED_MARKET_CONTRACT', 'Market contract binding was not verified', 403);
      market.marketContractAddress = contractAddress;
      market.marketDeploymentTx = verified.transactionHash || null;
      market.settlement = 'onchain';
      market.marketContractBoundAt = nowISO(this.clock);
      this._refresh(market); await this.persist(); return clone(market);
    });
  }
  async publishPreliminary(id, verifiedResolution) {
    return this._transaction(async () => {
      this._advance(); const market = this._requireLedger(this._market(id)); const { outcome, evidence = [], contentHashes = [], voidReason } = verifiedResolution || {};
      if (!verifiedResolution?.verified) throw new ApiError('UNVERIFIED_RESOLUTION', 'A finalized, market-bound GenLayer result is required', 403);
      if (market.status !== 'closed') throw new ApiError('MARKET_NOT_READY', 'Market must be closed and must not already have a preliminary result');
      if (!['YES', 'NO', 'VOID'].includes(outcome)) throw new ApiError('INVALID_OUTCOME', 'outcome must be YES, NO, or VOID');
      const timestamp = nowISO(this.clock), timestamps = this._timestamps(id); market.preliminaryOutcome = outcome; market.resolutionEvidence = evidence;
      market.sources.forEach((source, index) => { source.fetchedAt = timestamp; source.contentHash = contentHashes[index] || source.contentHash || null; });
      timestamps.preliminary_result = timestamp;
      // A VOID is a proposal like any other. Settling it on the spot left a mistaken VOID
      // with no route to a challenge, so it opens the same window as YES and NO.
      if (outcome === 'VOID') market.voidReason = voidReason || 'Resolver could not determine a safe outcome';
      market.status = 'challenge_window';
      market.challengeWindowClosesAt = new Date(this.clock.now() + this.challengeWindowSeconds * 1000).toISOString();
      timestamps.challenge_window = timestamp; this._refresh(market);
      await this.persist(); return clone(market);
    });
  }
  async challenge(address, { marketId, reason, stakeAmount }) {
    return this._transaction(async () => this._challenge(address, { marketId, reason, stakeAmount }));
  }
  async bindDisputeResolver(id, contractAddress) {
    return this._transaction(async () => {
      const market = this._market(id);
      if (market.status !== 'disputed') throw new ApiError('MARKET_NOT_DISPUTED', 'Only a disputed market can bind an expanded resolver');
      if (!/^0x[a-fA-F0-9]{40}$/.test(String(contractAddress || ''))) throw new ApiError('INVALID_RESOLVER', 'A valid GenLayer resolver address is required');
      if (market.disputeResolverContractAddress && market.disputeResolverContractAddress.toLowerCase() !== contractAddress.toLowerCase()) throw new ApiError('RESOLVER_ALREADY_BOUND', 'The expanded resolver is already locked');
      market.disputeResolverContractAddress = contractAddress; await this.persist(); return clone(market);
    });
  }
  async _challenge(address, { marketId, reason, stakeAmount }) {
    this._advance(); const market = this._requireLedger(this._market(marketId)), stake = Number(stakeAmount);
    if (market.status !== 'challenge_window' || Date.parse(market.challengeWindowClosesAt) <= this.clock.now()) throw new ApiError('CHALLENGE_WINDOW_CLOSED', 'The challenge window is closed');
    if (!Number.isFinite(stake) || stake < .1) throw new ApiError('STAKE_TOO_LOW', 'Minimum challenge stake is 0.1 GEN');
    if (!String(reason || '').trim()) throw new ApiError('CHALLENGE_REASON_REQUIRED', 'A challenge reason is required');
    if (market.challenge) throw new ApiError('ALREADY_CHALLENGED', 'This market already has an active challenge');
    const challenge = { id: `c_${randomUUID()}`, challenger: address, reason: String(reason).trim(), stakedAmount: n(stake), submittedAt: nowISO(this.clock), status: 'under_review' };
    market.challenge = challenge; market.status = 'disputed'; const runtime = this._runtime(marketId); runtime.wasDisputed = true; this._timestamps(marketId).dispute_review = challenge.submittedAt; this.state.challenges.push(challenge); this._refresh(market); await this.persist(); return { challenge: clone(challenge), market: clone(market) };
  }
  async finalize(id, resolution = {}) {
    return this._transaction(async () => {
      const { outcome, voidReason } = resolution;
      this._advance(); const market = this._requireLedger(this._market(id));
      if (!['challenge_window', 'disputed'].includes(market.status)) throw new ApiError('MARKET_NOT_READY', 'Market has no preliminary result to finalize');
      if (market.status === 'challenge_window' && Date.parse(market.challengeWindowClosesAt) > this.clock.now()) throw new ApiError('CHALLENGE_WINDOW_OPEN', 'Challenge window is still open');
      if (market.status === 'challenge_window' && outcome && outcome !== market.preliminaryOutcome) throw new ApiError('OUTCOME_MISMATCH', 'An uncontested result can only finalize its published preliminary outcome');
      if (market.status === 'disputed' && !resolution.verified) throw new ApiError('UNVERIFIED_RESOLUTION', 'A disputed market needs a finalized expanded GenLayer result', 403);
      this._finalize(market, outcome || market.preliminaryOutcome, voidReason); await this.persist(); return clone(market);
    });
  }
  _finalize(market, outcome, voidReason) {
    if (!['YES', 'NO', 'VOID'].includes(outcome)) throw new ApiError('INVALID_OUTCOME', 'outcome must be YES, NO, or VOID');
    market.outcome = outcome; market.status = outcome === 'VOID' ? 'void' : `resolved_${outcome.toLowerCase()}`; market.voidReason = outcome === 'VOID' ? (voidReason || market.voidReason || 'Resolution was invalidated') : null;
    const amm = this._runtime(market.id).amm;
    const traderPayout = outcome === 'VOID' ? amm.refundLiability : outcome === 'YES' ? amm.totalYesShares : amm.totalNoShares;
    const feePayout = outcome === 'VOID' ? 0 : amm.fees;
    amm.lpResidual = Math.max(0, amm.collateral - traderPayout - feePayout);
    market.probability = outcome === 'YES' ? 1 : outcome === 'NO' ? 0 : .5; market.liquidity = 0; this._timestamps(market.id).final_result = nowISO(this.clock); this._timestamps(market.id).settled = nowISO(this.clock); if (market.challenge) market.challenge.status = outcome === market.preliminaryOutcome ? 'rejected' : 'upheld'; this._refresh(market); this._recordPrice(market);
  }
  async claim(address, { marketId }) {
    return this._transaction(async () => {
      this._advance(); const market = this._requireLedger(this._market(marketId)); if (!FINAL.has(market.status)) throw new ApiError('MARKET_NOT_RESOLVED', 'Market is not resolved yet');
      const portfolio = this._portfolio(address); const candidates = portfolio.positions.filter((p) => p.marketId === marketId && p.status !== 'settled');
      if (!candidates.length) throw new ApiError('NOTHING_TO_CLAIM', 'There is no claimable position');
      let amount = 0; const settled = [];
      for (const p of candidates) {
        if (market.outcome !== 'VOID' && p.side !== market.outcome) {
          // A losing side pays nothing but is still finished. Skipping it outright left
          // it 'open' forever next to the winning leg of the very same market.
          p.status = 'lost';
          continue;
        }
        const payout = market.outcome === 'VOID' ? (p.totalCost || p.shares * p.avgPrice) : p.shares;
        amount += payout; p.status = 'settled'; settled.push(p); this._runtime(marketId).amm.collateral -= payout;
        portfolio.history.unshift({ id: `t_${randomUUID()}`, marketId, type: market.outcome === 'VOID' ? 'refund' : 'claim', side: p.side, shares: p.shares, price: market.outcome === 'VOID' ? p.avgPrice : 1, total: n(payout), timestamp: nowISO(this.clock) });
      }
      if (!amount) { this._refreshPortfolio(portfolio); await this.persist(); throw new ApiError('NOTHING_TO_CLAIM', 'No winning or refundable position exists'); }
      this._refreshPortfolio(portfolio); await this.persist();
      return { amount: n(amount), txHash: `0x${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '').slice(0, 32)}`, positions: clone(settled), position: clone(settled[0]) };
    });
  }
  async claimLiquidity(address, { marketId }) {
    return this._transaction(async () => {
      this._advance(); const market = this._requireLedger(this._market(marketId));
      if (!FINAL.has(market.status)) throw new ApiError('MARKET_NOT_RESOLVED', 'Market is not resolved yet');
      const key = `${address.toLowerCase()}:${marketId}`, lp = this.state.liquidityPositions[key];
      if (!lp?.shares || lp.claimed) throw new ApiError('NOTHING_TO_CLAIM', 'There is no claimable LP position');
      const amm = this._runtime(marketId).amm;
      const amount = (amm.lpResidual || 0) * lp.shares / amm.lpShares;
      lp.claimed = true; lp.claimedAmount = n(amount); lp.claimedAt = nowISO(this.clock); amm.collateral -= amount;
      await this.persist(); return { marketId, amount: n(amount), lpPosition: clone(lp) };
    });
  }
  async priceSeries(id, params = {}) {
    return this._transaction(async () => {
      await this._reloadIfChanged();
      const market = this._market(id), from = params.from ? Date.parse(params.from) : 0, to = params.to ? Date.parse(params.to) : Infinity;
      const points = (market.priceSeries || []).filter((p) => Date.parse(p.t) >= from && Date.parse(p.t) <= to).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      return { interval: ['5m', '1h', '1d'].includes(params.interval) ? params.interval : '1h', points: clone(points) };
    });
  }
}
