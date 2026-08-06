/**
 * Read every PredictionMarket in `bradbury-markets.json` back from the chain.
 *
 * No private key and no polling: this reports what Bradbury says right now, so a
 * stale manifest cannot pass for a live deployment. Every deployment attempt is
 * re-read too, since a market may carry several and only some of them landed.
 */
import { readFile } from 'node:fs/promises';
import { createClient, chains } from 'genlayer-js';
import { addressHex } from './genlayer-verifier.mjs';

const manifest = JSON.parse(await readFile(new URL('../genlayer/deployments/bradbury-markets.json', import.meta.url), 'utf8'));
const client = createClient({ chain: chains.testnetBradbury });
const result = {};

for (const [key, market] of Object.entries(manifest.markets)) {
  const attempts = [];
  for (const attempt of market.attempts || []) {
    const tx = await client.getTransaction({ hash: attempt.deploymentTx })
      .catch((error) => ({ statusName: `UNREADABLE: ${error.message}` }));
    attempts.push({
      deploymentTx: attempt.deploymentTx, leaderOnly: Boolean(attempt.leaderOnly),
      status: tx.statusName, execution: tx.txExecutionResultName,
    });
  }
  const record = { marketId: market.marketId, resolver: market.resolver, address: market.address || null, attempts };

  if (market.address) {
    // Read at the variant matching what the manifest claims: a market recorded as
    // final must answer from finalized state, not merely from the latest one.
    record.state = await client.readContract({
      address: market.address, functionName: 'market_state', args: [],
      transactionHashVariant: market.final ? 'latest-final' : 'latest-nonfinal',
    }).catch((error) => ({ error: error.message }));
    record.callable = !record.state?.error;
    record.final = Boolean(market.final);
  } else {
    record.callable = false;
    record.final = false;
    record.note = 'No deployment attempt has produced a contract that answers on chain yet';
  }
  result[key] = record;
}

// Decoded Address values are {bytes} wrappers; render them as hex so the report is
// readable and comparable rather than a dump of byte objects.
const readable = (_, value) => {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && value.bytes) return addressHex(value);
  return value;
};
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(), network: manifest.network, chainId: manifest.chainId,
  callable: Object.values(result).filter((entry) => entry.callable).length,
  final: Object.values(result).filter((entry) => entry.final).length,
  total: Object.keys(result).length,
  markets: result,
}, readable, 2));
