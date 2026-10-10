-- CreateEnum
CREATE TYPE "RosterSyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTED');

-- CreateTable
CREATE TABLE "directory_sync_states" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" "RosterSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "last_run_at" TIMESTAMPTZ(6),
    "last_checkpoint" TEXT,
    "users_seen" INTEGER NOT NULL DEFAULT 0,
    "users_adopted" INTEGER NOT NULL DEFAULT 0,
    "users_created" INTEGER NOT NULL DEFAULT 0,
    "users_updated" INTEGER NOT NULL DEFAULT 0,
    "users_deactivated" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "directory_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_user_mappings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "directory_user_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "directory_sync_states_organization_id_key" ON "directory_sync_states"("organization_id");

-- CreateIndex
CREATE INDEX "directory_user_mappings_organization_id_user_id_idx" ON "directory_user_mappings"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "directory_user_mappings_organization_id_external_id_key" ON "directory_user_mappings"("organization_id", "external_id");

-- AddForeignKey
ALTER TABLE "directory_sync_states" ADD CONSTRAINT "directory_sync_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_user_mappings" ADD CONSTRAINT "directory_user_mappings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_user_mappings" ADD CONSTRAINT "directory_user_mappings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
