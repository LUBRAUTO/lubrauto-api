import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { handleRequest } from './worker.mjs';

const cap = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Math.min(Number(value), 1000) : fallback;

// All instances share the same PostgreSQL lock and quota counters.
// No registration plate, vehicle, IP address or provider response is stored.
export class PostgresBudget {
  constructor(pool, env) { this.pool = pool; this.env = env; }
  idFromName() { return 'global'; }
  get() { return this; }
  async initialize() {
    await this.pool.query('CREATE TABLE IF NOT EXISTS lubrauto_quotas (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires BIGINT NOT NULL)');
  }
  async fetch() {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SET LOCAL statement_timeout = 4000');
      await connection.query('SELECT pg_advisory_xact_lock(718324901)');
      const { rows: [clock] } = await connection.query('SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now');
      const now = Number(clock.now);
      const date = new Date(now);
      const day = date.toISOString().slice(0, 10);
      const minute = Math.floor(now / 60000);
      const buckets = [
        [`minute:${minute}`, cap(this.env.MAX_PER_MINUTE, 3), (minute + 1) * 60000],
        [`day:${day}`, cap(this.env.MAX_PER_DAY, 10), Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)],
        [`month:${day.slice(0, 7)}`, cap(this.env.MAX_PER_MONTH, 20), Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)],
      ];
      await connection.query('DELETE FROM lubrauto_quotas WHERE expires <= $1', [now]);
      for (const [bucket, maximum, expires] of buckets) {
        const result = await connection.query('INSERT INTO lubrauto_quotas(bucket,count,expires) VALUES ($1,1,$2) ON CONFLICT(bucket) DO UPDATE SET count=lubrauto_quotas.count+1 WHERE lubrauto_quotas.count < $3 RETURNING count', [bucket, expires, maximum]);
        if (!result.rowCount) {
          await connection.query('ROLLBACK');
          return new Response(null, { status: 429 });
        }
      }
      await connection.query('COMMIT');
      return new Response(null, { status: 204 });
    } catch {
      await connection.query('ROLLBACK').catch(() => {});
      throw new Error('QUOTA_UNAVAILABLE');
    } finally { connection.release(); }
  }
}

export function createServer(env, upstream = fetch) {
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      let length = 0;
      const chunks = [];
      for await (const chunk of incoming) {
        length += chunk.length;
        if (length > 1024) {
          outgoing.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          outgoing.end('{"error":"invalid_request"}');
          return;
        }
        chunks.push(chunk);
      }
      const headers = new Headers();
      // Client proxy/IP headers are deliberately not trusted. The initial
      // minute quota is global and works across instances and forged headers.
      for (const key of ['origin', 'content-type']) if (incoming.headers[key]) headers.set(key, incoming.headers[key]);
      headers.set('CF-Connecting-IP', 'render-global');
      const method = incoming.method || 'GET';
      const request = new Request(new URL(incoming.url || '/', 'https://lubrauto.internal'), {
        method, headers, ...(method !== 'GET' && method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}),
      });
      const result = await handleRequest(request, env, upstream);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end('{"error":"service_unavailable"}');
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

async function main() {
  const env = { ...process.env };
  let pool;
  if (env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, connectionTimeoutMillis: 4000, idleTimeoutMillis: 10000 });
    pool.on('error', () => console.error('quota_database_unavailable'));
    const budget = new PostgresBudget(pool, env);
    await budget.initialize();
    env.BUDGET = budget;
  }
  const server = createServer(env);
  server.listen(Number(env.PORT) || 10000, '0.0.0.0', () => console.log('lubrauto_api_listening'));
  process.on('SIGTERM', () => {
    server.close(async () => { await pool?.end(); process.exit(0); });
    setTimeout(() => process.exit(0), 15000).unref();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('startup_configuration_error'); process.exitCode = 1; });
}
