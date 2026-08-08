import { TransactionHashVariant, TransactionStatus } from 'genlayer-js/types';
import type { CalldataEncodable, DecodedDeployData, GenLayerTransaction, TransactionHash } from 'genlayer-js/types';
import { clientFor, readClient, switchToBradbury } from './genlayer';
import type { Address, Progress } from './genlayer';
import type { Market, Side } from './types';
import marketCode from '../genlayer/contracts/PredictionMarket.py?raw';

const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as Address;
/** Long enough for a human to react, short enough for a live evaluation. */
export const ON_CHAIN_CHALLENGE_WINDOW_SECONDS = 600;
export const ON_CHAIN_MIN_CHALLENGE_STAKE_WEI = 10n ** 17n; // 0.1 GEN
export const SLIPPAGE_BPS = 100n; // 1%
const TRADE_DEADLINE_SECONDS = 120;
/**
 * 20 minutes of polling, which is what Bradbury actually needs.
 *
 * This was 5 minutes on the assumption that finality is normally quicker. It is
 * not: a deployment walks PROPOSING → COMMITTING → APPEAL_COMMITTING → FINALIZED
 * in roughly 15 minutes, so the budget expired on nearly every real deployment
 * and the flow threw *after* the contract had been paid for and deployed. The
 * server-side deploy scripts had already settled on 20 minutes; the browser now
 * matches them rather than being the one client that gives up early.
 */
const POLL_INTERVAL_MS = 10_000;
const POLL_RETRIES = 120;

export interface OnChainMarketState {
  marketId: string;
  question: string;
  creator: string;
  resolver: string;
  disputeResolver: string;
  observationTime: string;
  feeBps: number;
  challengeWindowSeconds: number;
  minChallengeStake: bigint;
  yesReserve: bigint;
  noReserve: bigint;
  collateral: bigint;
  totalYesShares: bigint;
  totalNoShares: bigint;
  refundLiability: bigint;
  lpTotal: bigint;
  lpResidual: bigint;
  preliminaryOutcome: string;
  challengeClosesAt: number;
  finalOutcome: string;
  evidence: string;
  challenger: string;
  challengeStake: bigint;
  challengeReason: string;
  probability: number;
}

export interface OnChainPosition {
  yesShares: bigint;
  noShares: bigint;
  /** The VOID refund this position would be paid today: `yesCost + noCost`. */
  paidCost: bigint;
  yesCost: bigint;
  noCost: bigint;
  lpShares: bigint;
  claimed: boolean;
  lpClaimed: boolean;
}

export interface OnChainQuote {
  shares: bigint;
  amountOut: bigint;
  fee: bigint;
  avgPrice: number;
}

export function toWei(value: string | number): bigint {
  const [whole, fraction = ''] = String(value).trim().split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) throw new Error('Enter a positive GEN amount');
  return BigInt(whole || '0') * 10n ** 18n + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
}

export function fromWei(value: bigint | number | string): number {
  return Number(BigInt(value)) / 1e18;
}

/**
 * The trading panel reads the latest state, not the finalized one.
 *
 * Bradbury's appeal window is long: a buy that has been accepted is not final for
 * some minutes afterwards. Reading `LATEST_FINAL` here would show a trader their
 * pre-trade balance right after a successful fill, which reads as a lost
 * transaction. Where a stale read would be a correctness bug rather than a
 * confusing one — the API deciding whether to bind a market contract, or the
 * contract deciding an outcome from its resolver — finalized state is still what
 * is used, and that is enforced on the server and in the contract, not here.
 */
const READ_STATE = TransactionHashVariant.LATEST_NONFINAL;

const big = (value: unknown): bigint => BigInt((value ?? 0) as string | number | bigint);
const text = (value: unknown): string => String(value ?? '');

/**
 * genlayer-js decodes a contract's `Address` return value to a `CalldataAddress`
 * wrapper holding raw bytes, not to a hex string — `String()` on one yields
 * "[object Object]". Every address read out of the contract goes through here.
 */
export function addressHex(value: unknown): string {
  if (typeof value === 'string') return value;
  const bytes = (value as { bytes?: ArrayLike<number> } | null | undefined)?.bytes;
  if (!bytes) return '';
  return `0x${Array.from(bytes, (byte) => Number(byte).toString(16).padStart(2, '0')).join('')}`;
}

function deadline(): number {
  return Math.floor(Date.now() / 1000) + TRADE_DEADLINE_SECONDS;
}

/** The minimum output a fill must produce for the client to accept it. */
export function withSlippage(amount: bigint): bigint {
  return amount * (10_000n - SLIPPAGE_BPS) / 10_000n;
}

/**
 * Poll to finality, saying out loud where the transaction is.
 *
 * `waitForTransactionReceipt` reports nothing until it returns, so a caller that
 * set one status line before it left the UI looking frozen for the fifteen
 * minutes Bradbury takes. Polling here instead costs one extra RPC read per tick
 * and buys a progress line that moves: the consensus stage the transaction is
 * actually in, and how long it has been running.
 */
async function waitFinalized(client: ReturnType<typeof clientFor>, hash: string, progress: Progress) {
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const short = `${hash.slice(0, 10)}…`;
  progress(`Submitted ${short} · waiting for GenLayer finality (Bradbury normally takes ~15 minutes)…`);
  let receipt: GenLayerTransaction | undefined;
  for (let attempt = 0; attempt < POLL_RETRIES; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const observed = await client.getTransaction({ hash: hash as TransactionHash }).catch(() => undefined);
    if (!observed) { progress(`${short} · not indexed yet · ${elapsed()} elapsed`); continue; }
    if (observed.statusName === TransactionStatus.FINALIZED) { receipt = observed; break; }
    progress(`${short} · ${observed.statusName || 'PENDING'} · ${elapsed()} elapsed · keep this tab open`);
  }
  if (!receipt) {
    // Bounded polling: report the hash honestly instead of pretending finality.
    // The contract may well be deployed by now, so say how to recover it rather
    // than leaving the caller with a transaction they paid for and cannot use.
    throw new Error(`Transaction ${hash} has not finalized after ${POLL_INTERVAL_MS * POLL_RETRIES / 1000}s. It may still finalize — open it at https://explorer-bradbury.genlayer.com/tx/${hash}, and once it reads FINALIZED use "Bind an existing market contract" on the market page to attach it. Do not deploy a second time.`);
  }
  if (receipt.statusName !== TransactionStatus.FINALIZED || (receipt.txExecutionResultName && receipt.txExecutionResultName !== 'FINISHED_WITH_RETURN')) {
    throw new Error(`Transaction ${hash} failed with ${receipt.statusName || 'unknown'} / ${receipt.txExecutionResultName || 'unknown'}`);
  }
  return receipt;
}

async function send(marketAddress: string, account: string, functionName: string, args: CalldataEncodable[], value: bigint, progress: Progress) {
  const client = clientFor(account);
  await switchToBradbury();
  progress('Confirm the transaction in MetaMask…');
  const hash = await client.writeContract({ address: marketAddress as Address, functionName, args, value, leaderOnly: false });
  await waitFinalized(client, String(hash), progress);
  return String(hash);
}

// ------------------------------------------------------------------- reading

export async function readMarketState(marketAddress: string): Promise<OnChainMarketState> {
  const raw = await readClient().readContract({
    address: marketAddress as Address, functionName: 'market_state', args: [], transactionHashVariant: READ_STATE,
  }) as Record<string, unknown>;
  const yesReserve = big(raw.yesReserve);
  const noReserve = big(raw.noReserve);
  const total = yesReserve + noReserve;
  return {
    marketId: text(raw.marketId), question: text(raw.question), creator: addressHex(raw.creator),
    resolver: addressHex(raw.resolver), disputeResolver: addressHex(raw.disputeResolver),
    observationTime: text(raw.observationTime), feeBps: Number(raw.feeBps || 0),
    challengeWindowSeconds: Number(raw.challengeWindowSeconds || 0), minChallengeStake: big(raw.minChallengeStake),
    yesReserve, noReserve, collateral: big(raw.collateral),
    totalYesShares: big(raw.totalYesShares), totalNoShares: big(raw.totalNoShares),
    refundLiability: big(raw.refundLiability), lpTotal: big(raw.lpTotal), lpResidual: big(raw.lpResidual),
    preliminaryOutcome: text(raw.preliminaryOutcome), challengeClosesAt: Number(raw.challengeClosesAt || 0),
    finalOutcome: text(raw.finalOutcome), evidence: text(raw.evidence),
    challenger: addressHex(raw.challenger), challengeStake: big(raw.challengeStake), challengeReason: text(raw.challengeReason),
    // price(YES) = noReserve / (yesReserve + noReserve), exactly as the contract prices a fill.
    probability: total > 0n ? Number(noReserve * 10_000n / total) / 10_000 : .5,
  };
}

export async function readPosition(marketAddress: string, account: string): Promise<OnChainPosition> {
  const raw = await readClient().readContract({
    address: marketAddress as Address, functionName: 'position_of', args: [account], transactionHashVariant: READ_STATE,
  }) as Record<string, unknown>;
  return {
    yesShares: big(raw.yesShares), noShares: big(raw.noShares), paidCost: big(raw.paidCost),
    yesCost: big(raw.yesCost), noCost: big(raw.noCost),
    lpShares: big(raw.lpShares), claimed: Boolean(raw.claimed), lpClaimed: Boolean(raw.lpClaimed),
  };
}

/** Quotes come from the contract itself, so the number shown is the number filled. */
export async function quoteOnChain(marketAddress: string, side: Side, action: 'buy' | 'sell', amountWei: bigint): Promise<OnChainQuote> {
  const client = readClient();
  if (action === 'buy') {
    const raw = await client.readContract({
      address: marketAddress as Address, functionName: 'quote_buy', args: [side, amountWei], transactionHashVariant: READ_STATE,
    }) as Record<string, unknown>;
    const shares = big(raw.shares);
    return { shares, amountOut: 0n, fee: big(raw.fee), avgPrice: shares > 0n ? Number(amountWei * 10_000n / shares) / 10_000 : 0 };
  }
  const raw = await client.readContract({
    address: marketAddress as Address, functionName: 'quote_sell', args: [side, amountWei], transactionHashVariant: READ_STATE,
  }) as Record<string, unknown>;
  const amountOut = big(raw.amountOut);
  return { shares: amountWei, amountOut, fee: big(raw.fee), avgPrice: amountWei > 0n ? Number(amountOut * 10_000n / amountWei) / 10_000 : 0 };
}

// ------------------------------------------------------------------ deploying

/**
 * @param disputeResolver the adjudicator a challenge on this market appeals to.
 *   Required: the contract refuses a zero address, because a market that cannot
 *   adjudicate a challenge can only void on one, which turns the minimum stake
 *   into a free option to cancel any market. Deploy a second resolver over the
 *   same locked spec and pass it here.
 */
export async function deployPredictionMarket(market: Market, account: string, disputeResolver: string, progress: Progress = () => undefined) {
  if (!market.resolverContractAddress) throw new Error('Deploy and bind the resolver before the market contract');
  if (!/^0x[a-fA-F0-9]{40}$/.test(disputeResolver) || disputeResolver === ZERO_ADDRESS) {
    throw new Error('Deploy the dispute resolver before the market contract');
  }
  if (disputeResolver.toLowerCase() === market.resolverContractAddress.toLowerCase()) {
    throw new Error('The dispute resolver must not be the resolver it adjudicates');
  }
  if (!market.resolutionSpecHash || !market.sourcesHash || !market.resolutionSpec.observationTime) {
    throw new Error('The draft is missing its immutable GenLayer binding');
  }
  const client = clientFor(account);
  progress('Switching MetaMask to GenLayer Bradbury…');
  await switchToBradbury();
  progress('Confirm the PredictionMarket deployment in MetaMask…');
  const hash = await client.deployContract({
    code: marketCode,
    args: [
      market.id, market.title, market.resolverContractAddress, disputeResolver,
      market.resolutionSpecHash, market.sourcesHash, market.resolutionSpec.observationTime,
      market.feeBps, ON_CHAIN_CHALLENGE_WINDOW_SECONDS, ON_CHAIN_MIN_CHALLENGE_STAKE_WEI,
    ],
    leaderOnly: false,
  });
  const receipt = await waitFinalized(client, String(hash), progress);
  const decoded = receipt.txDataDecoded as DecodedDeployData | undefined;
  const address = String(decoded?.contractAddress || receipt.data?.contract_address || '');
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('Finalized deployment did not return a contract address');
  progress(`Market contract finalized at ${address}.`);
  return { contractAddress: address, transactionHash: String(hash) };
}

/**
 * Recover the contract address from a deployment transaction.
 *
 * A deployment that finalizes after the browser stopped waiting leaves a paid-for
 * PredictionMarket that nothing points at, and the market silently stays a
 * simulation — trades route to the API ledger and the creator sees a fill that
 * moved no GEN. This reads the deployment back so it can be bound afterwards; it
 * needs no wallet, and the API verifies the address against the market's binding
 * before accepting it, so a wrong hash is rejected rather than believed.
 */
export async function marketContractFromDeployment(transactionHash: string) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) throw new Error('Enter the 0x… deployment transaction hash');
  const observed = await readClient().getTransaction({ hash: transactionHash as TransactionHash });
  if (!observed) throw new Error(`Bradbury does not know transaction ${transactionHash}`);
  if (observed.statusName !== TransactionStatus.FINALIZED) {
    throw new Error(`That deployment reads ${observed.statusName || 'PENDING'}, not FINALIZED. Wait for finality and try again.`);
  }
  const decoded = observed.txDataDecoded as DecodedDeployData | undefined;
  const address = String(decoded?.contractAddress || observed.data?.contract_address || '');
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('That transaction is not a contract deployment');
  return { contractAddress: address, transactionHash };
}

// ------------------------------------------------------------------- writing

export const addLiquidityOnChain = (marketAddress: string, account: string, amountWei: bigint, progress: Progress) =>
  send(marketAddress, account, 'add_liquidity', [], amountWei, progress);

export const buyOnChain = (marketAddress: string, account: string, side: Side, amountWei: bigint, minSharesOut: bigint, progress: Progress) =>
  send(marketAddress, account, side === 'YES' ? 'buy_yes' : 'buy_no', [minSharesOut, deadline()], amountWei, progress);

export const sellOnChain = (marketAddress: string, account: string, side: Side, shares: bigint, minAmountOut: bigint, progress: Progress) =>
  send(marketAddress, account, side === 'YES' ? 'sell_yes' : 'sell_no', [shares, minAmountOut, deadline()], 0n, progress);

export const publishPreliminaryOnChain = (marketAddress: string, account: string, progress: Progress) =>
  send(marketAddress, account, 'publish_preliminary', [], 0n, progress);

export const challengeOnChain = (marketAddress: string, account: string, reason: string, stakeWei: bigint, progress: Progress) =>
  send(marketAddress, account, 'challenge', [reason], stakeWei, progress);

export const finalizeOnChain = (marketAddress: string, account: string, progress: Progress) =>
  send(marketAddress, account, 'finalize', [], 0n, progress);

export const claimOnChain = (marketAddress: string, account: string, progress: Progress) =>
  send(marketAddress, account, 'claim', [], 0n, progress);

export const claimLiquidityOnChain = (marketAddress: string, account: string, progress: Progress) =>
  send(marketAddress, account, 'claim_liquidity', [], 0n, progress);
