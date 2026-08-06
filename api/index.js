import { neon } from '@neondatabase/serverless';
import { createApi } from '../server/http-app.mjs';
import { PostgresMarketStore, PostgresNonceStore } from '../server/postgres-store.mjs';
import { seedState } from '../server/seed.mjs';

let handlerPromise;

async function buildHandler() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) throw new Error('Connect a Neon Postgres integration so DATABASE_URL is available');
  if (!process.env.AUTH_SECRET) throw new Error('Set AUTH_SECRET in the Vercel project environment variables');
  const challengeWindowSeconds = Number(process.env.CHALLENGE_WINDOW_SECONDS || 1800);
  const store = await new PostgresMarketStore({
    databaseUrl,
    seed: seedState,
    challengeWindowSeconds: Number.isFinite(challengeWindowSeconds) && challengeWindowSeconds >= 60 ? challengeWindowSeconds : 1800,
  }).init();
  const nonceStore = new PostgresNonceStore(neon(databaseUrl));
  return createApi({ store, nonceStore, corsOrigin: '' });
}

export default async function handler(req, res) {
  try {
    handlerPromise ||= buildHandler();
    const route = Array.isArray(req.query?.route) ? req.query.route.join('/') : req.query?.route;
    req.verityPath = `/${String(route || '').replace(/^\/+/, '')}`;
    return await (await handlerPromise)(req, res);
  } catch (error) {
    handlerPromise = undefined;
    console.error(error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ error: { code: 'API_BOOT_FAILED', message: error.message || 'API failed to start' } }));
  }
}
