import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createApp } from './app.js';

dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)), quiet: true });
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve ser um número entre 1 e 65535.');
const db = openDatabase(fileURLToPath(new URL('./dados.db', import.meta.url)));
const app = createApp({ db, config: process.env });
const server = app.listen(port, () => console.log(`Painel Mercado Livre disponível em http://localhost:${port}`));
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `A porta ${port} está ocupada. Altere PORT no .env.` : 'Não foi possível iniciar o servidor.');
  db.close();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
