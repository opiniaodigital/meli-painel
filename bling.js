import { AppError } from './mercado-livre.js';
import { allocate, cents } from './mc.js';

export const CHANNELS = {mercado_livre:'Mercado Livre',shopee:'Shopee',tiktok:'TikTok Shop',amazon:'Amazon',shein:'Shein',temu:'Temu',kwai:'Kwai Shop',other:'Outros'};
export function suggestedChannel(type) {
  const value = String(type).toLowerCase().replace(/[^a-z]/g,'');
  if (value.includes('mercado') || value === 'meli') return 'mercado_livre';
  return Object.keys(CHANNELS).find(key => key !== 'other' && value.includes(key)) || 'other';
}

// Keep only fields necessary for MC. Never persist the contact/address payload.
export function sanitizeOrder(order) {
  if (!order?.id || !Array.isArray(order.itens) || !/^\d{4}-\d{2}-\d{2}$/.test(order.data)) throw new AppError('O Bling retornou um pedido incompleto.');
  if (order.itens.some(i => !Number.isFinite(i.quantidade) || i.quantidade <= 0 || !Number.isFinite(i.valor) || i.valor < 0)) throw new AppError('O Bling retornou valores de itens inválidos.');
  return { id:String(order.id), day:order.data, externalId:String(order.numeroLoja || ''), shopId:String(order.loja?.id || ''), statusId:String(order.situacao?.id || ''), total:cents(order.total), products:cents(order.totalProdutos), discount:{value:cents(order.desconto?.valor),unit:order.desconto?.unidade || 'REAL'}, freight:cents(order.taxas?.custoFrete), buyerFreight:cents(order.transporte?.frete), commissionRate:Number.isFinite(order.taxas?.taxaComissao) ? order.taxas.taxaComissao : null, items:order.itens.map(i=>({sku:i.codigo || null,title:i.descricao || 'Produto',qty:i.quantidade,unit:cents(i.valor),productId:i.produto?.id ? String(i.produto.id) : null})) };
}

export function blingRows(userId, cache, settings) {
  if (!cache) return [];
  const shops = new Map(cache.shops.map(s=>[String(s.id),s]));
  return cache.orders.flatMap(order => {
    const shop = shops.get(order.shopId);
    const channel = settings.channels?.[order.shopId] || suggestedChannel(shop?.type);
    // Mercado Livre is read through its own API. Importing it again duplicates sales.
    if (channel === 'mercado_livre') return [];
    const status = settings.statuses?.[order.statusId] || 'pending';
    const weights = order.items.map(i=>Math.round(i.unit*i.qty));
    const total = weights.reduce((s,v)=>s+v,0);
    const discount = order.discount.value === null ? null : order.discount.unit === 'PERCENTUAL' ? Math.round(total*order.discount.value/10000) : order.discount.unit === 'REAL' ? order.discount.value : null;
    const configuredFee = settings.commissions?.[channel];
    const fee = Number.isFinite(configuredFee) && discount !== null ? Math.round((total-discount)*configuredFee/100) : null;
    const fees = allocate(fee,weights);
    return [{user_id:String(userId),order_id:`bling:${order.id}`,date_created:`${order.day}T03:00:00.000Z`,status,channel,account:`bling:${order.shopId}`,account_name:shop?.name || order.shopId,source:'bling',date_precision:'day',external_id:order.externalId,bruto:total/100,tarifas:(fee ?? 0)/100,frete:(order.freight ?? 0)/100,descontos:(discount ?? 0)/100,envio_tipo:'ERP',items:order.items.map((i,index)=>({id:null,sku:i.sku,title:i.title,quantity:i.qty,unit_price:i.unit/100,gross_price:weights[index]/100,sale_fee:fees[index]===null?0:fees[index]/i.qty/100})),mc_meta:{frete_confirmado:order.freight!==null,desconto_confirmado:discount!==null,tarifa_confirmada:fee!==null,frete_comprador:order.buyerFreight===null?null:order.buyerFreight/100,reembolso:null,fonte:'bling',taxa_estimada:fee!==null}}];
  });
}

export function createBling({db,config,fetchImpl=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  const refreshing = new Map(), syncing = new Map();
  let queue = Promise.resolve();
  const configured = () => Boolean(config.BLING_CLIENT_ID && config.BLING_CLIENT_SECRET && config.BLING_REDIRECT_URI);
  async function request(path, options) {
    const previous = queue;
    let done; queue = new Promise(resolve=>{done=resolve;});
    await previous;
    try {
      await sleep(350);
      let response;
      try { response=await fetchImpl(`https://api.bling.com.br/Api/v3${path}`,{...options,signal:AbortSignal.timeout(20000)}); }
      catch { throw new AppError('Não foi possível acessar o Bling. A última coleta foi preservada.'); }
      let body; try { body=await response.json(); } catch { throw new AppError('O Bling retornou uma resposta inválida.'); }
      return {response,body};
    } finally { done(); }
  }
  async function exchange(userId, params) {
    if (!configured()) throw new AppError('Configure o aplicativo Bling no servidor para conectar.',503);
    const {response,body}=await request('/oauth/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${config.BLING_CLIENT_ID}:${config.BLING_CLIENT_SECRET}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded','enable-jwt':'1',Accept:'application/json'},body:new URLSearchParams(params)});
    if (!response.ok) throw new AppError('A autorização do Bling expirou ou não pôde ser concluída. Conecte novamente.',401);
    if (typeof body.access_token!=='string' || typeof body.refresh_token!=='string' || !Number.isFinite(body.expires_in) || body.expires_in<=0) throw new AppError('O Bling retornou credenciais incompletas.');
    const token={access_token:body.access_token,refresh_token:body.refresh_token,expires_at:now()+body.expires_in*1000}; db.saveBlingToken(userId,token); return token;
  }
  async function access(userId, rejected) {
    if (refreshing.has(userId)) return refreshing.get(userId);
    const current=db.getBlingToken(userId);
    if (!current) throw new AppError('Conecte sua conta do Bling para importar as vendas.',401);
    if (current.expires_at>now()+300000 && (!rejected || current.access_token!==rejected)) return current.access_token;
    const pending=exchange(userId,{grant_type:'refresh_token',refresh_token:current.refresh_token}).then(t=>t.access_token);
    refreshing.set(userId,pending); try {return await pending;} finally {refreshing.delete(userId);}
  }
  async function api(userId,path) {
    let token=await access(userId);
    let result=await request(path,{headers:{Authorization:`Bearer ${token}`,'enable-jwt':'1',Accept:'application/json'}});
    if (result.response.status===401) {token=await access(userId,token);result=await request(path,{headers:{Authorization:`Bearer ${token}`,'enable-jwt':'1',Accept:'application/json'}});}
    if (!result.response.ok) throw new AppError(result.response.status===429?'O limite de consultas do Bling foi atingido. Aguarde para atualizar.':result.response.status===403?'O aplicativo Bling não tem os escopos de leitura necessários.':result.response.status===401?'Reconecte a conta do Bling.':`Falha ao consultar o Bling (HTTP ${result.response.status}).`,[401,403,429].includes(result.response.status)?result.response.status:502);
    if (!Object.hasOwn(result.body,'data')) throw new AppError('O Bling retornou dados incompletos.');
    return result.body.data;
  }
  async function list(userId,path,params={}) {
    const results=[],seen=new Set();
    for(let page=1;page<=10000;page++) {
      const data=await api(userId,`${path}?${new URLSearchParams({...params,pagina:String(page),limite:'100'})}`);
      if(!Array.isArray(data)) throw new AppError('A listagem do Bling está incompleta.');
      for(const row of data) {if(!row.id || seen.has(String(row.id))) throw new AppError('A paginação do Bling mudou durante a consulta. Tente novamente.');seen.add(String(row.id));results.push(row);}
      if(data.length<100) return results;
    }
    throw new AppError('A coleta do Bling excedeu o limite de páginas. Reduza o período.');
  }
  async function collect(userId, days) {
    const day = ms=>new Date(ms-10800000).toISOString().slice(0,10);
    const from=day(now()-days*86400000),to=day(now());
    const shops=(await list(userId,'/canais-venda')).map(s=>({id:String(s.id),name:String(s.descricao || s.id),type:String(s.tipo || '')}));
    const modules=await api(userId,'/situacoes/modulos');
    if(!Array.isArray(modules)) throw new AppError('As situações do Bling estão incompletas.');
    const sales=modules.find(m=>m.nome==='Vendas' || m.descricao==='Pedidos de Venda');
    const statuses=sales ? await api(userId,`/situacoes/modulos/${encodeURIComponent(sales.id)}`) : [];
    if(!Array.isArray(statuses)) throw new AppError('As situações do Bling estão incompletas.');
    const summaries=await list(userId,'/pedidos/vendas',{dataInicial:from,dataFinal:to});
    const orders=[];
    for(const summary of summaries) {
      const detail=await api(userId,`/pedidos/vendas/${encodeURIComponent(summary.id)}`);
      if(String(detail?.id)!==String(summary.id)) throw new AppError('O Bling retornou um pedido diferente do solicitado.');
      orders.push(sanitizeOrder(detail));
    }
    const old=db.getBlingCache(userId);
    // Replace the fetched interval so deleted or moved orders do not remain in it.
    const merged=new Map((old?.orders || []).filter(o=>o.day<from || o.day>to).map(o=>[o.id,o]));
    orders.forEach(o=>merged.set(o.id,o));
    const value={shops,statuses:statuses.map(s=>({id:String(s.id),name:String(s.nome)})),orders:[...merged.values()],from,to};
    db.saveBlingCache(userId,value); return {count:orders.length,from,to};
  }
  async function sync(userId,days=65) {
    if(syncing.has(userId)) return syncing.get(userId);
    const promise=collect(userId,days).finally(()=>syncing.delete(userId));syncing.set(userId,promise);return promise;
  }
  return {configured,exchange,api,sync};
}
