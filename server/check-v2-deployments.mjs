import { readFile } from 'node:fs/promises';
import { createClient, chains } from 'genlayer-js';

const manifest = JSON.parse(await readFile(new URL('../genlayer/deployments/bradbury-v2.json', import.meta.url), 'utf8'));
const client = createClient({ chain: chains.testnetBradbury });
const result = {};
for (const [key, entry] of Object.entries(manifest.contracts)) {
  const transaction = await client.getTransaction({ hash: entry.deploymentTx });
  const [binding, config, resolution] = await Promise.all([
    client.readContract({ address: entry.address, functionName: 'market_binding', args: [], transactionHashVariant: 'latest-final' }),
    client.readContract({ address: entry.address, functionName: 'resolver_config', args: [], transactionHashVariant: 'latest-final' }),
    client.readContract({ address: entry.address, functionName: 'resolution', args: [], transactionHashVariant: 'latest-final' }),
  ]);
  result[key] = { address: entry.address, status: transaction.statusName, execution: transaction.txExecutionResultName, binding, config, resolution };
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), contracts: result }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
