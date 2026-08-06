import { createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';
import type { DecodedDeployData, GenLayerTransaction, TransactionHash } from 'genlayer-js/types';
import type { Market } from './types';
import numericCode from '../genlayer/contracts/NumericResolver.py?raw';
import structuredCode from '../genlayer/contracts/StructuredFactResolver.py?raw';
import judgmentCode from '../genlayer/contracts/JudgmentResolver.py?raw';

export type Progress = (message: string) => void;
export type Address = `0x${string}`;

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

export async function deployMarketResolver(market: Market, address: string, progress: Progress = () => undefined) {
  const client = clientFor(address);
  progress('Switching MetaMask to GenLayer Bradbury…');
  await switchToBradbury();
  const payload = deployPayload(market, address);
  progress('Confirm the resolver deployment in MetaMask…');
  const hash = await client.deployContract({ code: payload.code, args: payload.args, leaderOnly: false });
  progress(`Deployment submitted (${hash.slice(0, 10)}…). Waiting for GenLayer finality…`);
  const receipt = await client.waitForTransactionReceipt({ hash: hash as TransactionHash, status: TransactionStatus.FINALIZED, interval: 5_000, retries: 240 });
  if (receipt.statusName !== TransactionStatus.FINALIZED || (receipt.txExecutionResultName && receipt.txExecutionResultName !== 'FINISHED_WITH_RETURN')) {
    throw new Error(`Resolver deployment failed with ${receipt.statusName || 'unknown'} / ${receipt.txExecutionResultName || 'unknown'}`);
  }
  const resolverAddress = contractAddress(receipt);
  progress(`Resolver finalized at ${resolverAddress}. Verifying immutable binding…`);
  return { contractAddress: resolverAddress, transactionHash: hash };
}

export async function resolveOnGenLayer(market: Market, address: string, progress: Progress = () => undefined) {
  if (!market.resolverContractAddress) throw new Error('This market has no bound resolver');
  const client = clientFor(address);
  progress('Switching MetaMask to GenLayer Bradbury…');
  await switchToBradbury();
  progress('Confirm resolve() in MetaMask…');
  const hash = await client.writeContract({
    address: market.resolverContractAddress as Address,
    functionName: 'resolve',
    args: [],
    value: 0n,
    leaderOnly: false,
  });
  progress(`Validators are reading the locked sources (${String(hash).slice(0, 10)}…). Waiting for finality…`);
  const receipt = await client.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, interval: 5_000, retries: 240 });
  if (receipt.statusName !== TransactionStatus.FINALIZED || (receipt.txExecutionResultName && receipt.txExecutionResultName !== 'FINISHED_WITH_RETURN')) {
    throw new Error(`Resolution failed with ${receipt.statusName || 'unknown'} / ${receipt.txExecutionResultName || 'unknown'}`);
  }
  progress('Resolution finalized. API is verifying the transaction and contract state…');
  return { contractAddress: market.resolverContractAddress, transactionHash: String(hash) };
}
