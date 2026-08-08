import { randomBytes } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { createApi } from '../server/http-app.mjs';
import { MarketStore } from '../server/domain.mjs';
import { PostgresMarketStore, PostgresNonceStore } from '../server/postgres-store.mjs';
import { seedState } from '../server/seed.mjs';

let handlerPromise;

/**
 * Boot without a database rather than not booting at all.
 *
 * A missing `DATABASE_URL` used to throw, so every route — including the market
 * list, which is metadata a reader has no business needing an account for —
 * answered 500 and the deployed site rendered nothing. That is the wrong failure
 * for a demo: the interesting markets are on-chain ones whose GEN, shares, quotes
 * and outcome are read from Bradbury by the client, and whose value-moving calls
 * the API refuses anyway. None of that needs Postgres.
 *
 * So a deployment with no database serves the seed from a per-instance file in
 * /tmp. Reads are correct. Writes are not durable: Vercel gives each function
 * instance its own /tmp and recycles it, so a simulation trade may be invisible
 * to the next request and is certainly gone tomorrow. That degradation is
 * announced — in the logs, in `/health`, and on every response through
 * `X-Verity-Storage` — because a store that silently forgets is worse than one
 * that says so. Add Neon and the durable path takes over on the next boot.
 */
async function buildStore(challengeWindowSeconds) {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (databaseUrl) {
    const store = await new PostgresMarketStore({ databaseUrl, seed: seedState, challengeWindowSeconds }).init();
    return { store, nonceStore: new PostgresNonceStore(neon(databaseUrl)), storage: 'postgres' };
  }
  console.warn(
    'DATABASE_URL is not set. Serving the seed from an ephemeral /tmp store: reads work, writes do not survive '
    + 'this function instance. Connect a Neon Postgres integration from the Vercel Marketplace for a durable API.',
  );
  const store = await new MarketStore({ file: '/tmp/verity-db.json', seed: seedState, challengeWindowSeconds }).init();
  return { store, nonceStore: undefined, storage: 'ephemeral' };
}

async function buildHandler() {
  const requested = Number(process.env.CHALLENGE_WINDOW_SECONDS || 1800);
  const challengeWindowSeconds = Number.isFinite(requested) && requested >= 60 ? requested : 1800;
  const { store, nonceStore, storage } = await buildStore(challengeWindowSeconds);
  // Never fall through to http-app's development default: it is a published
  // constant, and anything holding a session signed with it is forgeable by
  // anyone who has read the repository. A generated secret costs sessions their
  // survival across instances, which is the lesser loss.
  const authSecret = process.env.AUTH_SECRET || randomBytes(32).toString('hex');
  if (!process.env.AUTH_SECRET) {
    console.warn('AUTH_SECRET is not set. Signing sessions with a per-instance random secret; sign-ins will not persist.');
  }
  const api = await createApi({ store, nonceStore, authSecret, corsOrigin: '', storage });
  return { api, storage };
}

export default async function handler(req, res) {
  try {
    handlerPromise ||= buildHandler();
    const { api, storage } = await handlerPromise;
    const route = Array.isArray(req.query?.route) ? req.query.route.join('/') : req.query?.route;
    req.verityPath = `/${String(route || '').replace(/^\/+/, '')}`;
    res.setHeader('X-Verity-Storage', storage);
    return await api(req, res);
  } catch (error) {
    handlerPromise = undefined;
    console.error(error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ error: { code: 'API_BOOT_FAILED', message: error.message || 'API failed to start' } }));
  }
}
