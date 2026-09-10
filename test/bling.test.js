import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createBling, sanitizeOrder, blingRows } from '../bling.js';
import { buildDashboard } from '../mc.js';
import { openDatabase } from '../db.js';
import { createApp } from '../app.js';

const time=Date.parse('2026-09-10T15:00:00Z');
const config={BLING_CLIENT_ID:'app',BLING_CLIENT_SECRET:'secret',BLING_REDIRECT_URI:'https://example.com/integracoes/bling/callback'};
const order={id:1,data:'2026-09-10',numeroLoja:'A123',loja:{id:11},situacao:{id:5},total:100,totalProdutos:100,desconto:{valor:0,unidade:'REAL'},taxas:{custoFrete:10,taxaComissao:12},transporte:{frete:5,etiqueta:{endereco:'PRIVATE-ADDRESS'}},contato:{nome:'PRIVATE-BUYER'},itens:[{codigo:'SKU1',descricao:'Produto',quantidade:1,valor:100}]};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});

test('Bling: sanitização, status explícito, canais e exclusão de ML duplicado',()=>{
  const clean=sanitizeOrder(order);assert.doesNotMatch(JSON.stringify(clean),/PRIVATE|contato|etiqueta/);
  const cache={shops:[{id:'11',name:'Shopee 1',type:'Shopee'},{id:'12',name:'ML',type:'MercadoLivre'}],orders:[clean,{...clean,id:'2',shopId:'12'}]};
  const settings={statuses:{5:'paid'},commissions:{shopee:12}};
  const rows=blingRows('123',cache,settings);assert.equal(rows.length,1);assert.equal(rows[0].channel,'shopee');
  assert.equal(rows[0].status,'paid');assert.equal(rows[0].tarifas,12);assert.equal(rows[0].mc_meta.reembolso,null);
  assert.equal(blingRows('123',cache,{})[0].status,'pending');
  const dashboard=buildDashboard({rows,costs:[],query:{},now:time,sync:time});
  assert.equal(dashboard.totals.revenue,10000);assert.equal(dashboard.today.count,0);assert.equal(dashboard.byChannel[0].channel,'shopee');assert.equal(dashboard.totals.mc,null);
});

test('Bling: renovação JWT compartilhada e tokens substituídos atomicamente',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());db.saveBlingToken('123',{access_token:'old',refresh_token:'old-refresh',expires_at:time});
  let calls=0;
  const client=createBling({db,config,now:()=>time,sleep:async()=>{},fetchImpl:async(url,options)=>{
    assert.equal(options.headers['enable-jwt'],'1');
    if(url.endsWith('/oauth/token')) {calls++;assert.match(options.headers.Authorization,/^Basic /);assert.equal(options.body.get('refresh_token'),'old-refresh');return response({access_token:'new',refresh_token:'new-refresh',expires_in:21600});}
    assert.equal(options.headers.Authorization,'Bearer new');return response({data:[]});
  }});
  await Promise.all([client.api('123','/canais-venda'),client.api('123','/canais-venda')]);
  assert.equal(calls,1);assert.equal(db.getBlingToken('123').refresh_token,'new-refresh');
});

test('Bling: cache preservado após falha, idempotência e isolamento de usuário',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());db.saveBlingToken('123',{access_token:'access',refresh_token:'refresh',expires_at:time+6000000});
  let fail=false;
  const client=createBling({db,config,now:()=>time,sleep:async()=>{},fetchImpl:async url=>{
    const path=new URL(url).pathname.replace('/Api/v3','');
    if(path==='/canais-venda') return response({data:[{id:11,descricao:'Shopee',tipo:'Shopee'}]});
    if(path==='/situacoes/modulos') return response({data:[{id:8,nome:'Vendas'}]});
    if(path==='/situacoes/modulos/8') return response({data:[{id:5,nome:'Pago'}]});
    if(path==='/pedidos/vendas') return response({data:[{id:1}]});
    return fail?response({},503):response({data:order});
  }});
  await client.sync('123');await client.sync('123');
  assert.equal(db.getBlingCache('123').orders.length,1);assert.equal(db.getBlingCache('456'),null);
  fail=true;await assert.rejects(client.sync('123'),/503/);assert.equal(db.getBlingCache('123').orders.length,1);
  assert.doesNotMatch(JSON.stringify(db.getBlingCache('123')),/PRIVATE/);
});

test('Bling: OAuth vinculado à sessão, CSRF e state de uso único',async t=>{
  const db=openDatabase(':memory:');const raw='b'.repeat(43);const id=createHash('sha256').update(raw).digest('base64url');db.saveSession(id,{user_id:'123',expires_at:Date.now()+600000});
  let tokenCalls=0;
  const app=createApp({db,config,now:()=>time,fetchImpl:async url=>{assert.ok(url.endsWith('/oauth/token'));tokenCalls++;return response({access_token:'bling-token-secret',refresh_token:'bling-refresh-secret',expires_in:21600});}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
  const base=`http://127.0.0.1:${server.address().port}`,headers={Cookie:`meli_session=${raw}`};
  const page=await fetch(base+'/integracoes/bling',{headers});const html=await page.text();assert.equal(page.status,200);assert.match(html,/BLING_CLIENT_ID/);
  const csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const connect=await fetch(base+'/integracoes/bling/conectar',{method:'POST',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf}),redirect:'manual'});
  assert.equal(connect.status,303);const state=new URL(connect.headers.get('location')).searchParams.get('state');
  const callback=`/integracoes/bling/callback?state=${state}&code=test`;
  assert.equal((await fetch(base+'/integracoes/bling/callback?state=bad&code=test',{headers})).status,400);
  assert.equal((await fetch(base+callback,{headers,redirect:'manual'})).status,303);
  assert.equal((await fetch(base+callback,{headers})).status,400);assert.equal(tokenCalls,1);
  assert.doesNotMatch(await (await fetch(base+'/integracoes/bling',{headers})).text(),/bling-token-secret|bling-refresh-secret/);
  db.replaceMargens('123',[]);
  db.saveBlingCache('123',{shops:[{id:'11',name:'Shopee principal',type:'Shopee'}],statuses:[{id:'5',name:'Pago'}],orders:[sanitizeOrder(order)]});
  const mapped=await fetch(base+'/integracoes/bling/configurar',{method:'POST',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,channel_11:'shopee',status_5:'paid',fee_shopee:'12'}),redirect:'manual'});
  assert.equal(mapped.status,303);
  for(const tab of ['live','analysis','prices','ranking']) {
    const result=await fetch(`${base}/mc?aba=${tab}`,{headers});const content=await result.text();
    assert.equal(result.status,200,content);assert.match(content,/Shopee principal/);assert.doesNotMatch(content,/vendas\/bling|PRIVATE/);
  }
});
