-- CreateEnum
CREATE TYPE "InboundWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "inbound_webhook_endpoints" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "organization_id" TEXT,
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbound_webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_webhook_events" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT,
    "raw_payload" JSONB,
    "status" "InboundWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbound_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_webhook_endpoints_key_key" ON "inbound_webhook_endpoints"("key");

-- CreateIndex
CREATE INDEX "inbound_webhook_endpoints_organization_id_enabled_idx" ON "inbound_webhook_endpoints"("organization_id", "enabled");

-- CreateIndex
CREATE INDEX "inbound_webhook_events_status_next_attempt_at_idx" ON "inbound_webhook_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "inbound_webhook_events_organization_id_status_received_at_idx" ON "inbound_webhook_events"("organization_id", "status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_webhook_events_endpoint_id_provider_event_id_key" ON "inbound_webhook_events"("endpoint_id", "provider_event_id");

-- AddForeignKey
ALTER TABLE "inbound_webhook_endpoints" ADD CONSTRAINT "inbound_webhook_endpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_webhook_endpoints" ADD CONSTRAINT "inbound_webhook_endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_webhook_events" ADD CONSTRAINT "inbound_webhook_events_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "inbound_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_webhook_events" ADD CONSTRAINT "inbound_webhook_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
