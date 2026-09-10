export class AppError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function createMercadoLivre({ db, config, fetchImpl = fetch, now = Date.now }) {
  // Uma única renovação por vendedor evita reutilizar refresh tokens em chamadas simultâneas.
  const refreshing = new Map();

  async function request(url, options) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) });
    } catch {
      throw new AppError('Não foi possível acessar o Mercado Livre. Tente novamente em instantes.');
    }
    let body;
    try { body = await response.json(); } catch {
      throw new AppError('O Mercado Livre retornou uma resposta inválida.');
    }
    return { response, body };
  }

  async function exchangeToken(params, expectedUser) {
    if (!config.ML_APP_ID || !config.ML_CLIENT_SECRET || !config.ML_REDIRECT_URI) {
      throw new AppError('Preencha ML_APP_ID, ML_CLIENT_SECRET e ML_REDIRECT_URI no arquivo .env e reinicie o aplicativo.', 503);
    }
    const { response, body } = await request('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: config.ML_APP_ID, client_secret: config.ML_CLIENT_SECRET, ...params }),
    });
    if (!response.ok) {
      if (body.error === 'invalid_grant') throw new AppError('A autorização expirou ou foi revogada. Conecte sua conta novamente.', 401);
      throw new AppError('Não foi possível autorizar a conta. Confira as credenciais e a URL de retorno do aplicativo.');
    }
    if (!body.access_token || !body.refresh_token || !body.user_id || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
      throw new AppError('O Mercado Livre retornou credenciais incompletas. Conecte sua conta novamente.');
    }
    if (expectedUser && String(body.user_id) !== String(expectedUser)) throw new AppError('A conta retornada não corresponde ao vendedor.');
    const token = { ...body, expires_at: now() + body.expires_in * 1000 };
    db.saveToken(token); // Os dois tokens e a validade são substituídos na mesma instrução SQLite.
    return token;
  }

  async function accessToken(userId, rejectedToken) {
    const id = String(userId);
    if (refreshing.has(id)) return refreshing.get(id);
    const seller = db.getSeller(id);
    if (!seller) throw new AppError('Conecte sua conta do Mercado Livre para continuar.', 401);
    if (seller.expires_at > now() + 5 * 60 * 1000 && (!rejectedToken || seller.access_token !== rejectedToken)) {
      return seller.access_token;
    }
    const pending = exchangeToken({ grant_type: 'refresh_token', refresh_token: seller.refresh_token }, id)
      .then(token => token.access_token);
    refreshing.set(id, pending);
    try { return await pending; } finally { refreshing.delete(id); }
  }

  async function api(userId, path) {
    let token = await accessToken(userId);
    const call = () => request(`https://api.mercadolibre.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
    let result = await call();
    if (result.response.status === 401) {
      token = await accessToken(userId, token);
      result = await call();
    }
    if (!result.response.ok) {
      if (result.response.status === 401) throw new AppError('Conecte sua conta novamente para renovar a autorização.', 401);
      if (result.response.status === 429) throw new AppError('O limite de consultas foi atingido. Aguarde e tente novamente.', 429);
      throw new AppError(`Não foi possível consultar os pedidos (Mercado Livre: HTTP ${result.response.status}).`);
    }
    return result.body;
  }

  async function sales(userId) {
    const end = new Date(now());
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const seen = new Set();
    const items = new Map();
    let totalCents = 0;
    let orders = 0;
    let offset = 0;
    while (true) {
      const query = new URLSearchParams({ seller: String(userId), 'order.status': 'paid',
        'order.date_created.from': start.toISOString(), 'order.date_created.to': end.toISOString(),
        sort: 'date_asc', limit: '50', offset: String(offset) });
      const page = await api(userId, `/orders/search?${query}`);
      if (!Array.isArray(page.results) || !Number.isFinite(page.paging?.total)) throw new AppError('A resposta de pedidos está incompleta.');
      if (!page.results.length && offset < page.paging.total) throw new AppError('A consulta foi interrompida antes de carregar todos os pedidos. Tente novamente.');
      for (const order of page.results) {
        const created = Date.parse(order.date_created);
        // A API arredonda o filtro de datas para horas; refinamos o intervalo localmente.
        if (seen.has(String(order.id))) continue;
        seen.add(String(order.id));
        if (order.status !== 'paid' || order.currency_id !== 'BRL' || !Number.isFinite(created) || created < start.getTime() || created > end.getTime()) continue;
        if (!Number.isFinite(order.total_amount) || !Array.isArray(order.order_items)) throw new AppError('Um pedido retornou valores incompletos.');
        orders++;
        totalCents += Math.round(order.total_amount * 100);
        for (const line of order.order_items) {
          if (!line.item?.id || !Number.isFinite(line.quantity) || !Number.isFinite(line.unit_price)) throw new AppError('Um anúncio retornou valores incompletos.');
          const id = String(line.item.id);
          const item = items.get(id) || { id, titulo: line.item.title || id, quantidade: 0, centavos: 0 };
          item.quantidade += line.quantity;
          item.centavos += Math.round(line.unit_price * 100) * line.quantity;
          items.set(id, item);
        }
      }
      offset += page.results.length;
      if (offset >= page.paging.total) break;
    }
    return {
      vendedor_id: String(userId), moeda: 'BRL', periodo: { de: start.toISOString(), ate: end.toISOString(), dias: 30 },
      total_vendas: totalCents / 100, quantidade_pedidos: orders,
      anuncios_mais_vendidos: [...items.values()].sort((a, b) => b.quantidade - a.quantidade || b.centavos - a.centavos || a.id.localeCompare(b.id))
        .slice(0, 10).map(({ centavos, ...item }) => ({ ...item, total_vendas: centavos / 100 })),
    };
  }
  return { exchangeToken, accessToken, api, sales };
}
