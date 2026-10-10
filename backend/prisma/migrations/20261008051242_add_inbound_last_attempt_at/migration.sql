-- AlterTable
ALTER TABLE "inbound_webhook_events" ADD COLUMN     "last_attempt_at" TIMESTAMPTZ(6);
