import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MarketStore } from '../domain.mjs';
import { createApi } from '../http-app.mjs';
import { seedState } from '../seed.mjs';

test('shared HTTP app serves health and seeded markets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new MarketStore({ file: join(directory, 'db.json'), seed: seedState }).init();
  const handler = await createApi({ store, authSecret: 'test-secret' });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const markets = await fetch(`http://127.0.0.1:${port}/v1/markets`);
  assert.equal(markets.status, 200);
  const items = (await markets.json()).items;
  assert.equal(items.length, 4);
  // Both settlement kinds must ship, or the ON-CHAIN badge has nothing to contrast with.
  assert.ok(items.some((market) => market.settlement === 'onchain'));
  assert.ok(items.some((market) => market.settlement === 'simulation'));
});

test('wallet nonce survives through the shared API abstraction', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new MarketStore({ file: join(directory, 'db.json'), seed: seedState }).init();
  const server = http.createServer(await createApi({ store, authSecret: 'test-secret' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const address = '0x0000000000000000000000000000000000000001';
  const response = await fetch(`http://127.0.0.1:${port}/v1/auth/nonce`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }),
  });
  assert.equal(response.status, 200);
  assert.match((await response.json()).nonce, /Verity Markets login/);
});

test('on-chain markets are served with their contract and refuse ledger writes over HTTP', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-onchain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new MarketStore({ file: join(directory, 'db.json'), seed: seedState }).init();
  const server = http.createServer(await createApi({ store, authSecret: 'test-secret' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const { items } = await (await fetch(`http://127.0.0.1:${port}/v1/markets`)).json();
  const onchain = items.filter((market) => market.settlement === 'onchain');
  assert.ok(onchain.length, 'the seed should carry at least one market backed by a deployed contract');
  for (const market of onchain) assert.match(market.marketContractAddress, /^0x[a-fA-F0-9]{40}$/);

  // Binding a market contract is a wallet action, so an unauthenticated caller must
  // not reach the chain-verification path at all.
  const bind = await fetch(`http://127.0.0.1:${port}/v1/markets/${onchain[0].id}/contract`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contractAddress: `0x${'ab'.repeat(20)}` }),
  });
  assert.equal(bind.status, 401);

  // And the ledger endpoints stay shut for a market the contract owns, even with a
  // valid session, so the API can never hold a second set of balances beside it.
  const trade = await fetch(`http://127.0.0.1:${port}/v1/trades`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ marketId: onchain[0].id, side: 'YES', amount: 1 }),
  });
  assert.equal(trade.status, 401);
});
