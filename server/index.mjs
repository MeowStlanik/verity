import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MarketStore } from './domain.mjs';
import { createApi } from './http-app.mjs';
import { seedState } from './seed.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8000);
const challengeWindowSeconds = Number(process.env.CHALLENGE_WINDOW_SECONDS || 1800);
const store = await new MarketStore({
  file: process.env.DB_FILE || join(root, 'data', 'verity-db.json'),
  seed: seedState,
  challengeWindowSeconds: Number.isFinite(challengeWindowSeconds) && challengeWindowSeconds >= 60 ? challengeWindowSeconds : 1800,
}).init();
const handler = await createApi({ store, corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173' });
const server = http.createServer(handler);
server.listen(port, () => console.log(`Verity Markets API listening on http://localhost:${port}`));
