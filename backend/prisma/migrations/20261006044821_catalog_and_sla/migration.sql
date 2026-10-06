-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "CatalogItemStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "CatalogFieldType" AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'DATETIME', 'SELECT', 'MULTI_SELECT', 'BOOLEAN', 'FILE', 'USER');

-- CreateEnum
CREATE TYPE "SlaCalendarModel" AS ENUM ('WORKING_HOURS', 'WALL_CLOCK');

-- CreateEnum
CREATE TYPE "SlaClockState" AS ENUM ('ON_TRACK', 'AT_RISK', 'BREACHED', 'PAUSED', 'STOPPED');

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_items" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "default_priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "default_sla_policy_id" TEXT,
    "fulfilment_team_id" TEXT,
    "status" "CatalogItemStatus" NOT NULL DEFAULT 'DRAFT',
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_item_fields" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "field_type" "CatalogFieldType" NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB,
    "validation" JSONB,
    "help_text" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_item_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_calendars" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "time_zone" TEXT NOT NULL,
    "model" "SlaCalendarModel" NOT NULL DEFAULT 'WORKING_HOURS',
    "working_hours" JSONB NOT NULL,
    "holidays" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "calendar_id" TEXT NOT NULL,
    "pause_states" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_targets" (
    "id" TEXT NOT NULL,
    "sla_policy_id" TEXT NOT NULL,
    "priority" "Priority" NOT NULL,
    "response_minutes" INTEGER NOT NULL,
    "resolve_minutes" INTEGER NOT NULL,
    "warn_percent" INTEGER NOT NULL DEFAULT 75,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sla_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_clocks" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "sla_policy_id" TEXT NOT NULL,
    "priority" "Priority" NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "paused_at" TIMESTAMPTZ(6),
    "total_paused_seconds" INTEGER NOT NULL DEFAULT 0,
    "target_at" TIMESTAMPTZ(6) NOT NULL,
    "warn_at" TIMESTAMPTZ(6) NOT NULL,
    "breached_at" TIMESTAMPTZ(6),
    "stopped_at" TIMESTAMPTZ(6),
    "state" "SlaClockState" NOT NULL DEFAULT 'ON_TRACK',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sla_clocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "categories_organization_id_parent_id_idx" ON "categories"("organization_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_organization_id_parent_id_name_key" ON "categories"("organization_id", "parent_id", "name");

-- CreateIndex
CREATE INDEX "catalog_items_organization_id_status_idx" ON "catalog_items"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_organization_id_category_id_name_key" ON "catalog_items"("organization_id", "category_id", "name");

-- CreateIndex
CREATE INDEX "catalog_item_fields_catalog_item_id_display_order_idx" ON "catalog_item_fields"("catalog_item_id", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_fields_catalog_item_id_key_key" ON "catalog_item_fields"("catalog_item_id", "key");

-- CreateIndex
CREATE INDEX "business_calendars_organization_id_idx" ON "business_calendars"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_calendars_organization_id_name_version_key" ON "business_calendars"("organization_id", "name", "version");

-- CreateIndex
CREATE INDEX "sla_policies_organization_id_is_active_idx" ON "sla_policies"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_organization_id_name_key" ON "sla_policies"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sla_targets_sla_policy_id_priority_key" ON "sla_targets"("sla_policy_id", "priority");

-- CreateIndex
CREATE INDEX "sla_clocks_organization_id_entity_type_entity_id_idx" ON "sla_clocks"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "sla_clocks_state_target_at_idx" ON "sla_clocks"("state", "target_at");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_default_sla_policy_id_fkey" FOREIGN KEY ("default_sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_fulfilment_team_id_fkey" FOREIGN KEY ("fulfilment_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_fields" ADD CONSTRAINT "catalog_item_fields_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_calendars" ADD CONSTRAINT "business_calendars_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "business_calendars"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_targets" ADD CONSTRAINT "sla_targets_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
