import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AppError, createMercadoLivre } from './mercado-livre.js';
import { installMcRoutes } from './mc-routes.js';
import { createBling } from './bling.js';
import { installBlingRoutes } from './bling-routes.js';

const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');

export function createApp({ db, config, fetchImpl, now }) {
  const app = express();
  const ml = createMercadoLivre({ db, config, fetchImpl, now });
  const bling = createBling({ db, config, fetchImpl, now });
  const secure = config.ML_REDIRECT_URI?.startsWith('https://');
  const cookie = { httpOnly: true, sameSite: 'lax', secure: Boolean(secure), path: '/' };
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.set('view engine', 'ejs');
  app.set('views', fileURLToPath(new URL('./views', import.meta.url)));
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    const raw = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith('meli_session='))?.slice(13);
    req.sessionId = raw && /^[\w-]{43}$/.test(raw) ? hash(raw) : null;
    req.session = req.sessionId ? db.getSession(req.sessionId) : null;
    res.locals.connected = Boolean(req.session?.user_id);
    res.locals.money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
    res.locals.date = value => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
    next();
  });
  app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

  app.get('/mock-dashboard', (req, res) => res.render('mock-dashboard'));

  function newSession(res, values, maxAge) {
    const raw = random();
    db.saveSession(hash(raw), { ...values, expires_at: Date.now() + maxAge });
    res.cookie('meli_session', raw, { ...cookie, maxAge });
  }

  app.get('/', (req, res) => res.render('inicio', { configured: Boolean(config.ML_APP_ID && config.ML_CLIENT_SECRET && config.ML_REDIRECT_URI) }));
  app.get('/auth/mercadolivre', (req, res) => {
    if (!config.ML_APP_ID || !config.ML_CLIENT_SECRET || !config.ML_REDIRECT_URI) {
      throw new AppError('Preencha as três variáveis do arquivo .env e reinicie o aplicativo para conectar sua conta.', 503);
    }
    const state = random();
    const verifier = random();
    if (req.sessionId) db.deleteSession(req.sessionId);
    newSession(res, { state, verifier }, 10 * 60 * 1000);
    const url = new URL('https://auth.mercadolivre.com.br/authorization');
    url.search = new URLSearchParams({ response_type: 'code', client_id: config.ML_APP_ID,
      redirect_uri: config.ML_REDIRECT_URI, state, code_challenge: hash(verifier), code_challenge_method: 'S256' }).toString();
    res.redirect(url.toString());
  });
  app.get('/callback', async (req, res) => {
    if (!req.session?.state || typeof req.query.state !== 'string' || req.query.state !== req.session.state) {
      throw new AppError('O login expirou ou o retorno é inválido. Clique em Conectar Mercado Livre para tentar novamente.', 400);
    }
    const verifier = req.session.verifier;
    db.deleteSession(req.sessionId); // State de uso único, inclusive em cancelamentos.
    res.clearCookie('meli_session', cookie);
    if (req.query.error) throw new AppError('A conexão não foi autorizada. Você pode tentar novamente.', 400);
    if (typeof req.query.code !== 'string' || !req.query.code) throw new AppError('O código de autorização não foi recebido.', 400);
    const token = await ml.exchangeToken({ grant_type: 'authorization_code', code: req.query.code,
      redirect_uri: config.ML_REDIRECT_URI, code_verifier: verifier });
    newSession(res, { user_id: String(token.user_id) }, 30 * 24 * 60 * 60 * 1000);
    res.redirect('/painel');
  });
  const requireLogin = (req, res, next) => {
    if (req.session?.user_id) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Conecte sua conta do Mercado Livre para continuar.' });
    res.redirect('/');
  };
  app.get('/painel', requireLogin, async (req, res) => res.render('painel', { data: await ml.sales(req.session.user_id) }));
  app.get('/pedidos', requireLogin, async (req, res) => {
    const userId = req.session.user_id;
    const lastSync = db.getPedidosSyncAt(userId);
    if (!lastSync || lastSync < Date.now() - 60 * 60 * 1000) await ml.syncPedidos(userId, 60);
    const from = typeof req.query.de === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.de) ? `${req.query.de}T00:00:00.000Z` : null;
    const to = typeof req.query.ate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate) ? `${req.query.ate}T23:59:59.999Z` : null;
    const status = typeof req.query.status === 'string' && /^[a-z_]+$/.test(req.query.status) ? req.query.status : null;
    const pedidos = db.listPedidos(userId, { from, to, status });
    res.render('pedidos', { pedidos, filtros: { de: req.query.de || '', ate: req.query.ate || '', status: status || '' }, ultimaSincronizacao: db.getPedidosSyncAt(userId), statuses: ['confirmed', 'paid', 'cancelled', 'partially_refunded', 'pending_cancel'] });
  });
  app.post('/pedidos/atualizar', requireLogin, async (req, res) => { await ml.syncPedidos(req.session.user_id, 60); res.redirect('/pedidos'); });
  app.get('/custos', requireLogin, (req, res) => res.render('custos', { custos: db.listCustos(), erro: null }));
  app.post('/custos', requireLogin, (req, res) => {
    try {
      const csv = String(req.body.csv || '');
      if (csv.trim()) for (const [index, line] of csv.split(/\r?\n/).entries()) {
        if (!line.trim() || index === 0 && /^\s*sku\s*;/i.test(line)) continue;
        const [rawSku, rawCost, rawTax] = line.split(';').map(value => value?.trim());
        const sku = rawSku; const cost = Number(String(rawCost || '').replace(/\./g, '').replace(',', '.')); const tax = Number(String(rawTax || '0').replace(',', '.'));
        if (!sku || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(tax) || tax < 0) throw new Error(`Linha ${index + 1} inválida.`);
        db.upsertCusto(sku, cost, tax);
      }
      if (req.body.sku) {
        const cost = Number(String(req.body.custo || '').replace(',', '.')); const tax = Number(String(req.body.imposto || '0').replace(',', '.'));
        if (!String(req.body.sku).trim() || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(tax) || tax < 0) throw new Error('Valores inválidos.');
        db.upsertCusto(String(req.body.sku).trim(), cost, tax);
      }
      if (req.body.excluir) db.deleteCusto(String(req.body.excluir));
      res.redirect('/custos');
    } catch (error) { res.status(400).render('custos', { custos: db.listCustos(), erro: error.message }); }
  });
  app.get('/margem', requireLogin, async (req, res) => {
    const userId = req.session.user_id; const lastSync = db.getMargemSyncAt(userId);
    if (!lastSync || lastSync < Date.now() - 60 * 60 * 1000) await ml.syncMargens(userId, 60);
    const from = typeof req.query.de === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.de) ? `${req.query.de}T00:00:00.000Z` : null;
    const to = typeof req.query.ate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate) ? `${req.query.ate}T23:59:59.999Z` : null;
    const status = typeof req.query.status === 'string' && /^[a-z_]+$/.test(req.query.status) ? req.query.status : null;
    const custos = new Map(db.listCustos().map(row => [row.sku, row]));
    const pedidos = db.listMargens(userId, { from, to, status }).map(row => {
      let custo = 0; let impostos = 0; let completo = true;
      for (const item of row.items) { const price = custos.get(item.sku); if (!price) { completo = false; continue; } custo += price.custo_unitario * item.quantity; impostos += item.gross_price * price.imposto_percentual / 100; }
      const receita = row.bruto - row.tarifas - row.frete - row.descontos; const margem = completo ? receita - custo - impostos : null;
      return { ...row, receita, custo, impostos, margem, margem_percentual: margem === null || !row.bruto ? null : margem / row.bruto * 100, sem_custo: !completo };
    });
    const complete = pedidos.filter(row => row.margem !== null); const totals = ['bruto', 'tarifas', 'frete', 'descontos', 'custo', 'impostos'].reduce((out, key) => ({ ...out, [key]: complete.reduce((sum, row) => sum + row[key], 0) }), {});
    totals.receita = totals.bruto - totals.tarifas - totals.frete - totals.descontos; totals.margem = complete.reduce((sum, row) => sum + row.margem, 0); totals.margem_percentual = totals.bruto ? totals.margem / totals.bruto * 100 : 0;
    const rank = new Map(); for (const row of complete) for (const item of row.items) { const price = custos.get(item.sku); if (!price) continue; const value = rank.get(item.sku) || { sku: item.sku, titulo: item.title, margem: 0, bruto: 0, quantidade: 0 }; value.margem += (item.gross_price - item.sale_fee * item.quantity - item.gross_price * price.imposto_percentual / 100 - price.custo_unitario * item.quantity); value.bruto += item.gross_price; value.quantidade += item.quantity; rank.set(item.sku, value); }
    const ranking = [...rank.values()].map(row => ({ ...row, percentual: row.bruto ? row.margem / row.bruto * 100 : 0 })).sort((a, b) => b.margem - a.margem);
    res.render('margem', { pedidos, totals, ranking, filtros: { de: req.query.de || '', ate: req.query.ate || '', status: status || '' }, statuses: ['confirmed', 'paid', 'cancelled', 'partially_refunded', 'pending_cancel'], ultimaSincronizacao: db.getMargemSyncAt(userId) });
  });
  app.post('/margem/atualizar', requireLogin, async (req, res) => { await ml.syncMargens(req.session.user_id, 60); res.redirect('/margem'); });
  app.get('/devolucoes', requireLogin, async (req, res) => {
    const userId = req.session.user_id; const lastSync = db.getDevolucoesSyncAt(userId); let syncWarning = null;
    if (!req.query.rate_limited && (!lastSync || lastSync < Date.now() - 60 * 60 * 1000)) {
      try { await ml.syncDevolucoes(userId, 90); } catch (error) {
        if (error instanceof AppError && error.status === 429) syncWarning = 'O Mercado Livre atingiu o limite temporário de consultas. Exibindo os dados da última sincronização; tente Atualizar novamente mais tarde.';
        else throw error;
      }
    }
    const from = typeof req.query.de === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.de) ? `${req.query.de}T00:00:00.000Z` : null;
    const to = typeof req.query.ate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate) ? `${req.query.ate}T23:59:59.999Z` : null;
    const status = typeof req.query.status === 'string' && /^[a-z_]+$/.test(req.query.status) ? req.query.status : null;
    const casos = db.listDevolucoes(userId, { from, to, status }); const pedidos = db.listPedidos(userId, {});
    const skuMap = new Map(); casos.forEach(c => (c.items || []).forEach(i => { const key = i.sku || 'não disponível'; const x = skuMap.get(key) || { sku: key, total: 0, motivos: new Map() }; x.total += Number(i.quantity) || 0; x.motivos.set(c.reason, (x.motivos.get(c.reason) || 0) + 1); skuMap.set(key, x); }));
    const topSkus = [...skuMap.values()].sort((a,b) => b.total-a.total).slice(0,5).map(x => ({ sku:x.sku, total:x.total, motivo:[...x.motivos.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] || 'não disponível' }));
    const resumo = { quantidade: casos.filter(c => c.type === 'return').length, taxa: pedidos.length ? casos.filter(c => c.type === 'return').length / pedidos.length * 100 : null, custo: casos.reduce((s,c)=>s+(Number(c.real_cost)||0),0), topSkus };
    res.render('devolucoes', { casos, resumo, filtros: { de: req.query.de || '', ate: req.query.ate || '', status: status || '' }, statuses: ['opened', 'closed', 'shipped', 'delivered', 'not_delivered', 'cancelled'], ultimaSincronizacao: db.getDevolucoesSyncAt(userId), syncWarning });
  });
  app.get('/devolucoes.csv', requireLogin, (req, res) => { const rows = db.listDevolucoes(req.session.user_id, {}); const esc = v => `"${String(v ?? 'não disponível').replace(/"/g, '""')}"`; const head = ['pedido','data_venda','data_abertura','motivo','tipo','status','resolvido_por','reembolso','tarifa_devolvida','frete_retorno','outras_cobrancas','custo_real']; const lines = [head, ...rows.map(c => [c.order_id,c.sale_date,c.date_opened,c.reason,c.type,c.status,c.resolved_by,c.refund_amount,c.sale_fee_returned === true ? 'sim' : c.sale_fee_returned === false ? 'não' : 'não disponível',c.return_shipping_cost,c.other_charges,c.real_cost])].map(r => r.map(esc).join(';')); res.type('text/csv').set('Content-Disposition','attachment; filename="devolucoes.csv"').send('\ufeff' + lines.join('\r\n')); });
  app.post('/devolucoes/atualizar', requireLogin, async (req, res) => { try { await ml.syncDevolucoes(req.session.user_id, 90); res.redirect('/devolucoes'); } catch (error) { if (error instanceof AppError && error.status === 429) return res.redirect('/devolucoes?rate_limited=1'); throw error; } });
  installBlingRoutes(app, { db, bling, config, requireLogin });
  installMcRoutes(app, { db, ml, bling, requireLogin, now });
  app.get('/api/vendas', requireLogin, async (req, res) => res.json(await ml.sales(req.session.user_id)));
  app.use((req, res, next) => next(new AppError('Página não encontrada.', 404)));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof AppError ? error.status : 500;
    const message = error instanceof AppError ? error.message : 'Não foi possível concluir a operação. Tente novamente.';
    if (status === 500) console.error('Falha interna:', error.name); // Não registrar códigos ou tokens.
    if (req.path.startsWith('/api/')) return res.status(status).json({ erro: message });
    res.status(status).render('erro', { message });
  });
  return app;
}
