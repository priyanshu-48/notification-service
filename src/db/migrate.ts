import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.js';

const { db, pool } = createDatabase();
try {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.info('Database migrations applied.');
} finally {
  await pool.end();
}
