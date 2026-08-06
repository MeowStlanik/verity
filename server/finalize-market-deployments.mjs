/**
 * Re-check the deployment attempts recorded in `bradbury-markets.json` and record
 * the address of every market whose contract now answers on chain.
 *
 * Submitting, becoming callable and becoming final are three different events on
 * GenLayer, and the gaps between them can be long: during this project's deploy run
 * full-consensus deployments waited hundreds of blocks to be processed and then
 * stalled with votes committed and none revealed. A market therefore carries several
 * attempts, and each is reported with both facts kept apart — `callable`, meaning the
 * contract exists and can be used, and `final`, meaning consensus can no longer roll
 * it back. This script exists so a stalled deployment does not have to be re-sent.
 *
 * It sends no transactions and needs no private key.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createClient, chains } from 'genlayer-js';
import { addressHex } from './genlayer-verifier.mjs';

const manifestPath = new URL('../genlayer/deployments/bradbury-markets.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const client = createClient({ chain: chains.testnetBradbury });
const checkedAt = new Date().toISOString();
const log = (message) => process.stderr.write(`${message}\n`);

/**
 * Returns the contract address only when the chain backs it up.
 *
 * The address is never taken on the receipt's word — not even a finalized one.
 * `FINALIZED` plus `FINISHED_WITH_RETURN` does not mean a transaction had an
 * effect: that pair reports how execution went *for the leader*, not whether the
 * network adopted the result. This project hit it three times — two deployments
 * that left no contract at their address, and a `resolve()` call that left the
 * resolver's outcome untouched — each closing with `lastRound.result = 3` where a
 * healthy transaction closes with `1`. So the effect is what gets verified here,
 * never the receipt.
 *
 * So the only trustworthy evidence that a contract exists is calling it, which is
 * what happens below. It also keeps apart two claims that are not the same thing —
 * `callable`, meaning the contract answers, and `final`, meaning consensus can no
 * longer roll the deployment back. A deployment can be either without the other.
 */
async function inspect(attempt) {
  let tx;
  try {
    tx = await client.getTransaction({ hash: attempt.deploymentTx });
  } catch (error) {
    attempt.status = `UNREADABLE: ${error.message}`;
    return null;
  }
  attempt.status = tx.statusName;
  attempt.execution = tx.txExecutionResultName;
  attempt.final = tx.statusName === 'FINALIZED';
  if (tx.txExecutionResultName !== 'FINISHED_WITH_RETURN') return null;

  const address = tx.txDataDecoded?.contractAddress;
  if (!address) return null;
  try {
    await client.readContract({
      address, functionName: 'market_state', args: [],
      transactionHashVariant: attempt.final ? 'latest-final' : 'latest-nonfinal',
    });
    attempt.callable = true;
    return address;
  } catch {
    attempt.callable = false;
    return null;
  }
}

let finalized = 0;
let callable = 0;
for (const [key, market] of Object.entries(manifest.markets)) {
  const attempts = market.attempts || [];
  if (!attempts.length) { log(`${key}: no deployment attempts recorded`); continue; }

  let winner = null;
  for (const attempt of attempts) {
    const found = await inspect(attempt);
    // A finalized attempt always wins over a merely callable one.
    if (found && (!winner || (attempt.final && !winner.final))) winner = { ...attempt, address: found };
  }
  market.checkedAt = checkedAt;

  if (!winner) {
    market.address = null;
    delete market.bindingVerified;
    log(`${key}: nothing callable yet — ${attempts.map((a) => `${a.deploymentTx.slice(0, 10)}…=${a.status}`).join(', ')}`);
    continue;
  }

  const address = winner.address;
  market.address = address;
  market.callable = true;
  market.final = Boolean(winner.final);
  market.deployedBy = { deploymentTx: winner.deploymentTx, leaderOnly: Boolean(winner.leaderOnly), status: winner.status };
  try {
    const state = await client.readContract({ address, functionName: 'market_state', args: [], transactionHashVariant: market.final ? 'latest-final' : 'latest-nonfinal' });
    market.bindingVerified = state.marketId === market.marketId
      && addressHex(state.resolver).toLowerCase() === market.resolver.toLowerCase();
    market.observedOutcome = { preliminary: state.preliminaryOutcome, final: state.finalOutcome };
  } catch (error) {
    market.bindingVerified = false;
    market.note = `Deployed but market_state() could not be read at latest-final: ${error.message}`;
  }
  if (winner.final) finalized += 1;
  callable += 1;
  log(`${key}: ${winner.final ? 'FINALIZED' : 'CALLABLE (not final)'} at ${address} via ${winner.leaderOnly ? 'leader-only' : 'full consensus'} — status ${winner.status}, binding verified: ${market.bindingVerified}`);
}

manifest.checkedAt = checkedAt;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const total = Object.keys(manifest.markets).length;
log(`\n${callable} of ${total} markets are callable, ${finalized} of ${total} are finalized; manifest updated.`);
