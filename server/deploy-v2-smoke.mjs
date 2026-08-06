import { readFile } from 'node:fs/promises';
import { createAccount, createClient, chains } from 'genlayer-js';
import { canonicalHash, fixedSources } from './canonical.mjs';

if (process.env.CONFIRM_BRADBURY_DEPLOY !== 'YES') throw new Error('Set CONFIRM_BRADBURY_DEPLOY=YES to authorize three new paid deployments');

const secretFile = process.env.RELAYER_KEY_FILE || new URL('../.secrets/genlayer-relayer.json', import.meta.url);
const secret = JSON.parse(await readFile(secretFile, 'utf8'));
const privateKey = process.env.GENLAYER_PRIVATE_KEY || secret.privateKey;
if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey || '')) throw new Error('Missing valid GenLayer private key');
const account = createAccount(privateKey);
if (secret.address && secret.address.toLowerCase() !== account.address.toLowerCase()) throw new Error('Secret address does not match its private key');
const client = createClient({ chain: chains.testnetBradbury, account });

const minute = Math.floor(Date.now() / 60_000) * 60 - 600;
const observationTime = new Date(minute * 1000).toISOString();
const lockedAt = new Date().toISOString();
const common = { tieBreak: 'VOID', unavailableRule: 'VOID unless all three fixed sources satisfy the locked rule', observationTime, lockedAt, version: 'v2.0' };

function market(id, title, type, sources, resolver, summary, criteria) {
  const resolutionSpec = { summary, criteria, ...common, resolver };
  return { id, title, type, sources, resolutionSpec, sourcesHash: canonicalHash(fixedSources(sources)), resolutionSpecHash: canonicalHash(resolutionSpec), observationTime };
}

const coinbaseUrl = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${encodeURIComponent(observationTime)}&end=${encodeURIComponent(new Date((minute + 60) * 1000).toISOString())}`;
const krakenUrl = `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since=${minute}`;
const binanceUrl = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${minute * 1000}&endTime=${minute * 1000 + 59_999}&limit=1`;
const numericSources = [
  { name: 'Coinbase Exchange BTC-USD candle', url: coinbaseUrl, jsonPath: '1.4', timestampPath: '1.0', timestampValue: String(minute) },
  { name: 'Kraken XBTUSD OHLC', url: krakenUrl, jsonPath: 'result.XXBTZUSD.0.4', timestampPath: 'result.XXBTZUSD.0.0', timestampValue: String(minute) },
  { name: 'Binance BTCUSDT kline', url: binanceUrl, jsonPath: '0.4', timestampPath: '0.0', timestampValue: String(minute * 1000) },
];
const numericArgs = { sources: numericSources.map((s) => s.url), jsonPaths: numericSources.map((s) => s.jsonPath), timestampPaths: numericSources.map((s) => s.timestampPath), timestampValues: numericSources.map((s) => s.timestampValue), comparator: 'GT', scale: 100, thresholdUnits: 0, maxSourceSpreadUnits: 100_000 };
const numeric = market('bradbury-v2-numeric-smoke', 'Is the locked BTC/USD median above zero?', 'deterministic', numericSources, { contract: 'NumericResolver', args: numericArgs }, 'YES when the exact-time median is above zero.', ['All three historical candles must match their locked timestamps.', 'The scaled integer median must be greater than zero.']);

const factUrls = ['https://www.genlayer.com/', 'https://docs.genlayer.com/', 'https://github.com/genlayerlabs'];
const structuredSources = factUrls.map((url, index) => ({ name: ['GenLayer website', 'GenLayer documentation', 'GenLayer GitHub organization'][index], url }));
const structuredArgs = { sources: factUrls, criterion: 'YES only if at least two sources explicitly identify the project as GenLayer; NO only if at least two explicitly contradict that; otherwise VOID.' };
const structured = market('bradbury-v2-structured-smoke', 'Do official project pages identify the project as GenLayer?', 'structured', structuredSources, { contract: 'StructuredFactResolver', args: structuredArgs }, 'Two-of-three fixed-source identity check.', [structuredArgs.criterion]);

const judgmentUrls = ['https://www.genlayer.com/', 'https://docs.genlayer.com/', 'https://github.com/genlayerlabs/genlayer-js'];
const judgmentSources = judgmentUrls.map((url, index) => ({ name: ['GenLayer website', 'GenLayer documentation', 'GenLayer JS repository'][index], url }));
const judgmentArgs = { sources: judgmentUrls, interpretationRule: 'YES only when at least two sources unambiguously describe GenLayer as using AI or intelligent contracts for consensus or contract execution; ambiguity is VOID.' };
const judgment = market('bradbury-v2-judgment-smoke', 'Is AI functionality central to GenLayer intelligent contracts?', 'judgment', judgmentSources, { contract: 'JudgmentResolver', args: judgmentArgs }, 'Conservative interpretation across fixed official sources.', [judgmentArgs.interpretationRule]);

const definitions = [
  {
    key: 'numeric', market: numeric, file: 'genlayer/contracts/NumericResolver.py',
    args: [account.address, numeric.id, numeric.resolutionSpecHash, numeric.sourcesHash, observationTime, numeric.title,
      numericSources[0].url, numericSources[0].jsonPath, numericSources[0].timestampPath, numericSources[0].timestampValue,
      numericSources[1].url, numericSources[1].jsonPath, numericSources[1].timestampPath, numericSources[1].timestampValue,
      numericSources[2].url, numericSources[2].jsonPath, numericSources[2].timestampPath, numericSources[2].timestampValue,
      numericArgs.comparator, numericArgs.scale, numericArgs.thresholdUnits, numericArgs.maxSourceSpreadUnits],
  },
  { key: 'structured', market: structured, file: 'genlayer/contracts/StructuredFactResolver.py', args: [account.address, structured.id, structured.resolutionSpecHash, structured.sourcesHash, observationTime, structured.title, structuredArgs.criterion, ...factUrls] },
  { key: 'judgment', market: judgment, file: 'genlayer/contracts/JudgmentResolver.py', args: [account.address, judgment.id, judgment.resolutionSpecHash, judgment.sourcesHash, observationTime, judgment.title, judgmentArgs.interpretationRule, ...judgmentUrls] },
];

const deployed = {};
for (const definition of definitions) {
  process.stderr.write(`Deploying ${definition.key} v2...\n`);
  const code = await readFile(definition.file, 'utf8');
  const deploymentTx = await client.deployContract({ code, args: definition.args });
  const receipt = await client.waitForTransactionReceipt({ hash: deploymentTx, status: 'FINALIZED', interval: 10_000, retries: 180 });
  if (receipt.txExecutionResultName !== 'FINISHED_WITH_RETURN') throw new Error(`${definition.key} deployment failed: ${receipt.txExecutionResultName}`);
  const address = receipt.txDataDecoded?.contractAddress;
  if (!address) throw new Error(`${definition.key} receipt has no contract address`);
  const [binding, config] = await Promise.all([
    client.readContract({ address, functionName: 'market_binding', args: [], transactionHashVariant: 'latest-final' }),
    client.readContract({ address, functionName: 'resolver_config', args: [], transactionHashVariant: 'latest-final' }),
  ]);
  deployed[definition.key] = { address, deploymentTx, binding, config, market: definition.market, status: 'PENDING' };
  process.stderr.write(`${definition.key} finalized at ${address}\n`);
}

process.stderr.write('Resolving numeric v2 smoke market...\n');
const resolutionTx = await client.writeContract({ address: deployed.numeric.address, functionName: 'resolve', args: [], value: 0n });
const resolutionReceipt = await client.waitForTransactionReceipt({ hash: resolutionTx, status: 'FINALIZED', interval: 10_000, retries: 180 });
if (resolutionReceipt.txExecutionResultName !== 'FINISHED_WITH_RETURN') throw new Error(`numeric resolve failed: ${resolutionReceipt.txExecutionResultName}`);
deployed.numeric.resolutionTx = resolutionTx;
deployed.numeric.resolution = await client.readContract({ address: deployed.numeric.address, functionName: 'resolution', args: [], transactionHashVariant: 'latest-final' });
deployed.numeric.status = deployed.numeric.resolution.outcome;

const balance = await client.getBalance({ address: account.address });
console.log(JSON.stringify({ version: 2, network: 'GenLayer Bradbury Testnet', chainId: 4221, deployedAt: new Date().toISOString(), relayer: account.address, remainingBalanceWei: balance.toString(), contracts: deployed }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
