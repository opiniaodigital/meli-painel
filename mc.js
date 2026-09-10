import { AppError } from './mercado-livre.js';

const DAY = 86400000;
export const cents = value => Number.isFinite(value) ? Math.round(value * 100) : null;
const reais = value => value === null ? null : value / 100;
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const localDay = value => new Date(value - 3 * 3600000).toISOString().slice(0, 10);
const midnight = value => Date.parse(`${value}T00:00:00-03:00`);
const monthStart = day => `${day.slice(0, 7)}-01`;
export const approved = status => status === 'paid' || status === 'partially_refunded';

function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(midnight(value)) && localDay(midnight(value)) === value;
}

export function period(query = {}, now = Date.now()) {
  const today = localDay(now);
  const current = midnight(monthStart(today));
  const previous = monthStart(localDay(current - DAY));
  const preset = query.periodo || (query.di || query.df ? 'custom' : 'today');
  let from, to;
  switch (preset) {
    case 'today': from = midnight(today); to = now; break;
    case 'yesterday': from = midnight(today) - DAY; to = midnight(today) - 1; break;
    case 'month': from = current; to = now; break;
    case 'previous': from = midnight(previous); to = current - 1; break;
    case 'custom':
      if (!validDay(query.di) || !validDay(query.df)) throw new AppError('Informe datas válidas para o período personalizado.', 400);
      from = midnight(query.di); to = Math.min(midnight(query.df) + DAY - 1, now); break;
    default: throw new AppError('Período inválido.', 400);
  }
  if (from > to || to - from > 366 * DAY) throw new AppError('Selecione um período de até 366 dias, sem datas futuras.', 400);
  return { preset, from, to, di: localDay(from), df: localDay(to), days: Math.floor((midnight(localDay(to)) - from) / DAY) + 1 };
}

// Largest-remainder allocation preserves every cent across multi-item orders.
export function allocate(total, weights) {
  if (total === null) return weights.map(() => null);
  const denominator = weights.reduce((s, w) => s + w, 0);
  if (!denominator) return weights.map((_, i) => i === 0 ? total : 0);
  const exact = weights.map(w => total * w / denominator);
  const result = exact.map(Math.floor);
  let remainder = total - result.reduce((s, v) => s + v, 0);
  const indices = exact.map((v, i) => i).sort((a, b) => (exact[b] - result[b]) - (exact[a] - result[a]));
  for (const i of indices) { if (remainder-- <= 0) break; result[i]++; }
  return result;
}

export function calculate(row, costs) {
  const meta = row.mc_meta || {};
  const reasons = [];
  const gross = cents(row.bruto);
  const fee = meta.tarifa_confirmada ? cents(row.tarifas) : null;
  const shipping = meta.frete_confirmado ? cents(row.frete) : null;
  const discount = meta.desconto_confirmado ? cents(row.descontos) : null;
  const buyerShipping = cents(meta.frete_comprador);
  const refund = cents(meta.reembolso);
  if (!meta.frete_confirmado) reasons.push('Frete pendente');
  if (!meta.desconto_confirmado) reasons.push('Desconto pendente');
  if (!meta.tarifa_confirmada) reasons.push('Tarifa pendente');
  if (refund === null || refund > 0 || row.status === 'partially_refunded') reasons.push('Devolução por conciliar');
  if (!row.items.length || gross === null) reasons.push('Itens incompletos');
  const weights = row.items.map(item => Math.max(0, cents(item.gross_price) ?? 0));
  const shippingParts = allocate(shipping, weights), discountParts = allocate(discount, weights), feeParts = allocate(fee, weights);
  const lines = row.items.map((item, index) => {
    const base = costs.get(item.sku);
    const qty = Number(item.quantity);
    const itemGross = cents(item.gross_price);
    const cost = base && qty > 0 ? Math.round(cents(base.custo_unitario) * qty) : null;
    const tax = base && itemGross !== null ? Math.round((itemGross - (discountParts[index] ?? 0)) * base.imposto_percentual / 100) : null;
    if (cost === null) reasons.push('Custo ausente');
    const revenue = itemGross === null ? null : itemGross - (discountParts[index] ?? 0);
    const mc = reasons.length || cost === null || tax === null || feeParts[index] === null ? null : revenue - cost - tax - feeParts[index] - shippingParts[index];
    return { sku: item.sku || null, id: item.id || null, title: item.title || item.sku || 'Produto sem identificação', qty, gross: itemGross, revenue, cost, tax, fee: feeParts[index], shipping: shippingParts[index], discount: discountParts[index], mc, price: cents(item.unit_price), date: row.date_created, order: row.order_id, refunded: refund > 0 };
  });
  // Unknown cost on any item makes the entire order incomplete, regardless of item order.
  if (reasons.length) lines.forEach(line => { line.mc = null; });
  const revenue = gross === null ? 0 : gross - (discount ?? 0);
  return { id: row.order_id, externalId:row.external_id || null, date: row.date_created, datePrecision:row.date_precision || 'time', status: row.status, channel: row.channel || 'mercado_livre', account: row.account || String(row.user_id), accountName:row.account_name || String(row.user_id), shippingType: row.envio_tipo || 'unknown', gross, revenue, cost: lines.some(l => l.cost === null) ? null : sum(lines, 'cost'), tax: lines.some(l => l.tax === null) ? null : sum(lines, 'tax'), fee, shipping, buyerShipping, discount, refund, mc: reasons.length ? null : sum(lines, 'mc'), reasons: [...new Set(reasons)], lines };
}

function aggregate(rows) {
  const complete = rows.filter(r => r.mc !== null);
  const revenue = sum(rows, 'revenue');
  const coveredRevenue = sum(complete, 'revenue');
  const mc = complete.length ? sum(complete, 'mc') : rows.length ? null : 0;
  return { count: rows.length, revenue, mc, pct: mc === null || !coveredRevenue ? null : 100 * mc / coveredRevenue, incomplete: rows.length - complete.length, coveredRevenue, cost: sum(complete, 'cost'), tax: sum(complete, 'tax'), fee: sum(rows, 'fee'), shipping: sum(rows, 'shipping'), buyerShipping: sum(rows, 'buyerShipping'), discount: sum(rows, 'discount'), refund: sum(rows, 'refund') };
}

function rank(rows, grouping = 'sku') {
  const groups = new Map();
  for (const row of rows) for (const line of row.lines) {
    const key = (grouping === 'listing' ? line.id : line.sku) || `sem-id:${line.order}:${line.title}`;
    const group = groups.get(key) || { key, sku: line.sku, id: line.id, title: line.title, qty: 0, revenue: 0, productRevenue: 0, mc: 0, cost: 0, tax: 0, fee: 0, shipping: 0, incomplete: 0, refundedOrders: new Set(), orders: new Set(), lines: [] };
    group.qty += line.qty; group.revenue += line.revenue ?? 0;
    group.productRevenue += line.productRevenue ?? line.revenue ?? 0;
    for (const k of ['mc', 'cost', 'tax', 'fee', 'shipping']) group[k] += line[k] ?? 0;
    if (line.mc === null) group.incomplete++;
    group.orders.add(row.id); if (line.refunded) group.refundedOrders.add(row.id);
    group.lines.push(line); groups.set(key, group);
  }
  const result = [...groups.values()].map(g => ({ ...g, mc: g.incomplete ? null : g.mc, pct: g.incomplete || !g.revenue ? null : 100 * g.mc / g.revenue, returnPct: g.orders.size ? g.refundedOrders.size / g.orders.size * 100 : 0, orders: g.orders.size, refundedOrders: g.refundedOrders.size }));
  const positiveTotal = result.reduce((s, g) => s + Math.max(0, g.mc ?? 0), 0);
  let cumulative = 0;
  result.sort((a, b) => (b.mc ?? -Infinity) - (a.mc ?? -Infinity));
  for (const g of result) { g.abc = g.mc === null || g.mc <= 0 ? '—' : cumulative < positiveTotal * .8 ? 'A' : cumulative < positiveTotal * .95 ? 'B' : 'C'; cumulative += Math.max(0, g.mc ?? 0); }
  return result;
}

export function buildDashboard({ rows, costs, query = {}, now = Date.now(), sync }) {
  const normalized = { ...query, envio: query.envio || query.modalidade || '', faixa: query.faixa || query.mc_faixa || '', pagina: query.pagina || query.pag || '' };
  const range = period(normalized, now);
  const tab = ['live', 'analysis', 'prices', 'ranking'].includes(normalized.aba) ? normalized.aba : 'live';
  const includeBuyer = normalized.frete_comprador === '1';
  const shipping = String(normalized.envio || '');
  const channel = String(normalized.canal || '');
  const account = String(normalized.conta || '');
  const costMap = new Map(costs.map(row => [row.sku, row]));
  const all = rows.map(row => {
    const result = calculate(row, costMap);
    if (includeBuyer) {
      const parts = allocate(result.buyerShipping, result.lines.map(l => l.revenue ?? 0));
      result.revenue += result.buyerShipping ?? 0;
      result.lines.forEach((line,i) => { line.productRevenue = line.revenue; line.revenue += parts[i] ?? 0; });
      if (result.buyerShipping === null) { result.reasons.push('Frete comprador pendente'); result.mc = null; result.lines.forEach(l => { l.mc = null; }); }
    }
    return result;
  });
  const matching = all.filter(row => (!shipping || row.shippingType === shipping) && (!channel || row.channel === channel) && (!account || row.account === account));
  const between = (from, to) => matching.filter(row => { const time = Date.parse(row.date); return time >= from && time <= to; });
  const selected = between(range.from, range.to);
  const paid = selected.filter(row => approved(row.status));
  const totals = aggregate(paid);
  const grouped = rank(paid, query.grupo === 'listing' ? 'listing' : 'sku');
  const todayStart = midnight(localDay(now)), month = midnight(monthStart(localDay(now)));
  const previousMonth = midnight(monthStart(localDay(month - DAY)));
  const elapsedClosedDays = Math.floor((todayStart - month) / DAY);
  const comparableDays = Math.min(elapsedClosedDays, Math.round((month - previousMonth) / DAY));
  const monthRows = between(month, now).filter(row => approved(row.status));
  const monthly = aggregate(monthRows);
  const nextMonth = new Date(`${monthStart(localDay(now))}T12:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthDays = Math.round((midnight(nextMonth.toISOString().slice(0, 10)) - month) / DAY);
  monthly.projection = monthly.revenue * (monthDays * DAY) / Math.max(now - month, 1);
  monthly.closedDays = comparableDays;
  monthly.currentClosed = aggregate(between(month, month + comparableDays * DAY - 1).filter(row => approved(row.status))).revenue;
  monthly.previousClosed = aggregate(between(previousMonth, previousMonth + comparableDays * DAY - 1).filter(row => approved(row.status))).revenue;
  const yesterday = aggregate(between(todayStart - DAY, now - DAY).filter(row => approved(row.status) && row.datePrecision === 'time'));
  const today = aggregate(between(todayStart, now).filter(row => approved(row.status) && row.datePrecision === 'time'));
  const search = String(normalized.q || '').trim().toLowerCase().slice(0, 200);
  const band = String(normalized.faixa || '');
  const matchesBand = pct => !band || (band === 'missing' ? pct === null : pct !== null && (band === 'low' ? pct < 20 : band === 'high' ? pct >= 25 : pct >= Number(band) && pct < Number(band) + 1));
  let tableRows = paid.filter(row => (!search || [row.id, ...row.lines.flatMap(l => [l.sku, l.id, l.title])].join(' ').toLowerCase().includes(search)) && matchesBand(row.mc === null || !row.revenue ? null : 100 * row.mc / row.revenue));
  if (query.custo === 'missing') tableRows = tableRows.filter(r => r.reasons.includes('Custo ausente'));
  const pages = Math.max(1, Math.ceil(tableRows.length / 800));
  const page = Math.min(pages, Math.max(1, Number.parseInt(normalized.pagina, 10) || 1));
  const orderKey = { margin: 'mc', percent: 'pct', revenue: 'revenue', units: 'qty', abc: 'mc' }[normalized.ordem] || 'mc';
  const ranking = grouped.filter(g => (!search || `${g.sku} ${g.id} ${g.title}`.toLowerCase().includes(search)) && (normalized.custo !== 'missing' || g.lines.some(l => l.cost === null))).sort((a,b) => (b[orderKey] ?? -Infinity) - (a[orderKey] ?? -Infinity));
  const byShipping = [...new Set(paid.map(r => r.shippingType))].map(type => ({ type, ...aggregate(paid.filter(r => r.shippingType === type)) }));
  const byChannel = [...new Set(paid.map(r=>r.channel))].map(channel=>({channel,...aggregate(paid.filter(r=>r.channel===channel))}));
  const byAccount = [...new Set(paid.map(r=>r.account))].map(account=>({account,name:paid.find(r=>r.account===account).accountName,...aggregate(paid.filter(r=>r.account===account))}));
  const daily = [];
  for (let start = range.from; start <= range.to; start += DAY) daily.push({ day: localDay(start), ...aggregate(between(start, Math.min(start + DAY - 1, range.to)).filter(r => approved(r.status))) });
  return { range, tab, includeBuyer, totals, cancelled: selected.filter(r => r.status === 'cancelled').length, pending: selected.filter(r => !approved(r.status) && r.status !== 'cancelled').length, monthly, yesterday, today, daily, ranking, topRevenue: [...grouped].sort((a,b) => b.revenue-a.revenue).slice(0,5), topUnits: [...grouped].sort((a,b) => b.qty-a.qty).slice(0,5), byChannel, byAccount, channels:[...new Set(['mercado_livre',...all.map(r=>r.channel)])], accountLabels:Object.fromEntries(all.map(r=>[r.account,r.accountName])), byShipping, rows: tableRows.slice((page-1)*800,page*800), rowCount: tableRows.length, pages, page, query:normalized, sync, shippingOptions: [...new Set(all.map(r => r.shippingType))].sort(), accounts: [...new Set(all.map(r => r.account))], missingCosts: [...new Set(paid.flatMap(r => r.lines.filter(l => l.cost === null && l.sku).map(l => l.sku)))], unknownBuyerShipping: includeBuyer && paid.some(r => r.buyerShipping === null), historyStart: rows.length ? rows.map(r => r.date_created).sort()[0] : null };
}

export function priceBands(group, days) {
  const buckets = new Map();
  for (const line of group.lines) {
    const price = line.price;
    const bucket = buckets.get(price) || { price, qty: 0, mc: 0, incomplete: false, days: new Set() };
    bucket.qty += line.qty; bucket.mc += line.mc ?? 0; bucket.incomplete ||= line.mc === null;
    bucket.days.add(localDay(Date.parse(line.date))); buckets.set(price, bucket);
  }
  return [...buckets.values()].map(b => ({ price: b.price, qty: b.qty, mc: b.incomplete ? null : b.mc, activeDays: b.days.size, perActiveDay: b.incomplete ? null : b.mc / b.days.size, unitsPerPeriodDay: b.qty / days })).sort((a,b) => (a.price ?? 0) - (b.price ?? 0));
}

export function publicDashboard(data) {
  const t = data.totals;
  return { periodo: { de: data.range.di, ate: data.range.df, timezone: 'America/Sao_Paulo' }, cards: { vendas_aprovadas: t.count, valor_produto: reais(t.revenue), mc: reais(t.mc), mc_percentual: t.pct, custo: reais(t.cost), imposto: reais(t.tax), tarifas: reais(t.fee), frete: reais(t.shipping), frete_comprador: reais(t.buyerShipping), descontos: reais(t.discount), devolucoes: reais(t.refund), canceladas: data.cancelled, pendentes: data.pending, mc_incompleta: t.incomplete }, por_canal: data.byChannel.map(row=>({ ...row, receita:reais(row.revenue), mc:reais(row.mc) })), por_conta:data.byAccount.map(row=>({ ...row, receita:reais(row.revenue), mc:reais(row.mc) })), por_envio:data.byShipping.map(row=>({ ...row, receita:reais(row.revenue), mc:reais(row.mc) })), top_skus:data.topRevenue.map(row=>({ ...row, receita:reais(row.revenue), mc:reais(row.mc) })), vendas: data.rows.map(r => ({ order_id: r.id, date_created: r.date, data_precisao:r.datePrecision, canal: r.channel, conta: r.account, valor_produto: reais(r.revenue), mc: reais(r.mc), pendencias: r.reasons, skus: r.lines.map(l => l.sku), frete_auditoria:r.freightAudit || 'indisponível' })), pagina: data.page, paginas: data.pages, total: data.rowCount, ultima_sincronizacao: data.sync, conciliado: false };
}
