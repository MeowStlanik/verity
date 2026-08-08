import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

/**
 * The Vercel entry point used to throw when `DATABASE_URL` was absent, which meant
 * a deployment with no database integration answered 500 on every route and showed
 * a reader nothing at all — including the market list, which is public metadata.
 * These tests hold it to the weaker promise it makes now: boot anyway, serve reads,
 * and say plainly that the store is not durable.
 */
const withoutDatabase = async (t) => {
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'AUTH_SECRET']) delete process.env[key];
  // The handler memoizes its boot across invocations, so each test imports a fresh
  // module instance rather than inheriting whichever store booted first.
  const { default: handler } = await import(`../../api/index.js?case=${Math.random()}`);
  const server = http.createServer((req, res) => {
    req.query = { route: new URL(req.url, 'http://localhost').pathname.replace(/^\/+/, '') };
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

test('the Vercel API boots without a database and serves the seeded markets', async (t) => {
  const base = await withoutDatabase(t);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'verity-markets-api', storage: 'ephemeral', durable: false });

  const markets = await fetch(`${base}/v1/markets`);
  assert.equal(markets.status, 200);
  assert.ok((await markets.json()).items.length > 0, 'a reader with no database still gets the market list');
});

test('a database-less deployment admits it on every response', async (t) => {
  const base = await withoutDatabase(t);
  // A store that silently forgets writes is worse than one that says so, and the
  // header is the part a client can check without a round trip to /health.
  for (const path of ['/health', '/v1/markets']) {
    assert.equal((await fetch(base + path)).headers.get('x-verity-storage'), 'ephemeral', path);
  }
});
