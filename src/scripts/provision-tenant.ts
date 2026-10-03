import 'dotenv/config';
import { createDatabase } from '../db/client.js';
import { tenants, apiKeys } from '../db/schema.js';
import { generateApiKey, hashApiKey } from '../auth/key.js';

const name = process.argv.slice(2).join(' ').trim();
if (!name) {
  console.error('Usage: npm run provision:tenant -- "Tenant name"');
  process.exitCode = 1;
} else {
  const { db, pool } = createDatabase();
  try {
    const apiKey = generateApiKey();
    const result = await db.transaction(async (tx) => {
      const [tenant] = await tx.insert(tenants).values({ name }).returning({ id: tenants.id, name: tenants.name });
      await tx.insert(apiKeys).values({ tenantId: tenant!.id, keyHash: hashApiKey(apiKey) });
      return tenant!;
    });
    console.info(`Tenant created: ${result.name} (${result.id})`);
    console.info('Copy this API key now; it cannot be recovered:');
    console.info(apiKey);
  } finally {
    await pool.end();
  }
}
