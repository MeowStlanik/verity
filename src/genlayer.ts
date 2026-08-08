import { createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';
import type { DecodedDeployData, GenLayerTransaction, TransactionHash } from 'genlayer-js/types';
import type { Market } from './types';
import numericCode from '../genlayer/contracts/NumericResolver.py?raw';
import structuredCode from '../genlayer/contracts/StructuredFactResolver.py?raw';
import judgmentCode from '../genlayer/contracts/JudgmentResolver.py?raw';

/**
 * The machine-readable half of a progress report.
 *
 * A signed transaction on Bradbury is followed by roughly fifteen minutes of
 * consensus during which nothing in the wallet moves. A sentence alone cannot
 * carry that: the UI needs the stage to name it, the hash to link to it, and a
 * start time to run its own clock against, so the wait looks like a wait rather
 * than a hang. Every field is optional — callers that only have a sentence keep
 * passing one.
 */
export interface ProgressDetail {
  /** The transaction being awaited, if the flow has reached one. */
  hash?: string;
  /** Consensus stage as the chain last reported it: PROPOSING, COMMITTING, … */
  stage?: string;
  /** Epoch ms the wait began, so a component can tick a timer per second. */
  startedAt?: number;
  /** Position in a multi-transaction flow, for "step 2 of 3". */
  step?: { index: number; total: number; label: string };
  /** Set once the wait ends, so a banner can stop claiming to be busy. */
  done?: boolean;
}
export type Progress = (message: string, detail?: ProgressDetail) => void;
export type Address = `0x${string}`;

/** 20 minutes, which is what Bradbury needs; the deploy scripts use the same. */
export const FINALITY_POLL_MS = 10_000;
export const FINALITY_RETRIES = 120;
export const EXPLORER = 'https://explorer-bradbury.genlayer.com';

/**
 * Poll a transaction to finality, reporting where it is on every tick.
 *
 * `waitForTransactionReceipt` is silent until it returns, so the three flows
 * that used it each went quiet for the whole fifteen minutes right after the
 * user signed — the point at which they most need to be told something is
 * happening. This costs one extra read per tick and buys that.
 */
export async function awaitFinality(
  client: ReturnType<typeof clientFor>,
  hash: string,
  progress: Progress,
  step?: ProgressDetail['step'],
): Promise<GenLayerTransaction> {
  const startedAt = Date.now();
  const base = { hash, startedAt, step };
  progress('Submitted to Bradbury. Waiting for validator consensus…', { ...base, stage: 'SUBMITTED' });
  for (let attempt = 0; attempt < FINALITY_RETRIES; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, FINALITY_POLL_MS));
    const observed = await client.getTransaction({ hash: hash as TransactionHash }).catch(() => undefined);
    if (!observed) { progress('Waiting for Bradbury to index the transaction…', { ...base, stage: 'NOT INDEXED' }); continue; }
    const stage = String(observed.statusName || 'PENDING');
    if (observed.statusName === TransactionStatus.FINALIZED) {
      if (observed.txExecutionResultName && observed.txExecutionResultName !== 'FINISHED_WITH_RETURN') {
        throw new Error(`Transaction ${hash} finalized as ${observed.txExecutionResultName}. See ${EXPLORER}/tx/${hash}`);
      }
      progress('Finalized.', { ...base, stage: 'FINALIZED', done: true });
      return observed;
    }
    progress('Consensus in progress. Keep this tab open.', { ...base, stage });
  }
  // Bounded polling: report the hash honestly instead of pretending finality.
  throw new Error(`Transaction ${hash} has not finalized after ${FINALITY_POLL_MS * FINALITY_RETRIES / 60_000} minutes. It may still finalize — watch ${EXPLORER}/tx/${hash}, and once it reads FINALIZED bind it from the market page instead of deploying again.`);
}

export function clientFor(address: string) {
  if (!window.ethereum) throw new Error('Install MetaMask or another EIP-1193 wallet');
  return createClient({
    chain: testnetBradbury,
    account: address as Address,
    provider: window.ethereum,
  });
}

/** Reads need no wallet: anyone may query finalized Bradbury state. */
export function readClient() {
  return createClient({ chain: testnetBradbury });
}

export async function switchToBradbury() {
  if (!window.ethereum) throw new Error('Install MetaMask or another EIP-1193 wallet');
  const chainId = '0x107d'; // 4221
  const current = String(await window.ethereum.request({ method: 'eth_chainId' }));
  if (current.toLowerCase() === chainId) return;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (caught) {
    const error = caught as { code?: number; message?: string };
    if (error.code !== 4902 && !String(error.message || '').toLowerCase().includes('unrecognized chain')) throw caught;
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId,
        chainName: 'GenLayer Bradbury Testnet',
        nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
        rpcUrls: ['https://rpc-bradbury.genlayer.com'],
        blockExplorerUrls: ['https://explorer-bradbury.genlayer.com'],
      }],
    });
  }
}

function requiredMarketFields(market: Market) {
  if (!market.resolutionSpecHash || !market.sourcesHash || !market.resolutionSpec.observationTime) {
    throw new Error('The API draft is missing its immutable GenLayer binding');
  }
  if (market.sources.length !== 3 || !market.resolutionSpec.resolver) {
    throw new Error('The draft must contain a resolver and exactly three sources');
  }
  return {
    specHash: market.resolutionSpecHash,
    sourcesHash: market.sourcesHash,
    observationTime: market.resolutionSpec.observationTime,
    resolver: market.resolutionSpec.resolver,
  };
}

function deployPayload(market: Market, authority: string) {
  const { specHash, sourcesHash, observationTime, resolver } = requiredMarketFields(market);
  const common = [authority, market.id, specHash, sourcesHash, observationTime, market.title];
  const values = resolver.args;
  const sources = values.sources as string[];
  if (!Array.isArray(sources) || sources.length !== 3) throw new Error('Resolver source configuration is invalid');

  if (market.type === 'structured') {
    return { code: structuredCode, args: [...common, String(values.criterion), ...sources] };
  }
  if (market.type === 'judgment') {
    return { code: judgmentCode, args: [...common, String(values.interpretationRule), ...sources] };
  }

  const paths = values.jsonPaths as string[];
  const timestampPaths = values.timestampPaths as string[];
  const timestampValues = values.timestampValues as string[];
  if ([paths, timestampPaths, timestampValues].some((items) => !Array.isArray(items) || items.length !== 3)) {
    throw new Error('Numeric resolver paths are invalid');
  }
  const sourceArgs = sources.flatMap((source, index) => [source, paths[index], timestampPaths[index], timestampValues[index]]);
  return {
    code: numericCode,
    args: [...common, ...sourceArgs, String(values.comparator), Number(values.scale), Number(values.thresholdUnits), Number(values.maxSourceSpreadUnits)],
  };
}

function contractAddress(receipt: GenLayerTransaction): Address {
  const decoded = receipt.txDataDecoded as DecodedDeployData | undefined;
  const fromDecoded = decoded?.contractAddress;
  const fromData = receipt.data?.contract_address;
  const address = String(fromDecoded || fromData || '');
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('Finalized deployment did not return a contract address');
  return address as Address;
}

export async function deployMarketResolver(market: Market, address: string, progress: Progress = () => undefined, step?: ProgressDetail['step']) {
  const client = clientFor(address);
  progress('Switching MetaMask to GenLayer Bradbury…', { step });
  await switchToBradbury();
  const payload = deployPayload(market, address);
  progress('Confirm the resolver deployment in MetaMask…', { step, stage: 'AWAITING SIGNATURE' });
  const hash = await client.deployContract({ code: payload.code, args: payload.args, leaderOnly: false });
  const receipt = await awaitFinality(client, String(hash), progress, step);
  const resolverAddress = contractAddress(receipt);
  progress(`Resolver finalized at ${resolverAddress}. Verifying immutable binding…`, { hash: String(hash), stage: 'FINALIZED', step, done: true });
  return { contractAddress: resolverAddress, transactionHash: hash };
}

export async function resolveOnGenLayer(market: Market, address: string, progress: Progress = () => undefined) {
  if (!market.resolverContractAddress) throw new Error('This market has no bound resolver');
  const client = clientFor(address);
  progress('Switching MetaMask to GenLayer Bradbury…');
  await switchToBradbury();
  progress('Confirm resolve() in MetaMask…', { stage: 'AWAITING SIGNATURE' });
  const hash = await client.writeContract({
    address: market.resolverContractAddress as Address,
    functionName: 'resolve',
    args: [],
    value: 0n,
    leaderOnly: false,
  });
  await awaitFinality(client, String(hash), progress);
  progress('Resolution finalized. API is verifying the transaction and contract state…', { hash: String(hash), stage: 'FINALIZED', done: true });
  return { contractAddress: market.resolverContractAddress, transactionHash: String(hash) };
}
