-- Asset full-text index (docs/30 §2.1, §2.2).
--
-- The register is a searchable source: the tag and serial number are exact-first
-- identifiers a caller looks up directly, and the name is the descriptive entry. The
-- expression MUST match the query vector exactly (same functions, same `coalesce` order,
-- same configuration) or the planner will not use it (docs/09 §4).

CREATE INDEX "assets_search_idx" ON "assets"
  USING GIN (to_tsvector('english',
    coalesce("tag", '') || ' ' || coalesce("serial_number", '') || ' ' || coalesce("name", '')));
