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

  async function api(userId, path, extraHeaders = {}) {
    let token = await accessToken(userId);
    const call = () => request(`https://api.mercadolibre.com${path}`, { headers: { Authorization: `Bearer ${token}`, ...extraHeaders } });
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

  const shippingType = value => ({ fulfillment: 'Full', full: 'Full', drop_off: 'Coleta', xd_drop_off: 'Coleta',
    self_service: 'Flex', flex: 'Flex', cross_docking: 'Correios', carrier: 'Correios', me1: 'Correios' }[String(value || '').toLowerCase()] || (value ? String(value) : null));

  async function shipping(order, userId) {
    const direct = order.shipping || order.shipment;
    if (direct) return { status: direct.status || null, type: shippingType(direct.logistic_type || direct.type) };
    try {
      const links = await api(userId, `/orders/${encodeURIComponent(order.id)}/shipments`);
      const list = Array.isArray(links) ? links : (Array.isArray(links?.shipments) ? links.shipments : []);
      const link = list[0];
      if (!link?.id) return { status: null, type: null };
      const detail = await api(userId, `/shipments/${encodeURIComponent(link.id)}`);
      return { status: detail.status || link.status || null, type: shippingType(detail.logistic_type || detail.type || link.type) };
    } catch (error) {
      if (error instanceof AppError && (error.status === 401 || error.status === 429)) throw error;
      return { status: null, type: null };
    }
  }

  async function syncPedidos(userId, days = 60) {
    const end = new Date(now()); const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const orders = []; const seen = new Set(); let offset = 0; let total = null;
    while (total === null || offset < total) {
      const query = new URLSearchParams({ seller: String(userId), 'order.date_created.from': start.toISOString(),
        'order.date_created.to': end.toISOString(), sort: 'date_asc', limit: '50', offset: String(offset) });
      const page = await api(userId, `/orders/search?${query}`);
      if (!Array.isArray(page.results) || !Number.isFinite(page.paging?.total)) throw new AppError('A resposta de pedidos está incompleta.');
      total = page.paging.total;
      if (!page.results.length && offset < total) throw new AppError('A consulta foi interrompida antes de carregar todos os pedidos.');
      for (const order of page.results) {
        const id = String(order.id); const created = Date.parse(order.date_created);
        if (seen.has(id) || !Number.isFinite(created) || created < start.getTime() || created > end.getTime()) continue;
        seen.add(id);
        const ship = await shipping(order, userId);
        orders.push({ order_id: id, date_created: order.date_created, buyer_nickname: order.buyer?.nickname || null,
          items: (Array.isArray(order.order_items) ? order.order_items : []).map(line => ({ sku: line.item?.seller_sku || line.item?.seller_custom_field || null,
            title: line.item?.title || null, quantity: Number(line.quantity) || 0, unit_price: Number(line.unit_price) || 0 })),
          total_amount: Number(order.total_amount) || 0, currency_id: order.currency_id || null, order_status: order.status || 'unknown',
          shipping_status: ship.status, shipping_type: ship.type });
      }
      offset += page.results.length;
      if (page.results.length === 0) break;
    }
    db.replacePedidos(userId, orders);
    return { count: orders.length, from: start.toISOString(), to: end.toISOString() };
  }

  function sumDiscounts(body) {
    return (body?.details || []).reduce((total, detail) => total + (detail.items || []).reduce((sum, item) => sum + Number(item.amounts?.seller || 0), 0), 0);
  }

  async function syncMargens(userId, days = 60) {
    const end = new Date(now()); const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const rows = []; const seen = new Set(); let offset = 0; let total = null;
    while (total === null || offset < total) {
      const query = new URLSearchParams({ seller: String(userId), 'order.date_created.from': start.toISOString(), 'order.date_created.to': end.toISOString(), sort: 'date_asc', limit: '50', offset: String(offset) });
      const page = await api(userId, `/orders/search?${query}`); total = page.paging?.total;
      if (!Array.isArray(page.results) || !Number.isFinite(total)) throw new AppError('A resposta de pedidos está incompleta.');
      if (!page.results.length && offset < total) throw new AppError('A consulta foi interrompida antes de carregar todos os pedidos.');
      for (const order of page.results) {
        const id = String(order.id); const created = Date.parse(order.date_created);
        if (seen.has(id) || !Number.isFinite(created) || created < start.getTime() || created > end.getTime()) continue; seen.add(id);
        const items = (order.order_items || []).map(line => ({ sku: line.item?.seller_sku || line.item?.seller_custom_field || null, title: line.item?.title || null, quantity: Number(line.quantity) || 0, unit_price: Number(line.unit_price) || 0, gross_price: Number(line.gross_price) || (Number(line.unit_price) || 0) * (Number(line.quantity) || 0), sale_fee: Number(line.sale_fee) || 0 }));
        const bruto = items.reduce((sum, item) => sum + item.gross_price, 0) || Number(order.total_amount) || 0;
        const tarifas = items.reduce((sum, item) => sum + item.sale_fee * item.quantity, 0);
        let frete = 0; let freteDesconto = 0; let envioStatus = null; let envioTipo = null;
        try {
          const links = await api(userId, `/orders/${encodeURIComponent(id)}/shipments`); const list = Array.isArray(links) ? links : (links?.shipments || []); const link = list[0] || (order.shipping?.id ? order.shipping : null);
          if (link?.id) {
            const shipment = await api(userId, `/shipments/${encodeURIComponent(link.id)}`, { 'x-format-new': 'true' }); envioStatus = shipment.status || null; envioTipo = shipment.logistic_type || shipment.shipping_mode || null;
            const costs = await api(userId, `/shipments/${encodeURIComponent(link.id)}/costs`, { 'x-format-new': 'true' }); const sender = (costs.senders || []).find(value => String(value.user_id) === String(userId)) || costs.senders?.[0]; frete = Number(sender?.cost) || 0; freteDesconto = (sender?.discounts || []).reduce((sum, value) => sum + Number(value.promoted_amount || 0), 0);
          }
        } catch (error) { if (error instanceof AppError && (error.status === 401 || error.status === 429)) throw error; }
        let descontos = 0; try { descontos = sumDiscounts(await api(userId, `/orders/${encodeURIComponent(id)}/discounts`)); } catch (error) { if (error instanceof AppError && (error.status === 401 || error.status === 429)) throw error; }
        rows.push({ order_id: id, date_created: order.date_created, buyer_nickname: order.buyer?.nickname || null, items, bruto, tarifas, frete, frete_desconto: freteDesconto, descontos, status: order.status || 'unknown', envio_status: envioStatus, envio_tipo: envioTipo });
      }
      offset += page.results.length; if (!page.results.length) break;
    }
    db.replaceMargens(userId, rows); return { count: rows.length, from: start.toISOString(), to: end.toISOString() };
  }

  return { exchangeToken, accessToken, api, sales, syncPedidos, syncMargens };
}
