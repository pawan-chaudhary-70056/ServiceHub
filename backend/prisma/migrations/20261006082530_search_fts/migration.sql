-- Full-text search indexes (docs/30 §2.2, `ADR-0009`).
--
-- GIN expression indexes over `to_tsvector('english', <concatenated searchable text>)`.
-- Each expression MUST match the query expression exactly (same function, same
-- `coalesce` order, same configuration `'english'`) or the planner will not use it
-- (docs/09 §4).
--
-- The concatenation order is the same in the index and the query:
--   requests       reference, title, description
--   incidents      reference, title, description, resolution_summary
--   catalog items  name, description
--   users          display_name, email

CREATE INDEX "service_requests_search_idx" ON "service_requests"
  USING GIN (to_tsvector('english',
    coalesce("reference", '') || ' ' || coalesce("title", '') || ' ' || coalesce("description", '')));

CREATE INDEX "incidents_search_idx" ON "incidents"
  USING GIN (to_tsvector('english',
    coalesce("reference", '') || ' ' || coalesce("title", '') || ' ' ||
    coalesce("description", '') || ' ' || coalesce("resolution_summary", '')));

CREATE INDEX "catalog_items_search_idx" ON "catalog_items"
  USING GIN (to_tsvector('english',
    coalesce("name", '') || ' ' || coalesce("description", '')));

CREATE INDEX "users_search_idx" ON "users"
  USING GIN (to_tsvector('english',
    coalesce("display_name", '') || ' ' || coalesce("email", '')));
