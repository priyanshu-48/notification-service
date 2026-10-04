import 'dotenv/config';
import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';
import { createNotificationQueue } from './queue.js';

const { db, pool } = createDatabase();
const { queue, connection } = createNotificationQueue();
const app = buildApp(db, queue);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  await pool.end();
  await queue.close();
  await connection.quit();
  process.exitCode = 1;
}

async function shutdown(signal: string) {
  app.log.info({ signal }, 'Shutting down API');
  await app.close();
  await queue.close();
  await connection.quit();
  await pool.end();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
