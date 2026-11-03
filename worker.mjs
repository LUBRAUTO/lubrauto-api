const API = 'https://app.auto-ways.net/api/v1/fr';
const encoder = new TextEncoder();

export function normalizePlate(value) {
  if (typeof value !== 'string' || value.length > 24 || /[^a-zA-Z0-9\s-]/.test(value)) return null;
  const plate = value.toUpperCase().replace(/[\s-]/g, '');
  return /^(?:[A-Z]{2}\d{3}[A-Z]{2}|\d{1,4}[A-Z]{1,3}(?:\d{2,3}|2A|2B))$/.test(plate) ? plate : null;
}

function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 180) : '';
}

export function vehicleFields(data) {
  return {
    label: text(data.AWN_label),
    brand: text(data.AWN_marque),
    model: text(data.AWN_modele),
    version: text(data.AWN_version),
    fuel: text(data.AWN_energie_description || data.AWN_energie),
    engineCode: text(data.AWN_code_moteur),
    displacement: text(data.AWN_cylindre_capacite),
    firstRegistration: text(data.AWN_date_mise_en_circulation),
    kType: text(data.AWN_k_type),
  };
}

function limit(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : fallback;
}

export class BudgetGuard {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)');
  }
  async fetch(request) {
    const { client } = await request.json();
    if (typeof client !== 'string' || !/^[a-f0-9]{64}$/.test(client)) return new Response(null, { status: 400 });
    const now = Date.now();
    const date = new Date(now);
    const day = date.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const nextDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const minute = Math.floor(now / 60000);
    const buckets = [
      [`ip:${minute}:${client}`, limit(this.env.MAX_PER_MINUTE, 3), (minute + 1) * 60000],
      [`day:${day}`, limit(this.env.MAX_PER_DAY, 10), nextDay],
      [`month:${month}`, limit(this.env.MAX_PER_MONTH, 50), nextMonth],
    ];
    try {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM counters WHERE expires <= ?', now);
        for (const [key, cap, expires] of buckets) {
          const rows = [...this.sql.exec('INSERT INTO counters(key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count', key, expires, cap)];
          if (!rows.length) throw new Error('LIMIT');
        }
      });
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(nextDay);
      return new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 429 });
    }
  }
  async alarm() {
    this.sql.exec('DELETE FROM counters WHERE expires <= ?', Date.now());
    if ([...this.sql.exec('SELECT key FROM counters LIMIT 1')].length) await this.ctx.storage.setAlarm(Date.now() + 86400000);
  }
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('BODY');
  let bytes = 0;
  let result = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1024) { await reader.cancel(); throw new Error('BODY'); }
    result += decoder.decode(value, { stream: true });
  }
  return JSON.parse(result + decoder.decode());
}

export async function handleRequest(request, env, upstream = fetch) {
  const url = new URL(request.url);
  const baseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8' };
  if (url.pathname === '/health' && request.method === 'GET') return Response.json({ service: 'LUBRAUTO véhicule', configured: Boolean(env.AWN_TOKEN && env.BUDGET), enabled: env.ENABLED === 'true' }, { headers: baseHeaders });
  const origin = request.headers.get('Origin');
  const origins = (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!origin || !origins.includes(origin)) return Response.json({ error: 'origin_denied' }, { status: 403, headers: baseHeaders });
  const headers = { ...baseHeaders, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  const reply = (error, status) => Response.json({ error }, { status, headers });
  if (url.pathname !== '/vehicle') return reply('not_found', 404);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } });
  if (request.method !== 'POST') return reply('method_not_allowed', 405);
  if (env.ENABLED !== 'true' || !env.AWN_TOKEN || !env.BUDGET) return reply('service_unavailable', 503);
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return reply('invalid_request', 415);
  let plate;
  try { plate = normalizePlate((await readBody(request)).plate); } catch { return reply('invalid_request', 400); }
  if (!plate) return reply('invalid_plate', 400);
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return reply('service_unavailable', 503);
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.AWN_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(ip));
    const client = [...new Uint8Array(signature)].map(x => x.toString(16).padStart(2, '0')).join('');
    const guard = env.BUDGET.get(env.BUDGET.idFromName('lubrauto-awn-budget-v1'));
    let reservation;
    try { reservation = await guard.fetch(new Request('https://budget.internal/reserve', { method: 'POST', body: JSON.stringify({ client }) })); }
    catch { console.error('quota_storage_failure'); return reply('service_unavailable', 503); }
    if (!reservation.ok) return reply('limit_reached', 429);
    const apiUrl = new URL(API);
    apiUrl.search = new URLSearchParams({ token: env.AWN_TOKEN, plaque: plate }).toString();
    const response = await upstream(apiUrl, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) console.error('provider_http_status', response.status);
    if (!response.ok) return reply(response.status === 404 ? 'vehicle_not_found' : 'provider_unavailable', response.status === 404 ? 404 : 502);
    const payload = await response.json();
    if (Number(payload.code) !== 200 || payload.error) console.error('provider_envelope_code', Number.isFinite(Number(payload.code)) ? Number(payload.code) : -1);
    if (payload.error === true || payload.error === 'true' || Number(payload.code) !== 200 || !payload.data || typeof payload.data !== 'object') return reply(Number(payload.code) === 404 ? 'vehicle_not_found' : 'provider_unavailable', Number(payload.code) === 404 ? 404 : 502);
    const vehicle = vehicleFields(payload.data);
    if (!vehicle.label && !vehicle.brand && !vehicle.model) return reply('vehicle_not_found', 404);
    return Response.json({ vehicle, compatibilityVerified: false }, { headers });
  } catch { console.error('provider_request_failure'); return reply('provider_unavailable', 502); }
}

export default { fetch: (request, env) => handleRequest(request, env) };
