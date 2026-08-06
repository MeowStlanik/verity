import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresMarketStore } from '../postgres-store.mjs';

function fakePostgres() {
  const database = { version: null, data: null };
  return async function sql(strings, ...values) {
    const statement = strings.join('?').replace(/\s+/g, ' ').trim().toUpperCase();
    if (statement.startsWith('CREATE TABLE')) return [];
    if (statement.startsWith('INSERT INTO VERITY_MARKET_STATE')) {
      if (database.data === null) { database.version = 0; database.data = JSON.parse(values[0]); }
      return [];
    }
    if (statement.startsWith('SELECT VERSION, DATA')) {
      return [{ version: String(database.version), data: structuredClone(database.data) }];
    }
    if (statement.startsWith('UPDATE VERITY_MARKET_STATE')) {
      const [serialized, expectedVersion] = values;
      // Yield here so independently cached serverless stores can race in the test.
      await new Promise((resolve) => setImmediate(resolve));
      if (database.version !== Number(expectedVersion)) return [];
      database.data = JSON.parse(serialized);
      database.version += 1;
      return [{ version: String(database.version) }];
    }
    throw new Error(`Unexpected SQL in test: ${statement}`);
  };
}

test('Postgres CAS retries instead of losing concurrent serverless trades', async () => {
  const sql = fakePostgres();
  // The fixture is built here rather than taken from the shipped seed: what is
  // under test is the ledger's compare-and-swap, and the ledger only ever settles
  // simulation markets. Pulling a market out of the seed made this test fail the
  // moment that market got a deployed PredictionMarket and started refusing ledger
  // trades — a deployment has no business breaking a concurrency test.
  const marketId = 'cas-fixture-market';
  const seed = {
    markets: [{
      id: marketId, title: 'CAS fixture', category: 'Test', type: 'judgment', status: 'trading',
      outcome: null, preliminaryOutcome: null, probability: .5, volume: 0, liquidity: 100,
      closesAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', feeBps: 200,
      resolutionSpec: { summary: 'x', criteria: ['x'] }, sources: [], settlementStages: [],
      challenge: null, priceHistory: [.5], settlement: 'simulation', marketContractAddress: null,
    }],
    portfolios: {}, marketRuntime: {}, challenges: [], liquidityPositions: {},
  };
  const first = await new PostgresMarketStore({ sql, seed }).init();
  const second = await new PostgresMarketStore({ sql, seed }).init();
  const before = await first.getMarket(marketId);

  await Promise.all([
    first.trade('0x0000000000000000000000000000000000000011', { marketId, side: 'YES', amount: 0.2 }),
    second.trade('0x0000000000000000000000000000000000000022', { marketId, side: 'NO', amount: 0.3 }),
  ]);

  const after = await first.getMarket(marketId);
  assert.equal(after.volume, Number((before.volume + 0.5).toFixed(2)));
  assert.equal(after.recentTrades.filter((fill) => ['0x0000000000000000000000000000000000000011', '0x0000000000000000000000000000000000000022'].includes(fill.trader)).length, 2);
});
