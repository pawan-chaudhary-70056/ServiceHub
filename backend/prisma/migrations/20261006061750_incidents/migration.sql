-- CreateEnum
CREATE TYPE "IncidentImpact" AS ENUM ('EXTENSIVE', 'SIGNIFICANT', 'MINOR');

-- CreateEnum
CREATE TYPE "IncidentUrgency" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "incidents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "impact" "IncidentImpact" NOT NULL,
    "urgency" "IncidentUrgency" NOT NULL,
    "priority" "Priority" NOT NULL,
    "is_major" BOOLEAN NOT NULL DEFAULT false,
    "status" "IncidentStatus" NOT NULL DEFAULT 'NEW',
    "reporter_id" TEXT NOT NULL,
    "assignee_id" TEXT,
    "team_id" TEXT,
    "resolution_summary" TEXT,
    "sla_policy_id" TEXT NOT NULL,
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incidents_organization_id_status_created_at_idx" ON "incidents"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "incidents_organization_id_reporter_id_created_at_idx" ON "incidents"("organization_id", "reporter_id", "created_at");

-- CreateIndex
CREATE INDEX "incidents_organization_id_assignee_id_status_idx" ON "incidents"("organization_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "incidents_organization_id_is_major_idx" ON "incidents"("organization_id", "is_major");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_organization_id_reference_key" ON "incidents"("organization_id", "reference");

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
