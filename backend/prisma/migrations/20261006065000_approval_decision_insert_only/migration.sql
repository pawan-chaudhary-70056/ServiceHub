-- docs/26 §2 / rule A3: an approval decision is insert-only. A reversal is a new decision
-- with its own timestamp; the original is never rewritten. Enforced at the DATABASE, like
-- the audit trail (`docs/31` §3.3), so no careless query or future migration can alter a
-- decision — which is what makes an approval defensible.

CREATE OR REPLACE FUNCTION servicehub_reject_approval_decision_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'approval_decisions is insert-only (docs/26)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approval_decisions_insert_only
  BEFORE UPDATE OR DELETE ON "approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION servicehub_reject_approval_decision_mutation();
