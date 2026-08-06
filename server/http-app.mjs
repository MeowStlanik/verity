import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyMessage, isAddress } from 'viem';
import { ApiError } from './domain.mjs';
import { verifyGenLayerBinding, verifyGenLayerResolution, verifyMarketContract } from './genlayer-verifier.mjs';

class MemoryNonceStore {
  constructor() { this.nonces = new Map(); }
  async init() { return this; }
  async create(address) {
    const expiresAt = Date.now() + 300_000;
    const nonce = `Verity Markets login\nAddress: ${address}\nNonce: ${randomBytes(24).toString('hex')}\nExpires: ${new Date(expiresAt).toISOString()}`;
    for (const [key, entry] of this.nonces) if (entry.expiresAt < Date.now()) this.nonces.delete(key);
    this.nonces.set(address, { nonce, expiresAt });
    return nonce;
  }
  async get(address) {
    const entry = this.nonces.get(address);
    return entry && entry.expiresAt >= Date.now() ? entry.nonce : null;
  }
  async consume(address, nonce) {
    if (await this.get(address) !== nonce) return false;
    this.nonces.delete(address);
    return true;
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    try { return JSON.parse(String(req.body)); }
    catch { throw new ApiError('INVALID_JSON', 'Request body must be valid JSON'); }
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body exceeds 100 KB', 413);
  }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new ApiError('INVALID_JSON', 'Request body must be valid JSON'); }
}

export async function createApi({
  store,
  nonceStore = new MemoryNonceStore(),
  authSecret = process.env.AUTH_SECRET || 'development-only-change-me',
  resolverKey = process.env.RESOLVER_API_KEY || 'development-resolver-key',
  corsOrigin = process.env.CORS_ORIGIN || '',
} = {}) {
  if (!store) throw new Error('A market store is required');
  await nonceStore.init();

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && (corsOrigin === '*' || origin === corsOrigin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Resolver-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  function issueToken(address) {
    const payload = Buffer.from(JSON.stringify({ address: address.toLowerCase(), exp: Date.now() + 86_400_000 })).toString('base64url');
    return `${payload}.${createHmac('sha256', authSecret).update(payload).digest('base64url')}`;
  }
  function requireAuth(req) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token?.includes('.')) throw new ApiError('WALLET_NOT_CONNECTED', 'Connect and authenticate a wallet', 401);
    const [payload, signature] = token.split('.');
    const expected = createHmac('sha256', authSecret).update(payload).digest('base64url');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new ApiError('INVALID_TOKEN', 'Session token is invalid', 401);
    let decoded;
    try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
    catch { throw new ApiError('INVALID_TOKEN', 'Session token is invalid', 401); }
    if (!decoded.address || decoded.exp < Date.now()) throw new ApiError('TOKEN_EXPIRED', 'Session token has expired', 401);
    return decoded.address;
  }
  function requireResolver(req) {
    const given = Buffer.from(String(req.headers['x-resolver-key'] || ''));
    const expected = Buffer.from(resolverKey);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ApiError('UNAUTHORIZED_RESOLVER', 'Resolver credential required', 401);
  }

  async function route(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = req.verityPath || url.pathname;
    const query = Object.fromEntries(url.searchParams);
    delete query.route;
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, service: 'verity-markets-api', storage: process.env.DATABASE_URL || process.env.POSTGRES_URL ? 'postgres' : 'json' });
    if (req.method === 'POST' && path === '/v1/auth/nonce') {
      const { address } = await parseBody(req);
      if (!isAddress(address || '')) throw new ApiError('INVALID_ADDRESS', 'A valid wallet address is required');
      const normalized = address.toLowerCase();
      return json(res, 200, { nonce: await nonceStore.create(normalized) });
    }
    if (req.method === 'POST' && path === '/v1/auth/verify') {
      const { address, signature } = await parseBody(req);
      const normalized = String(address).toLowerCase();
      const nonce = await nonceStore.get(normalized);
      if (!nonce) throw new ApiError('NONCE_EXPIRED', 'Request a fresh sign-in nonce', 401);
      if (!isAddress(address || '') || !signature || !await verifyMessage({ address, message: nonce, signature })) throw new ApiError('INVALID_SIGNATURE', 'Wallet signature could not be verified', 401);
      if (!await nonceStore.consume(normalized, nonce)) throw new ApiError('NONCE_ALREADY_USED', 'This sign-in nonce was already used', 401);
      return json(res, 200, { token: issueToken(address), address: normalized });
    }
    if (req.method === 'GET' && path === '/v1/markets') return json(res, 200, await store.list(query));
    const marketMatch = path.match(/^\/v1\/markets\/([^/]+)$/);
    if (req.method === 'GET' && marketMatch) return json(res, 200, await store.getMarket(decodeURIComponent(marketMatch[1])));
    const seriesMatch = path.match(/^\/v1\/markets\/([^/]+)\/price-series$/);
    if (req.method === 'GET' && seriesMatch) return json(res, 200, await store.priceSeries(decodeURIComponent(seriesMatch[1]), query));
    const quoteMatch = path.match(/^\/v1\/markets\/([^/]+)\/quote$/);
    if (req.method === 'GET' && quoteMatch) return json(res, 200, await store.quote(decodeURIComponent(quoteMatch[1]), query.side, query.amount, query.action));
    const portfolioMatch = path.match(/^\/v1\/portfolio\/(0x[a-fA-F0-9]{40})$/);
    if (req.method === 'GET' && portfolioMatch) return json(res, 200, await store.getPortfolio(portfolioMatch[1]));
    if (req.method === 'POST' && path === '/v1/trades') return json(res, 201, await store.trade(requireAuth(req), await parseBody(req)));
    if (req.method === 'POST' && path === '/v1/challenges') return json(res, 201, await store.challenge(requireAuth(req), await parseBody(req)));
    if (req.method === 'POST' && path === '/v1/claims') return json(res, 201, await store.claim(requireAuth(req), await parseBody(req)));
    if (req.method === 'POST' && path === '/v1/liquidity') return json(res, 201, await store.provideLiquidity(requireAuth(req), await parseBody(req)));
    if (req.method === 'POST' && path === '/v1/liquidity/claims') return json(res, 201, await store.claimLiquidity(requireAuth(req), await parseBody(req)));
    if (req.method === 'POST' && path === '/v1/markets') return json(res, 201, await store.createMarket(requireAuth(req), await parseBody(req)));
    const bindResolver = path.match(/^\/v1\/markets\/([^/]+)\/resolver$/);
    if (req.method === 'POST' && bindResolver) {
      const caller = requireAuth(req); const id = decodeURIComponent(bindResolver[1]); const { contractAddress } = await parseBody(req); const market = await store.getMarket(id);
      return json(res, 200, await store.bindResolver(id, caller, contractAddress, await verifyGenLayerBinding(market, contractAddress)));
    }
    const bindMarketContract = path.match(/^\/v1\/markets\/([^/]+)\/contract$/);
    if (req.method === 'POST' && bindMarketContract) {
      const caller = requireAuth(req); const id = decodeURIComponent(bindMarketContract[1]);
      const { contractAddress, transactionHash } = await parseBody(req); const market = await store.getMarket(id);
      const verified = await verifyMarketContract(market, contractAddress, { transactionHash });
      return json(res, 200, await store.bindMarketContract(id, caller, contractAddress, verified));
    }
    const submitResolution = path.match(/^\/v1\/markets\/([^/]+)\/resolution$/);
    if (req.method === 'POST' && submitResolution) {
      requireAuth(req); const id = decodeURIComponent(submitResolution[1]); const payload = await parseBody(req); const market = await store.getMarket(id);
      return json(res, 200, await store.publishPreliminary(id, await verifyGenLayerResolution(market, payload)));
    }
    if (req.method === 'POST' && path === '/v1/internal/lifecycle/tick') { requireResolver(req); return json(res, 200, { changed: await store.advance() }); }
    const preliminary = path.match(/^\/v1\/internal\/markets\/([^/]+)\/preliminary$/);
    if (req.method === 'POST' && preliminary) {
      requireResolver(req); const id = decodeURIComponent(preliminary[1]); const payload = await parseBody(req); const market = await store.getMarket(id);
      return json(res, 200, await store.publishPreliminary(id, await verifyGenLayerResolution(market, payload)));
    }
    const final = path.match(/^\/v1\/internal\/markets\/([^/]+)\/final$/);
    if (req.method === 'POST' && final) {
      requireResolver(req); const id = decodeURIComponent(final[1]); const payload = await parseBody(req); let market = await store.getMarket(id);
      if (market.status === 'challenge_window') return json(res, 200, await store.finalize(id, { outcome: market.preliminaryOutcome }));
      const verified = await verifyGenLayerResolution(market, payload, { dispute: true, allowUnbound: !market.disputeResolverContractAddress });
      if (!market.disputeResolverContractAddress) market = await store.bindDisputeResolver(id, payload.contractAddress);
      return json(res, 200, await store.finalize(id, verified));
    }
    throw new ApiError('NOT_FOUND', 'Endpoint not found', 404);
  }

  return async function handler(req, res) {
    try { await route(req, res); }
    catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      if (status === 500) console.error(error);
      json(res, status, { error: { code: error.code || 'INTERNAL_ERROR', message: error.message || 'Internal server error' } });
    }
  };
}
