CREATE TYPE "notification_status" AS ENUM ('queued', 'sending', 'delivered', 'failed');
CREATE TYPE "delivery_status" AS ENUM ('pending', 'sent', 'failed');
CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "key_hash" text NOT NULL UNIQUE, "created_at" timestamptz NOT NULL DEFAULT now(), "revoked_at" timestamptz
);
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys" ("tenant_id");
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "external_user_id" text NOT NULL, "email" text, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "users_tenant_external_id_idx" ON "users" ("tenant_id", "external_user_id");
CREATE TABLE "preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "channel" text NOT NULL, "type" text NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "quiet_hours" jsonb
);
CREATE UNIQUE INDEX "preferences_user_channel_type_idx" ON "preferences" ("user_id", "channel", "type");
CREATE TABLE "templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL, "subject" text, "body" text NOT NULL, "variables" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "templates_tenant_name_idx" ON "templates" ("tenant_id", "name");
CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE, "type" text NOT NULL, "payload" jsonb NOT NULL,
  "status" "notification_status" NOT NULL DEFAULT 'queued', "idempotency_key" text, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "notifications_tenant_idempotency_key_idx" ON "notifications" ("tenant_id", "idempotency_key");
CREATE INDEX "notifications_tenant_created_at_idx" ON "notifications" ("tenant_id", "created_at");
CREATE TABLE "delivery_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "notification_id" uuid NOT NULL REFERENCES "notifications"("id") ON DELETE CASCADE,
  "channel" text NOT NULL, "status" "delivery_status" NOT NULL DEFAULT 'pending', "error" text,
  "attempted_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "delivery_attempts_notification_id_idx" ON "delivery_attempts" ("notification_id");
