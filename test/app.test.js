import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase } from '../db.js';
import { createMercadoLivre } from '../mercado-livre.js';
import { createApp } from '../app.js';

const config = { ML_APP_ID: 'app-teste', ML_CLIENT_SECRET: 'segredo-teste', ML_REDIRECT_URI: 'http://localhost/callback' };
const time = Date.parse('2026-09-10T15:35:00Z');
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const token = { user_id: '123', access_token: 'acesso', refresh_token: 'renovacao', expires_at: time + 21600000 };
const order = (id, overrides = {}) => ({ id, date_created: '2026-09-09T10:00:00Z', status: 'paid', currency_id: 'BRL', total_amount: 20.2,
  order_items: [{ item: { id: 'MLB1', title: '<script>produto</script>' }, quantity: 2, unit_price: 10.1 }], ...overrides });

test('paginação, datas exatas, duplicatas, BRL e ranking com centavos', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close()); db.saveToken(token);
  const pages = [
    [order(1), order(2, { status: 'cancelled' }), order(3, { currency_id: 'USD' }), order(4, { date_created: '2026-08-11T15:00:00Z' })],
    [order(1), order(5, { total_amount: 30.3, order_items: [{ item: { id: 'MLB2', title: 'Segundo' }, quantity: 3, unit_price: 10.1 }] })],
  ];
  const offsets = [];
  const ml = createMercadoLivre({ db, config, now: () => time, fetchImpl: async (url, options) => {
    const query = new URL(url).searchParams;
    offsets.push(query.get('offset'));
    assert.equal(query.get('seller'), '123'); assert.equal(query.get('order.status'), 'paid');
    assert.equal(options.headers.Authorization, 'Bearer acesso');
    return reply({ results: pages.shift(), paging: { total: 6 } });
  } });
  const data = await ml.sales('123');
  assert.equal(data.total_vendas, 50.5); assert.equal(data.quantidade_pedidos, 2);
  assert.deepEqual(offsets, ['0', '4']); assert.equal(data.anuncios_mais_vendidos[0].id, 'MLB2');
  assert.equal(data.anuncios_mais_vendidos[1].total_vendas, 20.2);
  assert.equal(data.periodo.de, '2026-08-11T15:35:00.000Z');
});

test('renovação simultânea usa refresh uma vez e substitui ambos os tokens', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close()); db.saveToken({ ...token, expires_at: time + 60000 });
  let calls = 0;
  const ml = createMercadoLivre({ db, config, now: () => time, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.mercadolibre.com/oauth/token');
    assert.equal(options.body.get('refresh_token'), 'renovacao');
    await new Promise(resolve => setTimeout(resolve, 15));
    return reply({ user_id: 123, access_token: 'novo-acesso', refresh_token: 'nova-renovacao', expires_in: 21600 });
  } });
  assert.deepEqual(await Promise.all([ml.accessToken('123'), ml.accessToken('123'), ml.accessToken('123')]), ['novo-acesso', 'novo-acesso', 'novo-acesso']);
  assert.equal(calls, 1); assert.equal(db.getSeller('123').refresh_token, 'nova-renovacao');
  assert.equal(db.getSeller('123').expires_at, time + 21600000);
  await ml.accessToken('123'); assert.equal(calls, 1);
});

test('401 renova e repete a consulta uma única vez', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close()); db.saveToken(token);
  let count = 0;
  const ml = createMercadoLivre({ db, config, now: () => time, fetchImpl: async url => {
    count++;
    if (url.endsWith('/oauth/token')) return reply({ user_id: 123, access_token: 'novo', refresh_token: 'novo-refresh', expires_in: 21600 });
    return count === 1 ? reply({}, 401) : reply({ ok: true });
  } });
  assert.deepEqual(await ml.api('123', '/orders/search'), { ok: true }); assert.equal(count, 3);
});

test('refresh revogado e paginação incompleta não produzem dados parciais', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close()); db.saveToken({ ...token, expires_at: time });
  const expired = createMercadoLivre({ db, config, now: () => time, fetchImpl: async () => reply({ error: 'invalid_grant' }, 400) });
  await assert.rejects(expired.accessToken('123'), error => error.status === 401);
  assert.equal(db.getSeller('123').refresh_token, 'renovacao');
  db.saveToken(token);
  const broken = createMercadoLivre({ db, config, now: () => time, fetchImpl: async () => reply({ results: [], paging: { total: 8 } }) });
  await assert.rejects(broken.sales('123'), /todos os pedidos/);
});

test('top 10 agrupa variações e período sem pedidos retorna zero', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close()); db.saveToken(token);
  const results = Array.from({ length: 12 }, (_, i) => order(i, { total_amount: i + 1, order_items: [
    { item: { id: `MLB${i}`, title: `Produto ${i}`, variation_id: 'a' }, quantity: i + 1, unit_price: 1 },
    { item: { id: `MLB${i}`, title: `Produto ${i}`, variation_id: 'b' }, quantity: 1, unit_price: 1 },
  ] }));
  const ml = createMercadoLivre({ db, config, now: () => time, fetchImpl: async () => reply({ results, paging: { total: results.length } }) });
  const data = await ml.sales('123');
  assert.equal(data.anuncios_mais_vendidos.length, 10); assert.equal(data.anuncios_mais_vendidos[0].quantidade, 13);
  results.length = 0;
  const empty = await ml.sales('123'); assert.equal(empty.total_vendas, 0); assert.equal(empty.quantidade_pedidos, 0);
});

test('HTTP: OAuth, state, sessão, SQLite, HTML escapado e JSON sem tokens', async t => {
  const db = openDatabase(':memory:');
  let tokenCalls = 0;
  const app = createApp({ db, config, now: () => time, fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth/token')) {
      tokenCalls++; assert.equal(options.body.get('code'), 'codigo-teste'); assert.ok(options.body.get('code_verifier'));
      return reply({ user_id: 123, access_token: 'token-secreto', refresh_token: 'refresh-secreto', expires_in: 21600 });
    }
    return reply({ results: [order(1)], paging: { total: 1 } });
  } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/api/vendas')).status, 401);
  assert.equal((await get('/painel')).status, 302);
  assert.equal((await get('/callback?code=malicioso&state=invalido')).status, 400);
  assert.equal(tokenCalls, 0);
  const login = await get('/auth/mercadolivre');
  const auth = new URL(login.headers.get('location'));
  assert.equal(auth.origin, 'https://auth.mercadolivre.com.br');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const callbackPath = `/callback?code=codigo-teste&state=${auth.searchParams.get('state')}`;
  const callback = await get(callbackPath, cookie); assert.equal(callback.status, 302);
  assert.equal(db.getSeller('123').refresh_token, 'refresh-secreto');
  assert.equal((await get(callbackPath, cookie)).status, 400); assert.equal(tokenCalls, 1);
  const authenticated = callback.headers.getSetCookie().find(value => value.startsWith('meli_session=') && !value.startsWith('meli_session=;')).split(';')[0];
  const panel = await get('/painel', authenticated); assert.equal(panel.status, 200);
  const html = await panel.text(); assert.match(html, /&lt;script&gt;produto&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  const json = await get('/api/vendas', authenticated); assert.equal(json.status, 200);
  const body = await json.text(); assert.doesNotMatch(body, /token-secreto|refresh-secreto|access_token/);
  assert.equal(JSON.parse(body).total_vendas, 20.2);
  assert.equal((await get('/dados.db', authenticated)).status, 404);
});
