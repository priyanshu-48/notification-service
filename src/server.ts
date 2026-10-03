import 'dotenv/config';
import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';

const { db, pool } = createDatabase();
const app = buildApp(db);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exitCode = 1;
}

async function shutdown(signal: string) {
  app.log.info({ signal }, 'Shutting down API');
  await app.close();
  await pool.end();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
