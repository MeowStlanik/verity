const base = process.env.API_BASE || 'http://localhost:8000';
const key = process.env.RESOLVER_API_KEY || 'development-resolver-key';

async function tick() {
  const response = await fetch(`${base}/v1/internal/lifecycle/tick`, { method: 'POST', headers: { 'X-Resolver-Key': key } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Lifecycle API returned ${response.status}`);
  if (data.changed) console.log(`[${new Date().toISOString()}] lifecycle advanced`);
}

await tick();
if (process.argv.includes('--once')) process.exit(0);
setInterval(() => tick().catch((error) => console.error('worker error', error)), 15_000);
console.log('Verity lifecycle worker started (API is the only state writer)');
