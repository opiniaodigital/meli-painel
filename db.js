import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
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
  `);
  return {
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
