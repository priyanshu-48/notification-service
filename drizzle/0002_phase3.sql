ALTER TABLE "notifications" ADD COLUMN "channels" jsonb DEFAULT '["email"]'::jsonb NOT NULL;
ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;
CREATE INDEX "notifications_user_created_at_idx" ON "notifications" USING btree ("user_id","created_at");
