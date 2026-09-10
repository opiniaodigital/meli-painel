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
    close: () => db.close(),
  };
}
