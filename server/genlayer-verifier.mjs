import { createClient, chains } from 'genlayer-js';
import { ApiError } from './domain.mjs';
import { canonicalJson } from './canonical.mjs';

/**
 * genlayer-js decodes a contract's `Address` return value to a `CalldataAddress`
 * wrapper holding raw bytes, not to a hex string. `String()` on one silently
 * yields "[object Object]", which would make every address comparison here pass
 * or fail for the wrong reason, so decoded addresses go through this first.
 */
export function addressHex(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const bytes = value.bytes ?? value;
  if (typeof bytes !== 'object') return String(value);
  const octets = Array.from(bytes instanceof Uint8Array || Array.isArray(bytes) ? bytes : Object.values(bytes));
  if (octets.length !== 20) return String(value);
  return `0x${octets.map((byte) => Number(byte).toString(16).padStart(2, '0')).join('')}`;
}

const addressEq = (a, b) => addressHex(a).toLowerCase() === addressHex(b).toLowerCase();
const expectedConfig = (market) => ({ contract: market.resolutionSpec?.resolver?.contract, question: market.title, ...(market.resolutionSpec?.resolver?.args || {}) });

function assertBinding(market, binding, config) {
  const expected = market.resolverBinding;
  if (!expected || binding?.marketId !== expected.marketId || binding?.resolutionSpecHash !== expected.resolutionSpecHash || binding?.sourcesHash !== expected.sourcesHash || binding?.observationTime !== expected.observationTime) {
    throw new ApiError('RESOLVER_BINDING_MISMATCH', 'Resolver market/spec/sources/time binding does not match this market', 422);
  }
  if (canonicalJson(config) !== canonicalJson(expectedConfig(market))) throw new ApiError('RESOLVER_CONFIG_MISMATCH', 'Resolver executable configuration does not match the locked market spec', 422);
}

export async function verifyGenLayerBinding(market, contractAddress, options = {}) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(contractAddress || ''))) throw new ApiError('INVALID_RESOLVER', 'A valid GenLayer resolver address is required');
  const chain = chains[market.resolverNetwork || 'testnetBradbury'];
  if (!chain) throw new ApiError('INVALID_RESOLVER_NETWORK', 'The market names an unsupported GenLayer network', 422);
  const client = options.client || createClient({ chain, endpoint: process.env.GENLAYER_RPC_URL });
  try {
    const [binding, config] = await Promise.all([
      client.readContract({ address: contractAddress, functionName: 'market_binding', args: [], transactionHashVariant: 'latest-final' }),
      client.readContract({ address: contractAddress, functionName: 'resolver_config', args: [], transactionHashVariant: 'latest-final' }),
    ]);
    assertBinding(market, binding, config);
    return { verified: true, contractAddress };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('GENLAYER_VERIFICATION_FAILED', `Could not verify GenLayer resolver binding: ${error.message}`, 502);
  }
}

/**
 * Verify a deployed PredictionMarket before the API will point users at it.
 *
 * The contract itself carries the market id, the two hashes, the observation time
 * and the resolver it will settle from. All five are compared against the locked
 * draft, so a creator cannot bind a lookalike contract that pays out differently.
 */
export async function verifyMarketContract(market, contractAddress, options = {}) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(contractAddress || ''))) throw new ApiError('INVALID_MARKET_CONTRACT', 'A valid PredictionMarket address is required');
  const chain = chains[market.resolverNetwork || 'testnetBradbury'];
  if (!chain) throw new ApiError('INVALID_RESOLVER_NETWORK', 'The market names an unsupported GenLayer network', 422);
  const client = options.client || createClient({ chain, endpoint: process.env.GENLAYER_RPC_URL });
  let state;
  try {
    state = await client.readContract({ address: contractAddress, functionName: 'market_state', args: [], transactionHashVariant: 'latest-final' });
  } catch (error) {
    throw new ApiError('GENLAYER_VERIFICATION_FAILED', `Could not read finalized PredictionMarket state: ${error.message}`, 502);
  }
  const expected = market.resolverBinding;
  if (!expected || state?.marketId !== expected.marketId || state?.resolutionSpecHash !== expected.resolutionSpecHash
      || state?.sourcesHash !== expected.sourcesHash || state?.observationTime !== expected.observationTime) {
    throw new ApiError('MARKET_CONTRACT_MISMATCH', 'PredictionMarket is not bound to this market/spec/sources/time', 422);
  }
  if (!addressEq(state?.resolver, market.resolverContractAddress)) {
    throw new ApiError('MARKET_RESOLVER_MISMATCH', 'PredictionMarket would settle from a different resolver than this market locked', 422);
  }
  return { verified: true, contractAddress, transactionHash: options.transactionHash || null, state };
}

function assertResolveCall(tx) {
  const decoded = tx.txDataDecoded;
  const call = decoded?.callData ?? decoded;
  const method = call instanceof Map ? call.get('method') : call?.method ?? call?.functionName ?? call?.name;
  if (decoded?.type !== 'call' || method !== 'resolve') throw new ApiError('WRONG_RESOLVER_TRANSACTION', 'The finalized transaction did not call resolve()', 422);
}

/**
 * Turns a transaction hash into the only settlement envelope accepted by MarketStore.
 * No caller-controlled outcome survives this function.
 */
export async function verifyGenLayerResolution(market, payload, options = {}) {
  const contractAddress = String(payload?.contractAddress || '');
  const transactionHash = String(payload?.transactionHash || '');
  const expectedAddress = options.dispute ? market.disputeResolverContractAddress : market.resolverContractAddress;
  if ((!expectedAddress && !options.allowUnbound) || (expectedAddress && !addressEq(contractAddress, expectedAddress))) throw new ApiError('RESOLVER_MISMATCH', 'Resolver address is not the resolver locked to this market', 422);
  if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) throw new ApiError('INVALID_TRANSACTION_HASH', 'A GenLayer resolution transaction hash is required');
  const chain = chains[market.resolverNetwork || 'testnetBradbury'];
  if (!chain) throw new ApiError('INVALID_RESOLVER_NETWORK', 'The market names an unsupported GenLayer network', 422);
  const client = options.client || createClient({ chain, endpoint: process.env.GENLAYER_RPC_URL });
  let tx, binding, resolution, config;
  try {
    tx = await client.getTransaction({ hash: transactionHash });
    if (tx.statusName !== 'FINALIZED') throw new ApiError('RESOLUTION_NOT_FINALIZED', `GenLayer transaction is ${tx.statusName || 'unknown'}, not FINALIZED`, 409);
    if (tx.txExecutionResultName !== 'FINISHED_WITH_RETURN' && tx.txExecutionResult !== 1) throw new ApiError('RESOLUTION_EXECUTION_FAILED', 'GenLayer resolve() did not finish successfully', 422);
    if (!addressEq(tx.recipient || tx.to_address, contractAddress)) throw new ApiError('TRANSACTION_TARGET_MISMATCH', 'Transaction was finalized for another contract', 422);
    assertResolveCall(tx);
    [binding, resolution, config] = await Promise.all([
      client.readContract({ address: contractAddress, functionName: 'market_binding', args: [], transactionHashVariant: 'latest-final' }),
      client.readContract({ address: contractAddress, functionName: 'resolution', args: [], transactionHashVariant: 'latest-final' }),
      client.readContract({ address: contractAddress, functionName: 'resolver_config', args: [], transactionHashVariant: 'latest-final' }),
    ]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('GENLAYER_VERIFICATION_FAILED', `Could not verify finalized GenLayer state: ${error.message}`, 502);
  }
  assertBinding(market, binding, config);
  if (!['YES', 'NO', 'VOID'].includes(resolution?.outcome) || !resolution?.resolvedAt) throw new ApiError('RESOLVER_NOT_RESOLVED', 'Resolver has no completed outcome', 409);
  if (Date.parse(resolution.resolvedAt) < Date.parse(market.resolverBinding.observationTime)) throw new ApiError('RESOLVED_TOO_EARLY', 'Resolver executed before the locked observation time', 422);
  const contentHashes = String(resolution.sourceDigests || '').split(',').filter(Boolean);
  if (contentHashes.length !== 3 || contentHashes.some((hash) => !/^[a-fA-F0-9]{64}$/.test(hash))) throw new ApiError('INVALID_SOURCE_SNAPSHOTS', 'Resolver did not commit exactly three source snapshots', 422);
  return {
    verified: true,
    outcome: resolution.outcome,
    voidReason: resolution.outcome === 'VOID' ? resolution.evidence : undefined,
    evidence: [{ resolver: contractAddress, network: market.resolverNetwork, transactionHash, resolvedAt: resolution.resolvedAt, detail: resolution.evidence || null }],
    contentHashes,
  };
}
