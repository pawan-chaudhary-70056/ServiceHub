-- docs/23 §4 / docs/09 §2: a resolved or closed incident MUST carry a resolution summary.
-- Enforced at the database, not only the API, because the invariant is a property of the
-- record's meaning: an incident that claims to be resolved with no explanation is not a
-- valid record regardless of which code path wrote it. Mirrors the audit append-only
-- trigger in being a rule the application cannot bypass.

ALTER TABLE "incidents"
  ADD CONSTRAINT "incidents_resolution_summary_required"
  CHECK (status NOT IN ('RESOLVED', 'CLOSED') OR resolution_summary IS NOT NULL);
