import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 30000;
    CREATE TABLE IF NOT EXISTS vendedores (
      user_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessoes (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      state TEXT,
      verifier TEXT,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custos_sku (
      sku TEXT PRIMARY KEY,
      custo_unitario REAL NOT NULL CHECK (custo_unitario >= 0),
      imposto_percentual REAL NOT NULL DEFAULT 0 CHECK (imposto_percentual >= 0),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS margens_pedido (
      user_id TEXT NOT NULL, order_id TEXT NOT NULL, date_created TEXT NOT NULL,
      buyer_nickname TEXT, items_json TEXT NOT NULL, bruto REAL NOT NULL, tarifas REAL NOT NULL,
      frete REAL NOT NULL, frete_desconto REAL NOT NULL, descontos REAL NOT NULL, status TEXT NOT NULL,
      envio_status TEXT, envio_tipo TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, order_id)
    );
    CREATE TABLE IF NOT EXISTS devolucoes (
      user_id TEXT NOT NULL, claim_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, claim_id)
    );
    CREATE TABLE IF NOT EXISTS pedidos (
      user_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      date_created TEXT NOT NULL,
      buyer_nickname TEXT,
      items_json TEXT NOT NULL,
      total_amount REAL NOT NULL,
      currency_id TEXT,
      order_status TEXT NOT NULL,
      shipping_status TEXT,
      shipping_type TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, order_id)
    );
    CREATE INDEX IF NOT EXISTS pedidos_user_date ON pedidos(user_id, date_created DESC);
    CREATE TABLE IF NOT EXISTS mc_metadata (
      user_id TEXT NOT NULL, order_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY (user_id, order_id)
    );
    CREATE TABLE IF NOT EXISTS mc_sync (
      user_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bling_connections (user_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bling_states (state TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bling_cache (user_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bling_settings (user_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
  `);
  return {
    getBlingToken: userId => db.prepare('SELECT * FROM bling_connections WHERE user_id = ?').get(String(userId)),
    saveBlingToken(userId, token) {
      db.prepare('INSERT INTO bling_connections VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at').run(String(userId),token.access_token,token.refresh_token,token.expires_at);
    },
    saveBlingState(state, sessionId, userId, expires) {
      db.prepare('DELETE FROM bling_states WHERE expires_at <= ? OR session_id = ?').run(Date.now(),sessionId);
      db.prepare('INSERT INTO bling_states VALUES (?,?,?,?)').run(state,sessionId,String(userId),expires);
    },
    takeBlingState: (state, sessionId) => db.prepare('DELETE FROM bling_states WHERE state = ? AND session_id = ? AND expires_at > ? RETURNING user_id').get(state,sessionId,Date.now()),
    getBlingCache: userId => { const row = db.prepare('SELECT * FROM bling_cache WHERE user_id = ?').get(String(userId)); return row ? {...JSON.parse(row.payload_json), updated_at:row.updated_at} : null; },
    saveBlingCache: (userId, value) => db.prepare('INSERT INTO bling_cache VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at').run(String(userId),JSON.stringify(value),Date.now()),
    getBlingSettings: userId => JSON.parse(db.prepare('SELECT payload_json FROM bling_settings WHERE user_id = ?').get(String(userId))?.payload_json || '{}'),
    saveBlingSettings: (userId, value) => db.prepare('INSERT INTO bling_settings VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET payload_json=excluded.payload_json').run(String(userId),JSON.stringify(value)),
    getSeller: id => db.prepare('SELECT * FROM vendedores WHERE user_id = ?').get(String(id)),
    saveToken(token) {
      db.prepare(`INSERT INTO vendedores VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token,
        refresh_token=excluded.refresh_token, expires_at=excluded.expires_at`)
        .run(String(token.user_id), token.access_token, token.refresh_token, token.expires_at);
    },
    getSession: id => db.prepare('SELECT * FROM sessoes WHERE id = ? AND expires_at > ?').get(id, Date.now()),
    saveSession(id, { user_id = null, state = null, verifier = null, expires_at }) {
      db.prepare('DELETE FROM sessoes WHERE expires_at <= ?').run(Date.now());
      db.prepare('INSERT INTO sessoes VALUES (?, ?, ?, ?, ?)').run(id, user_id, state, verifier, expires_at);
    },
    deleteSession: id => db.prepare('DELETE FROM sessoes WHERE id = ?').run(id),
    listCustos: () => db.prepare('SELECT sku, custo_unitario, imposto_percentual FROM custos_sku ORDER BY sku').all(),
    upsertCusto: (sku, custo, imposto) => db.prepare(`INSERT INTO custos_sku (sku,custo_unitario,imposto_percentual,updated_at) VALUES (?,?,?,?) ON CONFLICT(sku) DO UPDATE SET custo_unitario=excluded.custo_unitario, imposto_percentual=excluded.imposto_percentual, updated_at=excluded.updated_at`).run(sku, custo, imposto, Date.now()),
    deleteCusto: sku => db.prepare('DELETE FROM custos_sku WHERE sku = ?').run(sku),
    getMargemSyncAt: userId => db.prepare('SELECT updated_at FROM mc_sync WHERE user_id = ?').get(String(userId))?.updated_at ?? db.prepare('SELECT MAX(updated_at) AS updated_at FROM margens_pedido WHERE user_id = ?').get(String(userId))?.updated_at ?? null,
    replaceMargens(userId, rows) {
      const id = String(userId); const updated = Date.now(); db.exec('BEGIN IMMEDIATE');
      try {
        const save = db.prepare(`INSERT INTO margens_pedido (user_id,order_id,date_created,buyer_nickname,items_json,bruto,tarifas,frete,frete_desconto,descontos,status,envio_status,envio_tipo,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,order_id) DO UPDATE SET date_created=excluded.date_created,buyer_nickname=excluded.buyer_nickname,items_json=excluded.items_json,bruto=excluded.bruto,tarifas=excluded.tarifas,frete=excluded.frete,frete_desconto=excluded.frete_desconto,descontos=excluded.descontos,status=excluded.status,envio_status=excluded.envio_status,envio_tipo=excluded.envio_tipo,updated_at=excluded.updated_at`);
        for (const row of rows) save.run(id,row.order_id,row.date_created,row.buyer_nickname,JSON.stringify(row.items),row.bruto,row.tarifas,row.frete,row.frete_desconto,row.descontos,row.status,row.envio_status,row.envio_tipo,updated);
        const metadata = db.prepare('INSERT INTO mc_metadata VALUES (?,?,?) ON CONFLICT(user_id,order_id) DO UPDATE SET payload_json=excluded.payload_json');
        for (const row of rows) metadata.run(id, row.order_id, JSON.stringify(row.mc_meta || {}));
        db.prepare('INSERT INTO mc_sync VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET updated_at=excluded.updated_at').run(id, updated);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    listMargens: (userId, { from, to, status } = {}) => {
      let sql = 'SELECT * FROM margens_pedido WHERE user_id = ?'; const args = [String(userId)];
      if (from) { sql += ' AND date_created >= ?'; args.push(from); } if (to) { sql += ' AND date_created <= ?'; args.push(to); } if (status) { sql += ' AND status = ?'; args.push(status); }
      const metadata = new Map(db.prepare('SELECT order_id,payload_json FROM mc_metadata WHERE user_id = ?').all(String(userId)).map(r => [r.order_id, JSON.parse(r.payload_json)]));
      return db.prepare(sql + ' ORDER BY date_created DESC, order_id DESC').all(...args).map(row => ({ ...row, items: JSON.parse(row.items_json), mc_meta: metadata.get(row.order_id) || {} }));
    },
    getDevolucoesSyncAt: userId => db.prepare('SELECT MAX(updated_at) AS updated_at FROM devolucoes WHERE user_id = ?').get(String(userId))?.updated_at ?? null,
    replaceDevolucoes(userId, rows) {
      const id = String(userId); const updated = Date.now(); db.exec('BEGIN IMMEDIATE');
      try {
        const save = db.prepare('INSERT INTO devolucoes (user_id,claim_id,payload_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,claim_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at');
        for (const row of rows) save.run(id, row.claim_id, JSON.stringify(row), updated);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    listDevolucoes: (userId, { from, to, status } = {}) => {
      let sql = 'SELECT payload_json FROM devolucoes WHERE user_id = ?'; const args = [String(userId)];
      const rows = db.prepare(sql).all(...args).map(row => JSON.parse(row.payload_json));
      return rows.filter(row => (!from || row.date_opened >= from) && (!to || row.date_opened <= to) && (!status || row.status === status)).sort((a, b) => String(b.date_opened).localeCompare(String(a.date_opened)));
    },
    getPedidosSyncAt: userId => db.prepare('SELECT MAX(updated_at) AS updated_at FROM pedidos WHERE user_id = ?').get(String(userId))?.updated_at ?? null,
    replacePedidos(userId, orders) {
      const id = String(userId); const updated = Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        const save = db.prepare(`INSERT INTO pedidos
          (user_id, order_id, date_created, buyer_nickname, items_json, total_amount, currency_id, order_status, shipping_status, shipping_type, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, order_id) DO UPDATE SET date_created=excluded.date_created,
          buyer_nickname=excluded.buyer_nickname, items_json=excluded.items_json, total_amount=excluded.total_amount,
          currency_id=excluded.currency_id, order_status=excluded.order_status, shipping_status=excluded.shipping_status,
          shipping_type=excluded.shipping_type, updated_at=excluded.updated_at`);
        for (const order of orders) save.run(id, order.order_id, order.date_created, order.buyer_nickname,
          JSON.stringify(order.items), order.total_amount, order.currency_id, order.order_status,
          order.shipping_status, order.shipping_type, updated);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    listPedidos(userId, { from, to, status } = {}) {
      let sql = 'SELECT * FROM pedidos WHERE user_id = ?'; const args = [String(userId)];
      if (from) { sql += ' AND date_created >= ?'; args.push(from); }
      if (to) { sql += ' AND date_created <= ?'; args.push(to); }
      if (status) { sql += ' AND order_status = ?'; args.push(status); }
      sql += ' ORDER BY date_created DESC, order_id DESC';
      return db.prepare(sql).all(...args).map(row => ({ ...row, items: JSON.parse(row.items_json) }));
    },
    close: () => db.close(),
  };
}
