import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AppError, createMercadoLivre } from './mercado-livre.js';

const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');

export function createApp({ db, config, fetchImpl, now }) {
  const app = express();
  const ml = createMercadoLivre({ db, config, fetchImpl, now });
  const secure = config.ML_REDIRECT_URI?.startsWith('https://');
  const cookie = { httpOnly: true, sameSite: 'lax', secure: Boolean(secure), path: '/' };
  app.disable('x-powered-by');
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
