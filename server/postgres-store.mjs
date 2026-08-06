import { randomBytes } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { ApiError, MarketStore, ensureRuntime } from './domain.mjs';

const clone = (value) => structuredClone(value);

/**
 * Durable serverless store for Vercel.
 *
 * The domain intentionally remains one aggregate: a trade can update the pool,
 * market, position and history together. A compare-and-swap version column makes
 * those updates atomic even when several Vercel Functions run concurrently.
 */
export class PostgresMarketStore extends MarketStore {
  constructor({ databaseUrl, sql, seed, clock = Date, challengeWindowSeconds = 1800 }) {
    super({ file: '/tmp/verity-unused.json', seed, clock, challengeWindowSeconds });
    if (!sql && !databaseUrl) throw new Error('DATABASE_URL is required for the Vercel API');
    this.sql = sql || neon(databaseUrl);
    this.version = 0;
  }

  async init() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS verity_market_state (
        id text PRIMARY KEY,
        version bigint NOT NULL DEFAULT 0,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`
      INSERT INTO verity_market_state (id, version, data)
      VALUES ('primary', 0, ${JSON.stringify(this.seed)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `;
    await this._loadFromDatabase();
    return this;
  }

  async _loadFromDatabase() {
    const rows = await this.sql`SELECT version, data FROM verity_market_state WHERE id = 'primary'`;
    if (!rows.length) throw new Error('Verity database state was not initialized');
    this.version = Number(rows[0].version);
    this.state = ensureRuntime(clone(rows[0].data));
  }

  // Persistence happens once, atomically, at the end of _transaction.
  async persist() { this._dirty = true; }
  async _reloadIfChanged() {}

  async _transaction(body) {
    const run = async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await this._loadFromDatabase();
        const expectedVersion = this.version;
        const before = JSON.stringify(this.state);
        this._dirty = false;
        const result = await body();
        const serialized = JSON.stringify(this.state);
        if (!this._dirty && serialized === before) return result;

        const updated = await this.sql`
          UPDATE verity_market_state
          SET data = ${serialized}::jsonb, version = version + 1, updated_at = now()
          WHERE id = 'primary' AND version = ${expectedVersion}
          RETURNING version
        `;
        if (updated.length) {
          this.version = Number(updated[0].version);
          return result;
        }
      }
      throw new ApiError('STORE_BUSY', 'The market changed concurrently; please retry', 503);
    };
    const chained = this._queue.then(run, run);
    this._queue = chained.then(() => undefined, () => undefined);
    return chained;
  }
}

export class PostgresNonceStore {
  constructor(sql) { this.sql = sql; }

  async init() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS verity_auth_nonces (
        address text PRIMARY KEY,
        nonce text NOT NULL,
        expires_at timestamptz NOT NULL
      )
    `;
    return this;
  }

  async create(address) {
    const expiresAt = new Date(Date.now() + 300_000);
    const nonce = `Verity Markets login\nAddress: ${address}\nNonce: ${randomBytes(24).toString('hex')}\nExpires: ${expiresAt.toISOString()}`;
    await this.sql`
      INSERT INTO verity_auth_nonces (address, nonce, expires_at)
      VALUES (${address}, ${nonce}, ${expiresAt.toISOString()})
      ON CONFLICT (address) DO UPDATE SET nonce = EXCLUDED.nonce, expires_at = EXCLUDED.expires_at
    `;
    await this.sql`DELETE FROM verity_auth_nonces WHERE expires_at < now()`;
    return nonce;
  }

  async get(address) {
    const rows = await this.sql`
      SELECT nonce FROM verity_auth_nonces
      WHERE address = ${address} AND expires_at >= now()
    `;
    return rows[0]?.nonce || null;
  }

  async consume(address, nonce) {
    const rows = await this.sql`
      DELETE FROM verity_auth_nonces
      WHERE address = ${address} AND nonce = ${nonce} AND expires_at >= now()
      RETURNING address
    `;
    return rows.length === 1;
  }
}
