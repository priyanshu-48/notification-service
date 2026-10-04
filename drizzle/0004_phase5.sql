ALTER TYPE "notification_status" ADD VALUE IF NOT EXISTS 'batched';
ALTER TYPE "notification_status" ADD VALUE IF NOT EXISTS 'suppressed';
ALTER TYPE "delivery_status" ADD VALUE IF NOT EXISTS 'skipped';
ALTER TABLE "notifications" ADD COLUMN "digest_key" text;
ALTER TABLE "notifications" ADD COLUMN "digest_parent_id" uuid REFERENCES "notifications"("id") ON DELETE SET NULL;
ALTER TABLE "notifications" ADD COLUMN "digest_count" integer DEFAULT 1 NOT NULL;
ALTER TABLE "notifications" ADD COLUMN "deliver_after" timestamp with time zone;
CREATE INDEX "notifications_digest_parent_idx" ON "notifications" USING btree ("digest_parent_id");
CREATE INDEX "notifications_digest_siblings_idx" ON "notifications" USING btree ("tenant_id","user_id","digest_key");
