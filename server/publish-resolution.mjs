/**
 * Final step of a GenLayer relay.
 *
 * The API independently verifies the finalized transaction, target contract, immutable
 * market binding and finalized resolver state. This script sends no outcome or evidence.
 *
 * This path settles SIMULATION markets only. A market with a deployed
 * `PredictionMarket` settles by calling `publish_preliminary()` on the contract,
 * which reads the resolver itself; the API refuses to settle it (`ONCHAIN_MARKET`).
 */
import { chains } from 'genlayer-js';

const marketId = process.env.MARKET_ID;
const resolverAddress = process.env.GENLAYER_RESOLVER_CONTRACT;
const transactionHash = process.env.GENLAYER_RESOLUTION_TX;
const base = process.env.API_BASE || 'http://localhost:8000';
const key = process.env.RESOLVER_API_KEY;
const network = process.env.GENLAYER_NETWORK || 'testnetBradbury';

if (!marketId) throw new Error('Set MARKET_ID');
if (!resolverAddress) throw new Error('Set GENLAYER_RESOLVER_CONTRACT to the resolver deployed for this market');
if (!key) throw new Error('RESOLVER_API_KEY is required');
if (!transactionHash) throw new Error('Set GENLAYER_RESOLUTION_TX to the finalized resolve() transaction');
if (!chains[network]) throw new Error(`Unknown GENLAYER_NETWORK "${network}"; expected one of ${Object.keys(chains).join(', ')}`);
const response = await fetch(`${base}/v1/internal/markets/${encodeURIComponent(marketId)}/preliminary`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Resolver-Key': key },
  body: JSON.stringify({ contractAddress: resolverAddress, transactionHash }),
});
const data = await response.json();
if (!response.ok) throw new Error(data.error?.message || 'Could not publish resolution');
console.log(JSON.stringify({ resolver: resolverAddress, transactionHash, market: marketId, status: data.status, outcome: data.preliminaryOutcome }, null, 2));
