-- docs/24 §3 / docs/09 §2: a BLOCKED task MUST record why. A blocked status with no
-- reason is worse than no status at all — it signals a problem and conveys nothing
-- actionable. Enforced at the database so no code path can produce a mute block.

ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_blocked_reason_required"
  CHECK (status <> 'BLOCKED' OR blocked_reason IS NOT NULL);
