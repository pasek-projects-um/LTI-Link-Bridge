CREATE INDEX IF NOT EXISTS idx_retention_launches ON launches(event_time,id);
CREATE INDEX IF NOT EXISTS idx_retention_identities ON identities(last_seen,user_id);
CREATE INDEX IF NOT EXISTS idx_retention_audit ON audit_events(time,id);
