/**
 * Deploy a tradeable demo market on Bradbury: a fresh resolver whose observation
 * time is still ahead, the PredictionMarket bound to it, then real liquidity and a
 * real buy so the market is live rather than merely deployed.
 *
 * The markets bound to the existing v2 resolvers all close in the past, so they can
 * be read but not traded. This one is the one to show.
 *
 * Deployments use leaderOnly because full validator rounds were stalling in
 * commit/reveal when this was written; the constructors are deterministic, so
 * nothing is being hidden from validators. See README for the trade-off.
 */
import { readFile } from 'node:fs/promises';
import { createAccount, createClient, chains } from 'genlayer-js';
import { canonicalHash, fixedSources } from './canonical.mjs';
import { addressHex } from './genlayer-verifier.mjs';

if (process.env.CONFIRM_BRADBURY_DEPLOY !== 'YES') {
  throw new Error('Set CONFIRM_BRADBURY_DEPLOY=YES to authorize paid deployments on Bradbury');
}

const MINUTES_UNTIL_CLOSE = Number(process.env.MINUTES_UNTIL_CLOSE || 45);
/**
 * Resuming, rather than starting over, matters here: the observation minute is
 * baked into the resolver's constructor and into both hashes, so a second run that
 * picked a new minute would produce a resolver the first run's market can never
 * bind to. MARKET_MINUTE pins the minute and RESOLVER_TX reuses a deployment that
 * is already in flight, so a run interrupted by a slow network costs nothing to
 * pick back up.
 */
const RESUME_MINUTE = process.env.MARKET_MINUTE ? Number(process.env.MARKET_MINUTE) : null;
const RESUME_RESOLVER_TX = process.env.RESOLVER_TX || null;
const LIQUIDITY_WEI = 10n ** 18n / 2n;      // 0.5 GEN of liquidity
const BUY_WEI = 10n ** 17n;                 // 0.1 GEN buy
const FEE_BPS = 200;
const CHALLENGE_WINDOW_SECONDS = 600;
const MIN_CHALLENGE_STAKE_WEI = 10n ** 17n;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const ACCEPT_INTERVAL_MS = 10_000;
const ACCEPT_RETRIES = Number(process.env.ACCEPT_RETRIES || 60);
/** How many deployments to race. Cheap on testnet, and the losers hurt nobody. */
const RACE_WIDTH = Number(process.env.RACE_WIDTH || 5);

const root = new URL('..', import.meta.url);
const secret = JSON.parse(await readFile(process.env.RELAYER_KEY_FILE || new URL('.secrets/genlayer-relayer.json', root), 'utf8'));
const account = createAccount(process.env.GENLAYER_PRIVATE_KEY || secret.privateKey);
const client = createClient({ chain: chains.testnetBradbury, account });
const log = (message) => process.stderr.write(`${message}\n`);

/**
 * Watch one deployment attempt until it either produces a contract that answers or
 * is provably dead.
 *
 * A receipt carries a predicted contract address from the moment it is submitted,
 * and an interim status can regress: this script previously took an address from
 * an `APPEAL_COMMITTING` receipt, sent 0.5 GEN of liquidity to it, and watched the
 * deployment fall back to `VALIDATORS_TIMEOUT` — leaving the payable call to fail
 * against an address where no contract had ever existed, with the value gone.
 *
 * `FINALIZED` is no better a signal on its own. Two deployments in this project
 * reached `FINALIZED` with `FINISHED_WITH_RETURN` and left nothing callable behind.
 * So the only trustworthy evidence is the contract answering — and a finalized
 * deployment that still does not answer is dead rather than slow, which is what
 * makes it safe to stop waiting and try again.
 *
 * @returns the address once it answers, or null if this attempt is dead.
 */
async function watchDeployment(hash, label, probeMethod, retries) {
  let finalizedProbes = 0;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const tx = await client.getTransaction({ hash }).catch(() => null);
    const address = tx?.txDataDecoded?.contractAddress;
    if (address && tx.txExecutionResultName === 'FINISHED_WITH_RETURN') {
      const answered = await client.readContract({
        address, functionName: probeMethod, args: [], transactionHashVariant: 'latest-nonfinal',
      }).then(() => true, () => false);
      if (answered) {
        log(`${label}: live at ${address} (deployment ${tx.statusName})`);
        return address;
      }
      // Finalized and still silent after a couple of polls is not propagation lag.
      if (tx.statusName === 'FINALIZED' && (finalizedProbes += 1) >= 3) {
        log(`${label}: FINALIZED but nothing answers at ${address} — this attempt is dead`);
        return null;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, ACCEPT_INTERVAL_MS));
  }
  log(`${label}: no live contract after ${ACCEPT_INTERVAL_MS * retries / 1000}s (hash ${hash})`);
  return null;
}

/**
 * Race several deployments and take the first one that comes alive.
 *
 * Bradbury landed 3 of 10 `PredictionMarket` deployments on the evening this was
 * written. Waiting out one attempt before starting the next turns a ~30% chance
 * into a long serial lottery; submitting a batch up front and watching them all
 * turns it into ~85% within the time of a single attempt. Deployments are cheap
 * here and the losing attempts simply produce contracts nobody binds to.
 *
 * Submissions are sequential so each gets its own nonce; only the waiting is
 * parallel.
 */
async function deployRaced(label, submit, probeMethod, parallel = RACE_WIDTH) {
  const hashes = [];
  for (let index = 0; index < parallel; index += 1) {
    try {
      const hash = await submit();
      hashes.push(hash);
      log(`${label} attempt ${index + 1}/${parallel}: ${hash}`);
    } catch (error) {
      log(`${label} attempt ${index + 1} could not be submitted: ${error.message}`);
    }
  }
  if (!hashes.length) throw new Error(`${label}: no deployment could be submitted`);

  for (let round = 0; round < ACCEPT_RETRIES; round += 1) {
    for (const hash of hashes) {
      const tx = await client.getTransaction({ hash }).catch(() => null);
      const address = tx?.txDataDecoded?.contractAddress;
      if (!address || tx.txExecutionResultName !== 'FINISHED_WITH_RETURN') continue;
      const answered = await client.readContract({
        address, functionName: probeMethod, args: [], transactionHashVariant: 'latest-nonfinal',
      }).then(() => true, () => false);
      if (answered) {
        log(`${label}: live at ${address} via ${hash} (${tx.statusName})`);
        return address;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, ACCEPT_INTERVAL_MS));
  }
  throw new Error(`${label}: none of ${hashes.length} attempts came alive in ${ACCEPT_INTERVAL_MS * ACCEPT_RETRIES / 1000}s`);
}

/**
 * Send a state-changing call and confirm it actually changed the state.
 *
 * A transaction here can conclude with `FINISHED_WITH_RETURN` and leave the
 * contract untouched, so the receipt is not the evidence; the state is.
 *
 * Retrying a *payable* call needs one more guard, learned the expensive way. On a
 * round that ends `result 3` the value still moves even though the state change is
 * thrown away: four `add_liquidity` retries put 2 GEN into a market whose accounted
 * collateral stayed at zero. So before re-sending anything that carries value, the
 * contract's balance is checked — if the GEN already arrived, sending more cannot
 * help and the caller is told to stop rather than keep feeding a contract that is
 * not booking what it receives.
 */
async function writeUntilEffective(label, send, settled, { attempts = 4, value = 0n } = {}) {
  const readState = () => client.readContract({
    address: marketAddress, functionName: 'market_state', args: [], transactionHashVariant: 'latest-nonfinal',
  }).catch(() => null);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = await readState();
    if (!before) throw new Error(`${label}: market state is unreadable`);
    const balanceBefore = value > 0n ? await client.getBalance({ address: marketAddress }) : 0n;

    const hash = await send();
    log(`${label} attempt ${attempt}/${attempts}: ${hash}`);
    for (let round = 0; round < Math.floor(ACCEPT_RETRIES / attempts); round += 1) {
      const now = await readState();
      if (now && settled(before, now)) {
        log(`${label}: effect confirmed on chain`);
        return hash;
      }
      await new Promise((resolve) => setTimeout(resolve, ACCEPT_INTERVAL_MS));
    }

    if (value > 0n) {
      const balanceAfter = await client.getBalance({ address: marketAddress });
      if (balanceAfter > balanceBefore) {
        throw new Error(
          `${label}: the value arrived (contract balance ${balanceBefore} -> ${balanceAfter}) but the state change was `
          + 'rejected. Re-sending would strand more GEN in a contract that is not booking it, so this stops here.',
        );
      }
    }
    log(`${label} attempt ${attempt} left the state unchanged and moved no value; re-sending`);
  }
  throw new Error(`${label} never took effect`);
}

// Observation time is a whole minute far enough ahead to leave room to trade, and
// the numeric sources are locked to that exact minute — the resolver refuses any
// snapshot from another one.
const minute = RESUME_MINUTE ?? Math.floor(Date.now() / 60_000 + MINUTES_UNTIL_CLOSE) * 60;
if (minute * 1000 <= Date.now()) throw new Error(`Observation minute ${new Date(minute * 1000).toISOString()} is already in the past; the market would open closed`);
const observationTime = new Date(minute * 1000).toISOString();
const marketId = `bradbury-live-demo-${minute}`;
const title = 'Is the locked BTC/USD median above zero at the observation minute?';

const sources = [
  { name: 'Coinbase Exchange BTC-USD candle', url: `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${encodeURIComponent(observationTime)}&end=${encodeURIComponent(new Date((minute + 60) * 1000).toISOString())}`, jsonPath: '1.4', timestampPath: '1.0', timestampValue: String(minute) },
  { name: 'Kraken XBTUSD OHLC', url: `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since=${minute}`, jsonPath: 'result.XXBTZUSD.0.4', timestampPath: 'result.XXBTZUSD.0.0', timestampValue: String(minute) },
  { name: 'Binance BTCUSDT kline', url: `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${minute * 1000}&endTime=${minute * 1000 + 59_999}&limit=1`, jsonPath: '0.4', timestampPath: '0.0', timestampValue: String(minute * 1000) },
];
const resolverArgs = {
  sources: sources.map((s) => s.url), jsonPaths: sources.map((s) => s.jsonPath),
  timestampPaths: sources.map((s) => s.timestampPath), timestampValues: sources.map((s) => s.timestampValue),
  comparator: 'GT', scale: 100, thresholdUnits: 0, maxSourceSpreadUnits: 100_000,
};
const resolutionSpec = {
  summary: 'Exact-integer median of three locked exchange candles at the observation minute.',
  criteria: ['All three candles must carry the locked timestamp.', 'The scaled integer median must be greater than zero.'],
  tieBreak: 'VOID', unavailableRule: 'VOID unless all three fixed sources satisfy the locked rule',
  observationTime, lockedAt: new Date().toISOString(), version: 'v2.0',
  resolver: { contract: 'NumericResolver', args: resolverArgs },
};
const sourcesHash = canonicalHash(fixedSources(sources));
const resolutionSpecHash = canonicalHash(resolutionSpec);

log(`market ${marketId}`);
// Computed from the actual minute, not from MINUTES_UNTIL_CLOSE: on a resumed run
// the minute comes from MARKET_MINUTE and the configured offset is meaningless.
log(`observation time ${observationTime} (${Math.round((minute * 1000 - Date.now()) / 60_000)} minutes from now)`);

const resolverCode = await readFile(new URL('genlayer/contracts/NumericResolver.py', root), 'utf8');
const deployResolver = () => client.deployContract({
  code: resolverCode, leaderOnly: true,
  args: [account.address, marketId, resolutionSpecHash, sourcesHash, observationTime, title,
    ...sources.flatMap((s) => [s.url, s.jsonPath, s.timestampPath, s.timestampValue]),
    resolverArgs.comparator, resolverArgs.scale, resolverArgs.thresholdUnits, resolverArgs.maxSourceSpreadUnits],
});
if (RESUME_RESOLVER_TX) log(`resuming with resolver deployment ${RESUME_RESOLVER_TX}`);
let resumed = RESUME_RESOLVER_TX;
const resolverAddress = await deployRaced('resolver deploy', () => {
  const hash = resumed || deployResolver();
  resumed = null;
  return hash;
}, 'market_binding', resumed ? 1 : RACE_WIDTH);

const marketCode = await readFile(new URL('genlayer/contracts/PredictionMarket.py', root), 'utf8');
const marketAddress = await deployRaced('market deploy', () => client.deployContract({
  code: marketCode, leaderOnly: true,
  args: [marketId, title, resolverAddress, ZERO_ADDRESS, resolutionSpecHash, sourcesHash, observationTime,
    FEE_BPS, CHALLENGE_WINDOW_SECONDS, MIN_CHALLENGE_STAKE_WEI],
}), 'market_state');

// Liquidity has landed when the pool's collateral has actually grown — not when a
// receipt says so. Re-sending is safe here: `add_liquidity` mints against whatever
// it finds, so a duplicate that slipped through would add liquidity twice rather
// than corrupt anything.
const liquidityTx = await writeUntilEffective(
  'add_liquidity',
  () => client.writeContract({ address: marketAddress, functionName: 'add_liquidity', args: [], value: LIQUIDITY_WEI, leaderOnly: true }),
  (before, now) => BigInt(now.collateral) > BigInt(before.collateral),
  { value: LIQUIDITY_WEI },
);

// The buy is quoted fresh each attempt: a re-send after a failed round must price
// against the book as it stands, and its deadline has to still be in the future.
const buyTx = await writeUntilEffective(
  'buy_yes',
  async () => {
    const quote = await client.readContract({ address: marketAddress, functionName: 'quote_buy', args: ['YES', BUY_WEI], transactionHashVariant: 'latest-nonfinal' });
    const minShares = BigInt(quote.shares) * 99n / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 900;
    return client.writeContract({ address: marketAddress, functionName: 'buy_yes', args: [minShares, deadline], value: BUY_WEI, leaderOnly: true });
  },
  (before, now) => BigInt(now.totalYesShares) > BigInt(before.totalYesShares),
  { value: BUY_WEI },
);

const state = await client.readContract({ address: marketAddress, functionName: 'market_state', args: [], transactionHashVariant: 'latest-nonfinal' });
const position = await client.readContract({ address: marketAddress, functionName: 'position_of', args: [account.address], transactionHashVariant: 'latest-nonfinal' });
const balance = await client.getBalance({ address: account.address });

const readable = (_, value) => {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && value.bytes) return addressHex(value);
  return value;
};
console.log(JSON.stringify({
  network: 'GenLayer Bradbury Testnet', chainId: 4221, deployedAt: new Date().toISOString(),
  marketId, title, observationTime, resolutionSpecHash, sourcesHash,
  resolver: { address: resolverAddress },
  market: { address: marketAddress },
  transactions: { addLiquidity: liquidityTx, buyYes: buyTx },
  liquidityWei: LIQUIDITY_WEI.toString(), buyWei: BUY_WEI.toString(),
  state, position, relayer: account.address, remainingBalanceWei: balance.toString(),
  note: 'Deployed leader-only and reported at ACCEPTED, which is when a contract becomes callable. Finality follows after the appeal window; run `npm run genlayer:finalize` for the FINALIZED status.',
  sources, resolutionSpec,
}, readable, 2));
