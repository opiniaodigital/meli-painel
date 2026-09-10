import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { buildDashboard, calculate, allocate, period, publicDashboard } from '../mc.js';
import { openDatabase } from '../db.js';
import { createApp } from '../app.js';
import { createMercadoLivre } from '../mercado-livre.js';

const time = Date.parse('2026-09-10T15:35:00Z');
const cost = { sku: 'SKU1', custo_unitario: 20, imposto_percentual: 10 };
const fixture = (overrides = {}) => ({ user_id: '123', order_id: '1', date_created: '2026-09-10T10:00:00.000Z', status: 'paid', bruto: 100, tarifas: 12, frete: 8, descontos: 0, frete_desconto: 0, buyer_nickname: 'PRIVATE-BUYER', envio_status: 'delivered', envio_tipo: 'fulfillment', items: [{ id: 'MLB123', sku: 'SKU1', title: 'Produto', quantity: 1, unit_price: 100, gross_price: 100, sale_fee: 12 }], mc_meta: { frete_confirmado: true, desconto_confirmado: true, tarifa_confirmada: true, frete_comprador: 5, reembolso: 0 }, ...overrides });
const dashboard = (rows, query = {}, costs = [cost]) => buildDashboard({ rows, costs, query, now: time, sync: time });

test('MC: pagamentos, custos ausentes e cancelamentos separados sem perder faturamento', () => {
  const noCost = fixture({ order_id: '2', items: [{...fixture().items[0],sku:'MISSING'}] });
  const data = dashboard([fixture(),noCost,fixture({order_id:'3',status:'confirmed'}),fixture({order_id:'4',status:'cancelled'})]);
  assert.equal(data.totals.count, 2); assert.equal(data.totals.revenue, 20000);
  assert.equal(data.totals.mc, 5000); assert.equal(data.totals.pct, 50);
  assert.equal(data.totals.incomplete, 1); assert.equal(data.cancelled, 1); assert.equal(data.pending, 1);
  assert.equal(noCost.items[0].sku, 'MISSING');
  assert.doesNotMatch(JSON.stringify(publicDashboard(data)), /PRIVATE-BUYER|items_json/);
});

test('MC: frete ausente, devolução e dados legados nunca viram custo zero', () => {
  for (const meta of [{}, {...fixture().mc_meta,frete_confirmado:false}, {...fixture().mc_meta,reembolso:20}]) {
    const data = dashboard([fixture({mc_meta:meta})]);
    assert.equal(data.totals.mc, null); assert.equal(data.rows[0].mc, null);
    assert.equal(data.ranking[0].mc, null);
  }
  assert.equal(dashboard([fixture({status:'partially_refunded'})]).totals.mc, null);
});

test('MC: centavos e rateio conservam totais no pedido e no ranking', () => {
  assert.deepEqual(allocate(1, [1,1,1]), [1,0,0]);
  const row = fixture({ bruto: 30.03, frete: .01, tarifas: .02, items: [0,1,2].map(i=>({id:`MLB${i}`,sku:'SKU1',title:'Item',quantity:1,unit_price:10.01,gross_price:10.01,sale_fee:0})) });
  const data = dashboard([row], {}, [{...cost,custo_unitario:.01,imposto_percentual:0}]);
  assert.equal(data.rows[0].mc, 2997);
  assert.equal(data.rows[0].lines.reduce((s,l)=>s+l.mc,0),2997);
  assert.equal(data.ranking.reduce((s,l)=>s+l.mc,0),2997);
  const mixed = fixture({items:[fixture().items[0],{...fixture().items[0],sku:'UNKNOWN'}]});
  assert.ok(calculate(mixed,new Map([[cost.sku,cost]])).lines.every(l=>l.mc===null));
});

test('MC: incluir frete comprador mantém MC e usa mesma base em cards, linhas e ranking', () => {
  const data = dashboard([fixture()],{frete_comprador:'1'});
  assert.equal(data.totals.revenue,10500); assert.equal(data.totals.mc,5000);
  assert.equal(data.rows[0].revenue,10500); assert.equal(data.ranking[0].revenue,10500);
  assert.equal(data.totals.pct,data.ranking[0].pct);
  assert.equal(data.ranking[0].productRevenue,10000);
});

test('MC: limites de data em Brasília e comparação de ontem até o mesmo horário', () => {
  assert.equal(period({},time).from,Date.parse('2026-09-10T03:00:00Z'));
  assert.throws(()=>period({periodo:'custom',di:'2026-02-30',df:'2026-03-01'},time),/válidas/);
  assert.throws(()=>period({periodo:'custom',di:'2026-09-11',df:'2026-09-12'},time),/futuras/);
  const data = dashboard([fixture(),fixture({order_id:'2',date_created:'2026-09-10T02:59:59Z'}),fixture({order_id:'3',date_created:'2026-09-09T10:00:00Z'})]);
  assert.equal(data.totals.count,1); assert.equal(data.yesterday.count,1);
  assert.equal(dashboard([fixture()],{periodo:'previous'}).totals.count,0);
});

test('MC: filtros, paginação e vazio', () => {
  const rows = Array.from({length:801},(_,i)=>fixture({order_id:String(i)}));
  const data = dashboard(rows,{pagina:'2'}); assert.equal(data.rows.length,1); assert.equal(data.pages,2);
  assert.equal(dashboard(rows,{faixa:'low'}).rowCount,0);
  assert.equal(dashboard(rows,{q:'SKU1'}).rowCount,801);
  assert.equal(dashboard(rows,{conta:'999'}).totals.count,0);
  assert.equal(dashboard([]).totals.mc,0);
});

test('MC: HTTP renderiza quatro abas, exige sessão/CSRF e recalcula custo', async t => {
  const db = openDatabase(':memory:'); db.replaceMargens('123',[fixture({items:[{...fixture().items[0],title:'<script>alert(1)</script>'}]})]); db.upsertCusto('SKU1',20,10);
  const raw = 'a'.repeat(43); const id = createHash('sha256').update(raw).digest('base64url');
  db.saveSession(id,{user_id:'123',expires_at:Date.now()+600000});
  const app = createApp({db,config:{},now:()=>time,fetchImpl:async()=>{throw new Error('Unexpected network');}});
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {Cookie:`meli_session=${raw}`};
  assert.equal((await fetch(base+'/api/mc/realtime')).status,401);
  let html;
  for (const tab of ['live','analysis','prices','ranking']) {
    const response = await fetch(`${base}/mc?aba=${tab}`,{headers});
    html = await response.text(); assert.equal(response.status,200,html);
    assert.match(html,/MC Vendas/); assert.doesNotMatch(html,/<script>alert|PRIVATE-BUYER/);
  }
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const post = values => fetch(base+'/mc/custo',{method:'POST',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values),redirect:'manual'});
  assert.equal((await post({sku:'SKU1',custo:'30',imposto:'10'})).status,403);
  assert.equal((await post({csrf,sku:'OTHER',custo:'30',imposto:'10'})).status,400);
  assert.equal((await post({csrf,sku:'SKU1',custo:'30,00',imposto:'101'})).status,400);
  assert.equal((await post({csrf,sku:'SKU1',custo:'30,00',imposto:'10'})).status,303);
  const result=await (await fetch(base+'/api/mc/realtime',{headers})).json();
  assert.equal(result.cards.mc,40); assert.equal(result.conciliado,false);
  assert.equal((await fetch(base+'/api/mc/realtime?di=2026-02-30&df=2026-03-01',{headers})).status,400);
});

test('MC: coleta idempotente mantém ausência de frete explícita e rejeita paginação incompleta', async t => {
  const db = openDatabase(':memory:'); t.after(()=>db.close()); db.saveToken({user_id:'123',access_token:'access',refresh_token:'refresh',expires_at:time+6000000});
  const detail = {id:1,date_created:'2026-09-10T10:00:00Z',status:'paid',currency_id:'BRL',shipping:{id:77},order_items:[{item:{id:'MLB123',seller_sku:'SKU1'},quantity:1,unit_price:100,gross_price:100,sale_fee:12}],payments:[{transaction_amount_refunded:0}]};
  let fail=false;
  const ml=createMercadoLivre({db,config:{},now:()=>time,fetchImpl:async url=>{
    const path=new URL(url).pathname;
    const body=path==='/orders/search' ? {results:fail?[]:[detail],paging:{total:1}} : path==='/orders/1' ? detail : path==='/orders/1/shipments' ? [{id:77}] : path.endsWith('/discounts') ? {details:[]} : {};
    return new Response(JSON.stringify(body),{status:path.startsWith('/shipments/')?503:200});
  }});
  await ml.syncMargens('123'); await ml.syncMargens('123');
  assert.equal(db.listMargens('123').length,1);
  assert.equal(db.listMargens('123')[0].mc_meta.frete_confirmado,false);
  assert.equal(db.listMargens('123')[0].items[0].id,'MLB123');
  fail=true; await assert.rejects(ml.syncMargens('123'),/todos os pedidos/);
  assert.equal(db.listMargens('123').length,1);
});
