-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('ANY', 'ALL');

-- CreateEnum
CREATE TYPE "ApprovalStepStatus" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalWorkflowStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalDecisionOutcome" AS ENUM ('APPROVE', 'REJECT');

-- CreateTable
CREATE TABLE "approval_templates" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "approval_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_template_steps" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "mode" "ApprovalMode" NOT NULL,
    "approver_role_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_template_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_workflows" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "status" "ApprovalWorkflowStatus" NOT NULL DEFAULT 'PENDING',
    "current_step_order" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "approval_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "mode" "ApprovalMode" NOT NULL,
    "status" "ApprovalStepStatus" NOT NULL DEFAULT 'PENDING',
    "deadline_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_step_approvers" (
    "id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "approver_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_step_approvers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_decisions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "approver_id" TEXT NOT NULL,
    "outcome" "ApprovalDecisionOutcome" NOT NULL,
    "comment" TEXT,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_templates_catalog_item_id_key" ON "approval_templates"("catalog_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_template_steps_template_id_step_order_key" ON "approval_template_steps"("template_id", "step_order");

-- CreateIndex
CREATE UNIQUE INDEX "approval_workflows_request_id_key" ON "approval_workflows"("request_id");

-- CreateIndex
CREATE INDEX "approval_workflows_organization_id_status_idx" ON "approval_workflows"("organization_id", "status");

-- CreateIndex
CREATE INDEX "approval_steps_status_deadline_at_idx" ON "approval_steps"("status", "deadline_at");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_workflow_id_step_order_key" ON "approval_steps"("workflow_id", "step_order");

-- CreateIndex
CREATE UNIQUE INDEX "approval_step_approvers_step_id_approver_id_key" ON "approval_step_approvers"("step_id", "approver_id");

-- CreateIndex
CREATE INDEX "approval_decisions_organization_id_workflow_id_decided_at_idx" ON "approval_decisions"("organization_id", "workflow_id", "decided_at");

-- CreateIndex
CREATE INDEX "approval_decisions_step_id_approver_id_idx" ON "approval_decisions"("step_id", "approver_id");

-- AddForeignKey
ALTER TABLE "approval_templates" ADD CONSTRAINT "approval_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_templates" ADD CONSTRAINT "approval_templates_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_template_steps" ADD CONSTRAINT "approval_template_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "approval_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_workflows" ADD CONSTRAINT "approval_workflows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_workflows" ADD CONSTRAINT "approval_workflows_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "approval_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step_approvers" ADD CONSTRAINT "approval_step_approvers_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "approval_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step_approvers" ADD CONSTRAINT "approval_step_approvers_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "approval_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "approval_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
