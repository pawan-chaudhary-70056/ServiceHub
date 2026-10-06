-- CreateEnum
CREATE TYPE "ReportExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "report_exports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "format" TEXT NOT NULL DEFAULT 'CSV',
    "status" "ReportExportStatus" NOT NULL DEFAULT 'QUEUED',
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT,
    "error" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_exports_organization_id_status_idx" ON "report_exports"("organization_id", "status");

-- CreateIndex
CREATE INDEX "report_exports_requested_by_id_status_idx" ON "report_exports"("requested_by_id", "status");

-- CreateIndex
CREATE INDEX "report_exports_status_created_at_idx" ON "report_exports"("status", "created_at");

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
