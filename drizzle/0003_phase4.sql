ALTER TABLE "notifications" ADD COLUMN "request_hash" text;
ALTER TABLE "notifications" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "notifications" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX "notifications_status_updated_at_idx" ON "notifications" USING btree ("status","updated_at");
