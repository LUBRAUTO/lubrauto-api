import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, PostgresBudget } from './server.mjs';
import { normalizePlate } from './worker.mjs';

const origin = 'https://eft10i-vd.myshopify.com';
async function withServer(env, upstream, run) {
  const server = createServer(env, upstream);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const env = () => ({ ENABLED: 'true', AWN_TOKEN: 'test-only-secret', ALLOWED_ORIGINS: origin,
  BUDGET: { idFromName: () => 'global', get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) } });
const request = (url, body, extra = {}) => fetch(`${url}/vehicle`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });

test('normalise SIV/FNI et rejette une injection', () => {
  assert.equal(normalizePlate('AB-123-CD'), 'AB123CD');
  assert.equal(normalizePlate('1234 AB 75'), '1234AB75');
  assert.equal(normalizePlate('AB123CD&token=abc'), null);
});
test('minimise les résultats et ne révèle pas les secrets ni le VIN', async () => {
  await withServer(env(), async () => Response.json({ code: 200, data: { AWN_marque: 'Marque', AWN_modele: 'Modèle', AWN_VIN: 'SECRET-VIN', owner: 'SECRET-OWNER' } }), async url => {
    const response = await request(url, { plate: 'AB123CD' });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(text).compatibilityVerified, false);
    assert.doesNotMatch(text, /SECRET|test-only-secret/);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  });
});
test('origine refusée, service désactivé et quota épuisé empêchent tout appel', async () => {
  let calls = 0;
  const upstream = async () => { calls++; throw new Error('unexpected'); };
  await withServer(env(), upstream, async url => assert.equal((await request(url, { plate: 'AB123CD' }, { Origin: 'https://other.example' })).status, 403));
  await withServer({ ...env(), ENABLED: 'false' }, upstream, async url => assert.equal((await request(url, { plate: 'AB123CD' })).status, 503));
  const limited = env(); limited.BUDGET.get = () => ({ fetch: async () => new Response(null, { status: 429 }) });
  await withServer(limited, upstream, async url => assert.equal((await request(url, { plate: 'AB123CD' })).status, 429));
  assert.equal(calls, 0);
});
test('base indisponible et erreur fournisseur ne révèlent aucun détail', async () => {
  const unavailable = env(); unavailable.BUDGET.get = () => ({ fetch: async () => { throw new Error('SECRET-DB'); } });
  await withServer(unavailable, async () => { throw new Error('unexpected'); }, async url => assert.doesNotMatch(await (await request(url, { plate: 'AB123CD' })).text(), /SECRET/));
  await withServer(env(), async () => { throw new Error('SECRET-URL-TOKEN'); }, async url => {
    const response = await request(url, { plate: 'AB123CD' });
    assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /SECRET/);
  });
});
test('prévol CORS et corps trop volumineux', async () => {
  await withServer(env(), async () => { throw new Error('unexpected'); }, async url => {
    const response = await fetch(`${url}/vehicle`, { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(response.status, 204);
    assert.equal((await request(url, { plate: 'A'.repeat(2000) })).status, 413);
  });
});
test('quota PostgreSQL annule la transaction entière à la limite', async () => {
  const commands = [];
  let released = false;
  const connection = { query: async (sql) => {
    commands.push(sql);
    if (sql.startsWith('SELECT (EXTRACT')) return { rows: [{ now: Date.now() }] };
    if (sql.startsWith('INSERT')) return { rowCount: 0 };
    return { rows: [] };
  }, release: () => { released = true; } };
  const budget = new PostgresBudget({ connect: async () => connection }, {});
  assert.equal((await budget.fetch()).status, 429);
  assert.ok(commands.some(sql => sql.includes('pg_advisory_xact_lock')));
  assert.equal(commands.at(-1), 'ROLLBACK'); assert.ok(!commands.includes('COMMIT')); assert.ok(released);
});
