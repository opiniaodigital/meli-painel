import { createHmac, randomBytes } from 'node:crypto';
import { buildDashboard, publicDashboard, priceBands, period } from './mc.js';
import { AppError } from './mercado-livre.js';
import { blingRows, CHANNELS } from './bling.js';

export function installMcRoutes(app, { db, ml, bling, requireLogin, now = Date.now }) {
  const pending = new Map();
  const secret = randomBytes(32);
  const csrf = req => createHmac('sha256', secret).update(req.sessionId).digest('hex');
  const guard = (req, res, next) => {
    if (req.body.csrf !== csrf(req)) return next(new AppError('O formulário expirou. Atualize a página e tente novamente.', 403));
    next();
  };
  async function sync(userId, force = false, days = 65) {
    const last = db.getMargemSyncAt(userId);
    if (!force && last && last >= now() - 5 * 60000) return;
    if (!pending.has(userId)) {
      const promise = ml.syncMargens(userId, days).finally(() => pending.delete(userId));
      pending.set(userId, promise);
    }
    return pending.get(userId);
  }
  async function read(req) {
    period(req.query, now()); // Reject invalid requests before calling the marketplace.
    let warning = null;
    try { await sync(req.session.user_id); }
    catch (error) {
      if (!db.getMargemSyncAt(req.session.user_id) || !(error instanceof AppError) || error.status === 401) throw error;
      warning = `${error.message} Exibindo a última coleta concluída.`;
    }
    let blingCache=db.getBlingCache(req.session.user_id);
    if (db.getBlingToken(req.session.user_id) && (!blingCache || blingCache.updated_at < now()-4*3600000)) {
      try { await bling.sync(req.session.user_id);blingCache=db.getBlingCache(req.session.user_id); }
      catch(error) { if(!(error instanceof AppError)) throw error; warning=[warning,error.message,'Dados do Bling podem estar desatualizados.'].filter(Boolean).join(' '); }
    }
    const rows=[...db.listMargens(req.session.user_id),...blingRows(req.session.user_id,blingCache,db.getBlingSettings(req.session.user_id))];
    const data = buildDashboard({ rows, costs: db.listCustos(), query: req.query, now: now(), sync: db.getMargemSyncAt(req.session.user_id) });
    data.blingSync=blingCache?.updated_at || null;
    return { ...data, warning };
  }
  app.get(['/mc', '/promocao/mc'], requireLogin, async (req, res) => {
    const data = await read(req);
    const urlFor = changes => {
      const params = new URLSearchParams();
      for (const [key,value] of Object.entries(req.query)) if (typeof value === 'string') params.set(key, value);
      params.delete('pagina');
      for (const [key,value] of Object.entries(changes)) value === null ? params.delete(key) : params.set(key, String(value));
      return `${req.path}?${params}`;
    };
    res.set('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.render('mc', { d: data, channelName: key=>CHANNELS[key] || key, embedded: req.path !== '/mc', csrf: csrf(req), urlFor, priceBands, cmoney: value => value === null ? 'Pendente' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100), percent: value => value === null ? '—' : `${value.toFixed(2)}%` });
  });
  app.get('/api/mc/realtime', requireLogin, async (req, res) => {
    const data = await read(req); res.json({ ...publicDashboard(data), aviso: data.warning });
  });
  app.get('/api/mc/resumo', requireLogin, async (req, res) => { const d = await read(req); res.json({ periodo:d.range, cards:d.totals, por_canal:d.byChannel, por_conta:d.byAccount, por_envio:d.byShipping, mensal:d.monthly, ontem:d.yesterday, hoje:d.today }); });
  app.get('/api/mc/skus', requireLogin, async (req, res) => { const d = await read(req); res.json({ periodo:d.range, skus:d.ranking }); });
  app.get('/api/mc/ranking', requireLogin, async (req, res) => { const d = await read(req); res.json({ periodo:d.range, visao:req.query.ordem || 'margin', agrupamento:req.query.grupo || 'sku', ranking:d.ranking }); });
  app.get('/api/mc/ranking-full', requireLogin, async (req, res) => { const d = await read(req); res.json({ periodo:d.range, visoes:['margin','percent','revenue','units','abc'], agrupamento:req.query.group || 'sku', total:d.ranking.length, ranking:d.ranking }); });
  app.get('/api/mc/ritmo', requireLogin, async (req, res) => { const d = await read(req); res.json({ periodo:d.range, dias:d.daily }); });
  app.get('/api/mc/decisoes', requireLogin, async (req, res) => { const d = await read(req); const decisoes=d.ranking.slice(0,100).map(row=>({sku:row.sku,id:row.id,titulo:row.title,acao:row.pct===null?'completar_dados':row.pct<20?'rever_preco':row.pct>=25?'forcar_venda':'acompanhar',mc_percentual:row.pct,unidades:row.qty})); res.json({ periodo:d.range, decisoes }); });
  app.get('/api/mc/por-sku', requireLogin, async (req, res) => { const d = await read(req); const wanted=String(req.query.sku || ''); res.json({ periodo:d.range, sku:d.ranking.find(row=>row.sku===wanted) || null }); });
  app.get('/api/mc/faixas', requireLogin, async (req, res) => { const d = await read(req); const wanted=String(req.query.sku || ''); const group=d.ranking.find(row=>row.sku===wanted || row.id===wanted); if(!group) return res.status(404).json({erro:'SKU não encontrado no período.'}); res.json({ periodo:d.range, sku:wanted, faixas:priceBands(group,d.range.days) }); });
  app.get('/api/mc/custo-manual', requireLogin, async (req, res) => { const d=await read(req); res.json({ sem_custo:d.missingCosts, custos:db.listCustos() }); });
  app.get('/api/mc/comissoes', requireLogin, (req, res) => res.json({ fonte:'Mercado Livre: tarifa real do pedido; Bling/ERP: percentual configurado por canal', configuracoes:db.getBlingSettings(req.session.user_id).commissions || {} }));
  app.get('/api/mc/frete-proprio', requireLogin, (req, res) => res.json({ habilitado:false, fonte:null, prioridade:['cte_real','fatura_transportadora','cotacao','tabela_manual'], cobertura:0, aviso:'CT-e, faturas e cotações de transportadoras ainda não estão conectados.' }));
  app.get('/api/mc/frete-proprio-analise', requireLogin, (req, res) => res.json({ dias:Number(req.query.dias) || 30, transportadoras:[], por_produto:[], destinos_caros:[], tendencia:[], cobertura:0, aviso:'Análise indisponível até conectar as fontes de frete próprio.' }));
  app.get('/api/mc/frete-cte', requireLogin, (req, res) => res.json({ habilitado:false, fonte_cte:false, recebidos:0, casados:0, aviso:'A integração SEFAZ/CT-e ainda não foi configurada.' }));
  app.post('/api/mc/realtime-run', requireLogin, guard, async (req, res) => { const days=Math.min(365,Math.max(1,Number(req.body.dias) || 65)); const result=await sync(req.session.user_id,true,days); if(bling) await bling.sync(req.session.user_id,days); res.json({ok:true,resultado:result,ultima_sincronizacao:db.getMargemSyncAt(req.session.user_id)}); });
  app.post('/mc/atualizar', requireLogin, guard, async (req, res) => {
    const range = period(req.body, now());
    const days = Math.max(65, Math.ceil((now() - range.from) / 86400000) + 1);
    await sync(req.session.user_id, true, days);
    if(db.getBlingToken(req.session.user_id)) await bling.sync(req.session.user_id,days);
    res.redirect(303, `/mc?${new URLSearchParams({ periodo: range.preset, di: range.di, df: range.df })}`);
  });
  app.post('/mc/custo', requireLogin, guard, (req, res) => {
    const sku = typeof req.body.sku === 'string' ? req.body.sku.trim() : '';
    const parse = value => typeof value === 'string' && /^\d+(?:[.,]\d{1,2})?$/.test(value.trim()) ? Number(value.replace(',', '.')) : NaN;
    const cost = parse(req.body.custo), tax = parse(req.body.imposto);
    const owned = [...db.listMargens(req.session.user_id),...blingRows(req.session.user_id,db.getBlingCache(req.session.user_id),db.getBlingSettings(req.session.user_id))].some(row => row.items.some(item => item.sku === sku));
    if (!sku || sku.length > 200 || !owned || !Number.isFinite(cost) || cost > 10000000 || !Number.isFinite(tax) || tax > 100) throw new AppError('Informe um SKU das suas vendas, custo válido e imposto entre 0 e 100%.', 400);
    db.upsertCusto(sku, cost, tax);
    res.redirect(303, '/mc?aba=ranking&periodo=month');
  });
}
