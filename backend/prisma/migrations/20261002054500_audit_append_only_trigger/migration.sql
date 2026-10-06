-- docs/31 §3.3: immutability is enforced at the DATABASE, not the application.
-- Consequence: a future careless migration or query cannot rewrite the trail.
-- The application also grants no UPDATE/DELETE on this table (docs/17, docs/31).

CREATE OR REPLACE FUNCTION servicehub_reject_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (docs/31)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION servicehub_reject_audit_mutation();
