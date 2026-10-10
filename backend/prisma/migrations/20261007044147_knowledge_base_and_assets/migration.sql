-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ArticleVisibility" AS ENUM ('PUBLIC', 'INTERNAL', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "AssetState" AS ENUM ('PROCURED', 'IN_STOCK', 'ASSIGNED', 'IN_REPAIR', 'RETIRED', 'DISPOSED');

-- CreateEnum
CREATE TYPE "AssetHolderType" AS ENUM ('USER', 'TEAM');

-- CreateTable
CREATE TABLE "article_categories" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "article_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "articles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "category_id" TEXT,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "status" "ArticleStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "ArticleVisibility" NOT NULL DEFAULT 'INTERNAL',
    "author_id" TEXT NOT NULL,
    "reviewer_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "published_at" TIMESTAMPTZ(6),
    "reviewed_at" TIMESTAMPTZ(6),
    "review_due_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "not_helpful_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_versions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "article_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "visibility" "ArticleVisibility" NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "published_by_id" TEXT NOT NULL,

    CONSTRAINT "article_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_slug_redirects" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "article_id" TEXT NOT NULL,
    "from_slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_slug_redirects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_links" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "article_id" TEXT NOT NULL,
    "article_version" INTEGER NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "linked_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_types" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "attribute_schema" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "asset_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "asset_type_id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "serial_number" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "state" "AssetState" NOT NULL DEFAULT 'PROCURED',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "assigned_to_user_id" TEXT,
    "assigned_to_team_id" TEXT,
    "purchase_date" DATE,
    "warranty_expires_at" DATE,
    "retired_at" TIMESTAMPTZ(6),
    "disposed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_assignments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "holder_type" "AssetHolderType" NOT NULL,
    "user_id" TEXT,
    "team_id" TEXT,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL,
    "returned_at" TIMESTAMPTZ(6),
    "assigned_by_id" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "asset_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "article_categories_organization_id_parent_id_idx" ON "article_categories"("organization_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "article_categories_organization_id_parent_id_name_key" ON "article_categories"("organization_id", "parent_id", "name");

-- CreateIndex
CREATE INDEX "articles_organization_id_status_updated_at_idx" ON "articles"("organization_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "articles_organization_id_visibility_status_idx" ON "articles"("organization_id", "visibility", "status");

-- CreateIndex
CREATE INDEX "articles_organization_id_category_id_idx" ON "articles"("organization_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "articles_organization_id_slug_key" ON "articles"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "article_versions_article_id_version_key" ON "article_versions"("article_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "article_slug_redirects_organization_id_from_slug_key" ON "article_slug_redirects"("organization_id", "from_slug");

-- CreateIndex
CREATE INDEX "knowledge_links_organization_id_entity_type_entity_id_idx" ON "knowledge_links"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_links_organization_id_article_id_entity_type_enti_key" ON "knowledge_links"("organization_id", "article_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "asset_types_organization_id_idx" ON "asset_types"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_types_organization_id_key_key" ON "asset_types"("organization_id", "key");

-- CreateIndex
CREATE INDEX "assets_organization_id_state_created_at_idx" ON "assets"("organization_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "assets_organization_id_asset_type_id_idx" ON "assets"("organization_id", "asset_type_id");

-- CreateIndex
CREATE INDEX "assets_organization_id_assigned_to_user_id_idx" ON "assets"("organization_id", "assigned_to_user_id");

-- CreateIndex
CREATE INDEX "assets_organization_id_assigned_to_team_id_idx" ON "assets"("organization_id", "assigned_to_team_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_organization_id_tag_key" ON "assets"("organization_id", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "assets_organization_id_serial_number_key" ON "assets"("organization_id", "serial_number");

-- CreateIndex
CREATE INDEX "asset_assignments_organization_id_asset_id_assigned_at_idx" ON "asset_assignments"("organization_id", "asset_id", "assigned_at");

-- CreateIndex
CREATE INDEX "asset_assignments_organization_id_user_id_idx" ON "asset_assignments"("organization_id", "user_id");

-- AddForeignKey
ALTER TABLE "article_categories" ADD CONSTRAINT "article_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_categories" ADD CONSTRAINT "article_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "article_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "article_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_slug_redirects" ADD CONSTRAINT "article_slug_redirects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_slug_redirects" ADD CONSTRAINT "article_slug_redirects_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_linked_by_id_fkey" FOREIGN KEY ("linked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_asset_type_id_fkey" FOREIGN KEY ("asset_type_id") REFERENCES "asset_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_assigned_to_team_id_fkey" FOREIGN KEY ("assigned_to_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity and search indexes that Prisma's schema language cannot express
-- (docs/09 §2/§4, docs/27 §10, docs/28 §3).
-- ---------------------------------------------------------------------------

-- Exactly one open assignment per asset (docs/28 rule AM1). A partial unique index is
-- the only mechanism that makes "who holds it" answerable under concurrency: two open
-- assignments on one asset is the defect this prevents.
CREATE UNIQUE INDEX "asset_assignments_one_open_per_asset"
  ON "asset_assignments" ("asset_id")
  WHERE "returned_at" IS NULL;

-- An assignment names exactly one holder, and the holder column must agree with the
-- declared type (docs/09 §2 constraint style).
ALTER TABLE "asset_assignments"
  ADD CONSTRAINT "asset_assignments_holder_exactly_one"
  CHECK (
    ("holder_type" = 'USER' AND "user_id" IS NOT NULL AND "team_id" IS NULL) OR
    ("holder_type" = 'TEAM' AND "team_id" IS NOT NULL AND "user_id" IS NULL)
  );

-- Article full-text index (docs/27 §10, docs/30 §2.2). `title` and `summary` are
-- weighted above `body`; the expression MUST match the query vector exactly (same
-- functions, same `coalesce` order, same configuration) or the planner will not use it
-- (docs/09 §4).
CREATE INDEX "articles_search_idx" ON "articles"
  USING GIN ((
    setweight(to_tsvector('english', coalesce("title", '') || ' ' || coalesce("summary", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("body", '')), 'B')
  ));
