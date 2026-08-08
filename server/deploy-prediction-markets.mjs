/**
 * Deploy one PredictionMarket per finalized resolver in `bradbury-v2.json`.
 *
 * Deployments are sequential and polling is bounded: if Bradbury has not
 * finalized a transaction by the time the budget runs out, the script records
 * the hash and the last observed status and moves on. It never invents an
 * address and never reports a predicted address as finalized.
 */
import { readFile } from 'node:fs/promises';
import { createAccount, createClient, chains } from 'genlayer-js';
import { addressHex } from './genlayer-verifier.mjs';

if (process.env.CONFIRM_BRADBURY_DEPLOY !== 'YES') {
  throw new Error('Set CONFIRM_BRADBURY_DEPLOY=YES to authorize paid deployments on Bradbury');
}

const FEE_BPS = 200;
const CHALLENGE_WINDOW_SECONDS = 600;
const MIN_CHALLENGE_STAKE_WEI = 10n ** 17n; // 0.1 GEN
/**
 * The adjudicator every market deployed by this script will be bound to.
 *
 * There is no default. `PredictionMarket` refuses a zero dispute resolver, because
 * a market that cannot adjudicate a challenge can only void on one, and that made
 * the minimum stake a free option to cancel any market. This script binds markets
 * to resolvers that already exist rather than deploying them, so it has nothing to
 * clone into an adjudicator and asks for one instead. `npm run genlayer:live-demo`
 * is the path that deploys its own.
 */
const DISPUTE_RESOLVER = process.env.DISPUTE_RESOLVER || '';
if (!/^0x[a-fA-F0-9]{40}$/.test(DISPUTE_RESOLVER)) {
  throw new Error(
    'Set DISPUTE_RESOLVER=0x… to the adjudicator these markets should appeal to. It must be bound to the same '
    + 'market ID, spec hash, sources hash and observation time as the resolver it adjudicates, or finalize() will '
    + 'not accept its answer. Use `npm run genlayer:live-demo` for a market that deploys both resolvers itself.',
  );
}
const POLL_INTERVAL_MS = 15_000;
// Bradbury finality observed at roughly 15 minutes for a deployment (PROPOSING →
// COMMITTING → APPEAL_COMMITTING → FINALIZED). 20 minutes leaves headroom without
// turning this into an open-ended wait; past that the hash is recorded and the
// script moves on, and `npm run genlayer:markets` re-checks later.
const POLL_RETRIES = 80;

/**
 * LEADER_ONLY=1 asks consensus to run the deployment on the leader alone instead of
 * the full validator round. The constructor is entirely deterministic — integer
 * arithmetic and storage writes, no web or LLM access — so nothing is being hidden
 * from validators that they could have disagreed about. It is worth reaching for
 * when the network is congested and full rounds are stalling in commit/reveal.
 *
 * The trade-off is real and belongs in the record: a leader-only deployment carries
 * one node's word for the constructor arguments rather than a validated round. Use
 * it for testnet demos, not for a market meant to hold value.
 */
const LEADER_ONLY = process.env.LEADER_ONLY === '1';

const root = new URL('..', import.meta.url);
const secretFile = process.env.RELAYER_KEY_FILE || new URL('.secrets/genlayer-relayer.json', root);
const secret = JSON.parse(await readFile(secretFile, 'utf8'));
const privateKey = process.env.GENLAYER_PRIVATE_KEY || secret.privateKey;
if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey || '')) throw new Error('Missing a valid GenLayer private key');
const account = createAccount(privateKey);
if (secret.address && secret.address.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error('Secret address does not match its private key');
}

const client = createClient({ chain: chains.testnetBradbury, account });
const manifest = JSON.parse(await readFile(new URL('genlayer/deployments/bradbury-v2.json', root), 'utf8'));
const code = await readFile(new URL('genlayer/contracts/PredictionMarket.py', root), 'utf8');
const only = process.argv.slice(2).filter((value) => !value.startsWith('-'));

const log = (message) => process.stderr.write(`${message}\n`);
const results = {};

for (const [key, entry] of Object.entries(manifest.contracts)) {
  if (only.length && !only.includes(key)) continue;
  log(`\n=== ${key}: resolver ${entry.address} ===`);
  const [binding, config] = await Promise.all([
    client.readContract({ address: entry.address, functionName: 'market_binding', args: [], transactionHashVariant: 'latest-final' }),
    client.readContract({ address: entry.address, functionName: 'resolver_config', args: [], transactionHashVariant: 'latest-final' }),
  ]);
  // Constructor arguments come from the resolver's own finalized state, so the
  // market cannot be bound to a spec the resolver does not actually enforce.
  const args = [
    binding.marketId, config.question, entry.address, DISPUTE_RESOLVER,
    binding.resolutionSpecHash, binding.sourcesHash, binding.observationTime,
    FEE_BPS, CHALLENGE_WINDOW_SECONDS, MIN_CHALLENGE_STAKE_WEI,
  ];
  log(`marketId=${binding.marketId} observationTime=${binding.observationTime}`);

  const deploymentTx = await client.deployContract({ code, args, leaderOnly: LEADER_ONLY });
  log(`submitted ${deploymentTx}${LEADER_ONLY ? ' (leader-only)' : ''}`);
  const record = { resolver: entry.address, deploymentTx, marketId: binding.marketId, binding, leaderOnly: LEADER_ONLY, status: 'UNKNOWN' };
  results[key] = record;

  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash: deploymentTx, status: 'FINALIZED', interval: POLL_INTERVAL_MS, retries: POLL_RETRIES });
  } catch (error) {
    const observed = await client.getTransaction({ hash: deploymentTx }).catch(() => null);
    record.status = observed?.statusName || 'PENDING';
    record.note = `Not finalized within ${POLL_INTERVAL_MS * POLL_RETRIES / 1000}s: ${error.message}`;
    log(`NOT FINALIZED (${record.status}); recorded the hash and moved on`);
    continue;
  }
  record.status = receipt.statusName;
  record.execution = receipt.txExecutionResultName;
  if (receipt.txExecutionResultName !== 'FINISHED_WITH_RETURN') {
    log(`deployment failed: ${receipt.txExecutionResultName}`);
    continue;
  }
  const address = receipt.txDataDecoded?.contractAddress;
  if (!address) { record.note = 'Finalized receipt carried no contract address'; continue; }
  record.address = address;
  record.state = await client.readContract({ address, functionName: 'market_state', args: [], transactionHashVariant: 'latest-final' });
  const state = record.state;
  record.bindingVerified = state.marketId === binding.marketId
    && state.resolutionSpecHash === binding.resolutionSpecHash
    && state.sourcesHash === binding.sourcesHash
    && state.observationTime === binding.observationTime
    && addressHex(state.resolver).toLowerCase() === entry.address.toLowerCase();
  log(`finalized at ${address}; binding verified: ${record.bindingVerified}`);
}

const balance = await client.getBalance({ address: account.address });
// Decoded `Address` values are {bytes} wrappers; render them as hex so the manifest
// is readable and comparable rather than a dump of byte objects.
const readable = (_, value) => {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && value.bytes) return addressHex(value);
  return value;
};
console.log(JSON.stringify({
  version: 3, network: 'GenLayer Bradbury Testnet', chainId: 4221, deployedAt: new Date().toISOString(),
  relayer: account.address, remainingBalanceWei: balance.toString(),
  parameters: { feeBps: FEE_BPS, challengeWindowSeconds: CHALLENGE_WINDOW_SECONDS, minChallengeStakeWei: MIN_CHALLENGE_STAKE_WEI.toString(), disputeResolver: DISPUTE_RESOLVER },
  markets: results,
}, readable, 2));
