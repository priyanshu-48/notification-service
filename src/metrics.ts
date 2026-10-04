import type { FastifyInstance } from 'fastify';
import { count, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type * as schema from './db/schema.js';
import { notifications } from './db/schema.js';
import type { NotificationQueue } from './queue.js';

type Database = NodePgDatabase<typeof schema>;

// /ready: can this instance do useful work? (/health only says the process is up.) Used by deploy platforms to gate traffic.
// /metrics: Prometheus text format. Outcome counts come from Postgres and queue depth from Redis, so one scrape of the API
// describes the whole system even when the worker runs as a separate process.
export function registerOperations(app: FastifyInstance, db: Database, queue: NotificationQueue, metricsToken?: string): void {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const duration = new Histogram({
    name: 'http_request_duration_seconds', help: 'HTTP request latency', labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry],
  });
  app.addHook('onResponse', async (request, reply) => {
    // The route pattern, not the URL, keeps label cardinality bounded.
    duration.observe({ method: request.method, route: request.routeOptions.url ?? 'unmatched', status: reply.statusCode }, reply.elapsedTime / 1000);
  });

  new Gauge({
    name: 'notifications', help: 'Notifications by status (all tenants, from Postgres)', labelNames: ['status'] as const, registers: [registry],
    async collect() {
      const rows = await db.select({ status: notifications.status, n: count() }).from(notifications).groupBy(notifications.status);
      this.reset();
      for (const row of rows) this.set({ status: row.status }, row.n);
    },
  });
  new Gauge({
    name: 'notification_queue_jobs', help: 'BullMQ jobs by state', labelNames: ['state'] as const, registers: [registry],
    async collect() {
      this.reset();
      const counts = await queue.getJobCounts?.('waiting', 'active', 'delayed', 'failed') ?? {};
      for (const [state, n] of Object.entries(counts)) this.set({ state }, n);
    },
  });

  app.get('/ready', async (_request, reply) => {
    const checks = {
      postgres: await db.execute(sql`select 1`).then(() => true, () => false),
      redis: await Promise.resolve(queue.getJobCounts?.('waiting')).then(() => true, () => false),
    };
    return reply.code(checks.postgres && checks.redis ? 200 : 503).send({ status: checks.postgres && checks.redis ? 'ready' : 'degraded', checks });
  });

  app.get('/metrics', async (request, reply) => {
    if (metricsToken && request.headers.authorization !== `Bearer ${metricsToken}`) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Metrics token required.' } });
    return reply.type(registry.contentType).send(await registry.metrics());
  });
}
